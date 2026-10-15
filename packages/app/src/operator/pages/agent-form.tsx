import { useBeforeLeave, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, type JSX, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { useOperatorProjects, useScopedProject } from "../project"
import { ColorField } from "../ui/color-field"
import { useConfirm } from "../ui/confirm"
import { useFolderBrowser } from "../ui/folder-browser"
import { SelectV2 } from "../ui/select"
import { EmptyState } from "../ui/empty-state"
import { Field } from "../ui/field"
import { PageHeader } from "../ui/page-header"
import { LevelEditor } from "../ui/level-editor"
import { PermissionImpact } from "../ui/permission-impact"
import { orderCheck, type Rule, rulesFromConfig, rulesToConfig } from "../ui/rules"
import { useAgentPermissions, useRefreshAgent } from "./agent-permissions"
import { AgentModelFields } from "./agent-model-fields"
import { useAgents } from "./agents"
import { agentPatch, type AgentForm, formFromSettings } from "./agent-form-state"
import {
  type Check,
  checkSteps,
  checkTemperature,
  checkTopP,
  homeFolder,
  homeOf,
  isAnthropic,
} from "./agent-form-checks"
import type { Flavor, Mode } from "./agent-type"
import { HelperForm } from "./helper-form"
import { requestError } from "./config-helpers"
import { AgentFormPrompt, DEFAULT_PROFILE, type PromptChoice } from "./agent-form-prompt"
import { forSave } from "./agent-form-text"
import { useAgentPromptSetting } from "./agent-prompt"
import { useNamespaces } from "./profile-data"
import { OPENCODE } from "./profile-model"
import { useProjectSettings } from "./project-prompt"
import { useAgentLocks } from "../ui/permission-locks"
import { useProjectConfigWrite } from "../ui/project-config-copy"

// The user kept the namespace's config: nothing was written.
const CANCELLED = Symbol("cancelled")

// Where a new agent is saved (agent_form_spec.md §1; capability_scopes_spec.md §11; global_and_opencode_namespaces_spec
// §3): its namespace's default project, another project of it, the whole namespace (its folder's `.opencode`), or,
// for the Global namespace, Global (every namespace that inherits it).
type SaveIn = "default" | "project" | "namespace"

// Create a new agent (an agent file or a config entry) or edit an existing one.
export default function AgentFormPage() {
  const language = useLanguage()
  const params = useParams<{ name?: string }>()
  // Create agent… on a profile: the new agent uses that profile.
  const [search, setSearch] = useSearchParams<{ profile?: string }>()
  const settings = useProjectSettings()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const write = useProjectConfigWrite()
  const queryClient = useQueryClient()
  const directory = useScopedProject()
  const agents = useAgents()
  const editing = () => params.name !== undefined
  const confirm = useConfirm()
  const namespaces = useNamespaces()
  const projects = useOperatorProjects()
  // The namespace: the one chosen here, else the project in context's, else OpenCode.
  const [chosen, setChosen] = createStore({ namespace: "", saveIn: "default" as SaveIn, project: "" })
  const contextNamespace = () => settings.data?.find((item) => item.key === directory())?.namespace ?? OPENCODE
  const namespace = () => chosen.namespace || contextNamespace()
  const summary = () => ready(namespaces)?.find((item) => item.namespace.id === namespace())
  const isGlobal = () => !!summary()?.global
  const namespaceProjects = () => projects().filter((item) => item.namespace === namespace())
  const defaultProject = () => summary()?.defaultProject ?? namespaceProjects()[0]?.directory
  const projectLabel = (key: string | undefined) =>
    projects().find((item) => item.directory === key)?.label ?? key?.split("/").filter(Boolean).at(-1) ?? ""
  const existing = createMemo(() => agents.data?.find((agent) => agent.name === decodeURIComponent(params.name ?? "")))
  // Its prompt (§6): the profile it uses and its override, saved with the form. A new agent from "Create agent…" on
  // a profile starts on that profile; one being edited on its saved setting.
  const promptSetting = useAgentPromptSetting(
    () => existing()?.name ?? "",
    () => (existing() ? directory() : undefined),
  )
  const [prompt, setPrompt] = createStore<PromptChoice>({
    profile: search.profile ?? DEFAULT_PROFILE,
    override: null,
  })
  createEffect(
    on(
      () => ready(promptSetting)?.setting,
      (setting) => {
        if (!setting) return
        setPrompt({ profile: setting.profile ?? DEFAULT_PROFILE, override: setting.override ?? null })
      },
    ),
  )
  // The override a save sends: a text of the agent's own emptied while editing is that block removed.
  const savedOverride = () => {
    const override = prompt.override ? forSave(prompt.override) : null
    return override && Object.keys(override).length ? override : null
  }
  const promptChanged = () => {
    const saved = ready(promptSetting)?.setting
    const profile = prompt.profile === DEFAULT_PROFILE ? undefined : prompt.profile
    const override = savedOverride()
    return (
      (saved?.profile ?? undefined) !== profile ||
      JSON.stringify(saved?.override ?? null) !== JSON.stringify(profile ? override : null)
    )
  }
  // The full list the agent's own rules sit in (a new agent: build's, for the hints and the picker).
  const permissions = useAgentPermissions(() => existing()?.name ?? "build", directory)
  const savedRules = () => JSON.stringify(rulesFromConfig(existing()?.settings.permission))
  const refresh = useRefreshAgent()
  const [store, setStore] = createStore({
    format: "file" as "file" | "config",
    form: formFromSettings("", {}),
    rules: [] as Rule[],
    // A subagent's locks: its own, or its own and its parent session's agent's (fixes_spec §4.2).
    inherit: undefined as "own" | "parent" | undefined,
    error: "",
    saving: false,
  })
  const locks = useAgentLocks(
    () => existing()?.name ?? "",
    () => directory() ?? "",
  )
  const inherit = () => store.inherit ?? locks.current().inherit
  const subagent = () => store.form.mode === "subagent" || store.form.mode === "all"

  // Fill the form from the agent's own settings once they load.
  createEffect(
    on(existing, (agent) => {
      if (!agent) return
      const form = formFromSettings(agent.name, agent.settings)
      setStore({
        form: { ...form, home: homeText(form.home) },
        rules: rulesFromConfig(agent.settings.permission),
      })
    }),
  )

  // Where it's written: the scope, and a folder of that namespace or project to write it from. An agent being edited
  // stays where it is defined (its level); built-in agents' settings are this project's.
  const scope = (): "global" | "namespace" | "project" => {
    if (editing()) {
      const level = existing()?.level.kind
      return level === "global" ? "global" : level === "namespace" ? "namespace" : "project"
    }
    if (isGlobal()) return "global"
    return chosen.saveIn === "namespace" ? "namespace" : "project"
  }
  const targetDirectory = () => {
    if (editing()) return directory()
    if (isGlobal()) return directory() ?? defaultProject()
    if (chosen.saveIn === "project") return chosen.project || undefined
    if (chosen.saveIn === "namespace") return defaultProject() ?? summary()?.namespace.folder
    return defaultProject()
  }
  // The config file and the agents folder at each scope, to say where the agent is saved.
  const layers = useQuery(() => ({
    queryKey: api.key("config-layers", targetDirectory()),
    enabled: !!targetDirectory(),
    queryFn: () =>
      api
        .client()
        .operator.config.layers({ directory: targetDirectory() })
        .then((result) => result.data),
  }))
  const target = () => {
    const name = (editing() ? existing()?.name : store.form.name.trim()) || "<name>"
    if (existing()?.source.kind === "file") return existing()?.source.path
    const found = layers.data
    if (!found) return undefined
    if (!editing() && store.format === "file") return `${found.folders[scope()]}/agents/${name}.md`
    return language.t("operator.agentForm.configEntry", { file: found.targets[scope()] ?? "", name })
  }
  // Where the agent is saved, in words (for the model's "copied in" note).
  const where = () =>
    scope() === "global"
      ? language.t("operator.modelChain.settingsName")
      : scope() === "namespace"
        ? (summary()?.namespace.name ?? namespace())
        : projectLabel(targetDirectory())

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setStore("form", key, value)
  // A new agent works in agents/<name> of its project (its memory is kept there) unless its home is
  // changed or cleared (memory_spec.md §2.3).
  const [homeChanged, setHomeChanged] = createSignal(false)
  const named = (name: string) => {
    set("name", name)
    if (!editing() && !homeChanged()) set("home", name.trim() ? `agents/${name.trim()}` : "")
  }
  // Leaving with unsaved changes asks first (agent_form_spec.md §6.3): anything typed in the form (its fields, the
  // prompt's blocks, the rules) or a prompt choice made. A save clears it.
  const [edited, setEdited] = createSignal(false)
  useBeforeLeave((event) => {
    if (!edited() || event.defaultPrevented) return
    event.preventDefault()
    void confirm({
      title: language.t("operator.overlay.discardTitle"),
      description: language.t("operator.overlay.discardBody"),
      confirm: language.t("operator.overlay.discard"),
      danger: true,
    }).then((ok) => {
      if (!ok) return
      setEdited(false)
      event.retry(true)
    })
  })
  const done = (name: string) => {
    setEdited(false)
    const folder = targetDirectory() ?? directory() ?? ""
    void queryClient.invalidateQueries({ queryKey: api.key("agents", folder) })
    void refresh(folder)
    navigate(`/operator/agents/${encodeURIComponent(name)}?dir=${encodeURIComponent(folder)}`)
  }

  // Another namespace clears Save in, the prompt profile and a home folder of its own, after asking if any was set.
  const chooseNamespace = async (id: string) => {
    if (id === namespace()) return
    const set = homeChanged() || prompt.profile !== DEFAULT_PROFILE || chosen.saveIn !== "default"
    if (
      set &&
      !(await confirm({
        title: language.t("operator.agentForm.namespaceChangeTitle"),
        description: language.t("operator.agentForm.namespaceChangeBody"),
        confirm: language.t("operator.agentForm.namespaceChangeConfirm"),
      }))
    )
      return
    setChosen({ namespace: id, saveIn: "default", project: "" })
    setHomeChanged(false)
    named(store.form.name)
    if (search.profile) setSearch({ profile: undefined })
    setPrompt({ profile: DEFAULT_PROFILE, override: null })
  }
  const chooseSaveIn = (value: SaveIn) => {
    setChosen({ saveIn: value, ...(value === "project" ? {} : { project: "" }) })
    // A namespace's agent can't follow one project's small model.
    if (value === "namespace" && store.form.modelSource === "small") set("modelSource", "default")
  }
  const saveInLabel = (value: SaveIn) =>
    value === "default"
      ? language.t("operator.agentForm.saveIn.default", {
          project: defaultProject() ? projectLabel(defaultProject()) : language.t("operator.agentForm.noProject"),
        })
      : value === "project"
        ? language.t("operator.agentForm.saveIn.project")
        : language.t("operator.agentForm.saveIn.namespace")

  const save = async () => {
    if (orderCheck(store.rules).duplicates.length)
      return setStore("error", language.t("operator.agentPermissions.duplicatesBlock"))
    if (!targetDirectory()) return setStore("error", language.t("operator.agentForm.noTarget"))
    if (blocked()) return setStore("error", language.t("operator.agentForm.fixFields"))
    const folder = targetDirectory()!
    setStore({ saving: true, error: "" })
    // A home folder that isn't there yet is made when the agent is saved: one you typed or chose, after asking (§5);
    // a new agent's own agents/<name> as it is.
    const home = checks().home.home
    if (home && homeProject() && homeChanged()) {
      const path = homeFolder(home, homeProject()!)
      const there = await api
        .client()
        .operator.folder.list({ path }, { throwOnError: true })
        .then(() => true)
        .catch(() => false)
      if (
        !there &&
        !(await confirm({
          title: language.t("operator.agentForm.homeCreateTitle"),
          description: language.t("operator.agentForm.homeCreateBody", { folder: path }),
          confirm: language.t("operator.agentForm.homeCreateConfirm"),
        }))
      )
        return setStore("saving", false)
    }
    const patch = agentPatch({ ...store.form, home }, existing()?.settings ?? {}, rulesToConfig(store.rules))
    const client = api.client()
    const request = write((confirmCopy) =>
      editing()
        ? client.operator.agent.update({
            name: existing()!.name,
            directory: folder,
            scope: scope(),
            ...patch,
            ...(confirmCopy ? { confirmCopy } : {}),
          })
        : client.operator.agent.create({
            name: store.form.name.trim(),
            directory: folder,
            scope: scope(),
            format: store.format,
            ...patch,
            ...(confirmCopy ? { confirmCopy } : {}),
          }),
    )
    await request
      .then((written) => (written ? written : Promise.reject(CANCELLED)))
      // Its prompt setting, when it changed (nothing is written into the namespace's profiles: §6.4).
      .then(() =>
        promptChanged()
          ? client.operator.agentPrompt.update(
              {
                name: existing()?.name ?? store.form.name.trim(),
                directory: folder,
                ...(prompt.profile !== DEFAULT_PROFILE ? { profile: prompt.profile } : {}),
                ...(prompt.profile !== DEFAULT_PROFILE && savedOverride() ? { override: savedOverride()! } : {}),
              },
              { throwOnError: true },
            )
          : undefined,
      )
      .then(() =>
        subagent() && inherit() !== locks.current().inherit
          ? client.operator.agentPermissions.saveLocks(
              {
                name: store.form.name.trim(),
                directory: folder,
                operatorPermissionLocks: { locks: locks.current().locks, inherit: inherit() },
              },
              { throwOnError: true },
            )
          : undefined,
      )
      .then(() => {
        showToast({ title: language.t("operator.agentForm.saved", { name: store.form.name }) })
        done(store.form.name.trim())
      })
      .catch((error: unknown) => (error === CANCELLED ? undefined : setStore("error", requestError(error))))
      .finally(() => setStore("saving", false))
  }

  // Temperature, Top P and Step limit as typed (§3), and the home folder inside the project (§5): an error blocks Save.
  const [model, setModel] = createSignal<string>()
  // A project's agent has its home in that project; a namespace's or Global's, inside each project it runs in.
  const homeProject = () => (scope() === "project" ? targetDirectory() : undefined)
  const homeText = (stored: string) => {
    const found = homeOf(stored, homeProject() ?? directory())
    return found.error ? stored : found.home.replace(/^\.\//, "")
  }
  const checks = createMemo(() => ({
    temperature: checkTemperature(store.form.temperature, isAnthropic(model())),
    top_p: checkTopP(store.form.top_p),
    steps: checkSteps(store.form.steps),
    home: homeOf(store.form.home, homeProject()),
  }))
  const blocked = () => {
    const found = checks()
    return !!(found.temperature.error || found.top_p.error || found.steps.error || found.home.error)
  }
  const checkNote = (check: Check, testid: string): JSX.Element => (
    <Show when={check.error ?? check.warning}>
      {(key) => (
        <p
          data-slot={check.error ? "operator-field-error" : "operator-note"}
          data-warning={check.error ? undefined : ""}
          role={check.error ? "alert" : "status"}
          data-testid={testid}
        >
          {language.t(`operator.agentForm.check.${key()}`)}
        </p>
      )}
    </Show>
  )
  const browseFolders = useFolderBrowser()
  const browseHome = async () => {
    const project = homeProject()
    if (!project) return
    const picked = await browseFolders({ within: project, start: homeFolder(checks().home.home, project) })
    if (!picked) return
    setHomeChanged(true)
    set("home", homeOf(picked, project).home.replace(/^\.\//, ""))
  }

  // Saved in, for an agent being edited: where it is defined. Move to another project (§7).
  const savedIn = () => {
    const level = existing()?.level
    if (!level) return ""
    if (level.kind === "namespace")
      return language.t("operator.agentForm.savedIn.namespace", {
        name:
          ready(namespaces)?.find((item) => item.namespace.id === level.namespace)?.namespace.name ??
          level.namespace ??
          "",
      })
    if (level.kind === "project")
      return language.t("operator.agentForm.savedIn.project", { name: projectLabel(directory()) })
    return language.t(`operator.agentForm.savedIn.${level.kind}`)
  }
  const movable = () => !!existing()?.level && !["builtin", "environment"].includes(existing()!.level.kind)
  const [move, setMove] = createStore({ open: false, project: "", busy: false })
  const moveTargets = () =>
    projects().filter((item) => existing()?.level.kind !== "project" || item.directory !== directory())
  const moveAgent = async () => {
    const agent = existing()
    if (!agent || !move.project) return
    setMove("busy", true)
    await api
      .client()
      .operator.agent.move({ name: agent.name, directory: directory(), project: move.project }, { throwOnError: true })
      .then(() => {
        showToast({
          title: language.t("operator.agentForm.moved", { name: agent.name, project: projectLabel(move.project) }),
        })
        void queryClient.invalidateQueries({ queryKey: api.key("agents") })
        navigate(`/operator/agents/${encodeURIComponent(agent.name)}?dir=${encodeURIComponent(move.project)}`)
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setMove({ busy: false, open: false }))
  }

  // The Type (agent_types_spec.md §2): Helper (new agents only) switches to the helper's form (helper-form.tsx).
  const [helper, setHelper] = createSignal(false)
  const typeField = () => (
    <Field group label={language.t("operator.column.type")} hint={language.t("operator.help.agentType")}>
      <SegmentedControlV2
        class="operator-segmented-wide"
        value={helper() ? "helper" : store.form.mode}
        onChange={(value) => {
          if (!value) return
          setHelper(value === "helper")
          if (value !== "helper") set("mode", value as Mode)
        }}
      >
        <SegmentedControlItemV2 value="primary">{language.t("operator.agents.type.usual")}</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="subagent">{language.t("operator.agents.type.subagent")}</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="all">{language.t("operator.agents.type.both")}</SegmentedControlItemV2>
        <Show when={!editing()}>
          <SegmentedControlItemV2 value="helper">{language.t("operator.agents.type.helper")}</SegmentedControlItemV2>
        </Show>
      </SegmentedControlV2>
    </Field>
  )

  return (
    <Show
      when={directory()}
      fallback={
        <EmptyState
          icon="brain"
          title={language.t("operator.project.none")}
          description={language.t("operator.project.noneHint")}
        />
      }
    >
      <PageHeader
        title={
          editing()
            ? language.t("operator.agentForm.editTitle", { name: params.name ?? "" })
            : language.t("operator.agentForm.newTitle")
        }
        description={language.t("operator.agentForm.description")}
      />
      <Show
        when={!helper()}
        fallback={
          <HelperForm
            namespace={namespace()}
            before={typeField()}
            onSaved={(found) => {
              setEdited(false)
              navigate(
                `/operator/agents?dir=${encodeURIComponent(directory() ?? "")}&helper=${encodeURIComponent(found.name)}&hns=${encodeURIComponent(found.namespace)}`,
              )
            }}
            onCancel={() => history.back()}
          />
        }
      >
        <section data-component="operator-panel" onInput={() => setEdited(true)}>
          <div data-component="operator-form">
            {typeField()}
            <Show when={!editing()}>
              <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.agentForm.nameHint")}>
                <TextInputV2
                  appearance="base"
                  value={store.form.name}
                  onInput={(event) => named(event.currentTarget.value)}
                />
              </Field>
            </Show>
            <Show
              when={!editing()}
              fallback={
                <Field
                  group
                  label={language.t("operator.agentForm.savedIn")}
                  hint={language.t("operator.help.agentSavedIn")}
                >
                  <div class="flex flex-wrap items-center gap-2" data-testid="agent-saved-in">
                    <span>{savedIn()}</span>
                    <Show when={movable()}>
                      <ButtonV2
                        size="small"
                        variant="neutral"
                        onClick={() => setMove({ open: !move.open, project: "" })}
                      >
                        {language.t("operator.agentForm.move")}
                      </ButtonV2>
                    </Show>
                  </div>
                  <Show when={move.open}>
                    <div class="flex flex-wrap items-center gap-2" data-testid="agent-move">
                      <SelectV2<string>
                        appearance="base"
                        aria-label={language.t("operator.agentForm.moveTo")}
                        placeholder={language.t("operator.agentForm.moveTo")}
                        options={moveTargets().map((item) => item.directory)}
                        current={move.project || undefined}
                        label={(key) => projectLabel(key)}
                        optionTitle={(key) => key}
                        onSelect={(key) => key && setMove("project", key)}
                      />
                      <ButtonV2
                        size="small"
                        variant="contrast"
                        disabled={!move.project || move.busy}
                        onClick={() => void moveAgent()}
                      >
                        {language.t("operator.agentForm.moveConfirm")}
                      </ButtonV2>
                      <span data-slot="operator-note">{language.t("operator.agentForm.moveNote")}</span>
                    </div>
                  </Show>
                </Field>
              }
            >
              <Field
                group
                label={language.t("operator.agentForm.namespace")}
                hint={language.t("operator.help.agentNamespace")}
              >
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("operator.agentForm.namespace")}
                  options={(ready(namespaces) ?? []).map((item) => item.namespace.id)}
                  current={namespace()}
                  label={(id) => {
                    const found = ready(namespaces)?.find((item) => item.namespace.id === id)
                    return found ? `${found.namespace.name} · ${id}` : id
                  }}
                  optionTitle={(id) =>
                    ready(namespaces)?.find((item) => item.namespace.id === id)?.namespace.folder ?? id
                  }
                  onSelect={(id) => id && void chooseNamespace(id)}
                />
              </Field>
              <Field
                group
                label={language.t("operator.agentForm.saveIn")}
                hint={language.t("operator.help.agentSaveIn")}
              >
                <Show
                  when={!isGlobal()}
                  fallback={
                    <span data-testid="agent-save-in-global">{language.t("operator.agentForm.saveIn.global")}</span>
                  }
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <SelectV2<SaveIn>
                      appearance="base"
                      aria-label={language.t("operator.agentForm.saveIn")}
                      options={["default", "project", "namespace"]}
                      current={chosen.saveIn}
                      label={saveInLabel}
                      onSelect={(value) => value && chooseSaveIn(value)}
                    />
                    <Show when={chosen.saveIn === "project"}>
                      <SelectV2<string>
                        appearance="base"
                        aria-label={language.t("operator.agentForm.chooseProject")}
                        placeholder={language.t("operator.agentForm.chooseProject")}
                        options={namespaceProjects().map((item) => item.directory)}
                        current={chosen.project || undefined}
                        label={(key) => projectLabel(key)}
                        optionTitle={(key) => key}
                        onSelect={(key) => key && setChosen("project", key)}
                      />
                    </Show>
                  </div>
                </Show>
              </Field>
            </Show>
            <Show when={!editing()}>
              <Field
                group
                label={language.t("operator.agentForm.format")}
                hint={language.t("operator.agentForm.formatHint")}
              >
                <SegmentedControlV2
                  value={store.format}
                  onChange={(value) => value && setStore("format", value as "file" | "config")}
                >
                  <SegmentedControlItemV2 value="file">
                    {language.t("operator.agentForm.format.file")}
                  </SegmentedControlItemV2>
                  <SegmentedControlItemV2 value="config">
                    {language.t("operator.agentForm.format.config")}
                  </SegmentedControlItemV2>
                </SegmentedControlV2>
              </Field>
            </Show>
            <Show when={(!editing() || existing()?.source.kind !== "file") && target()}>
              {(path) => (
                <p data-slot="operator-note" data-testid="agent-target">
                  {language.t("operator.agentForm.writesTo", { path: path() })}
                </p>
              )}
            </Show>
            <Field
              label={language.t("operator.column.description")}
              hint={language.t("operator.agentForm.descriptionHint")}
            >
              <TextInputV2
                appearance="base"
                value={store.form.description}
                onInput={(event) => set("description", event.currentTarget.value)}
              />
            </Field>
            <Show when={subagent()}>
              <Field group label={language.t("operator.agents.flavor")} hint={language.t("operator.help.agentFlavor")}>
                <SegmentedControlV2
                  class="operator-segmented-wide"
                  value={store.form.subagentMemory}
                  onChange={(value) => value && set("subagentMemory", value as Flavor)}
                >
                  <SegmentedControlItemV2 value="incognito">
                    {language.t("operator.agents.flavor.incognito")}
                  </SegmentedControlItemV2>
                  <SegmentedControlItemV2 value="retentive">
                    {language.t("operator.agents.flavor.retentive")}
                  </SegmentedControlItemV2>
                </SegmentedControlV2>
              </Field>
              <Field group label={language.t("operator.locks.inherit")} hint={language.t("operator.help.lockInherit")}>
                <SegmentedControlV2
                  class="operator-segmented-wide"
                  value={inherit()}
                  onChange={(value) => value && setStore("inherit", value as "own" | "parent")}
                  aria-label={language.t("operator.locks.inherit")}
                >
                  <SegmentedControlItemV2 value="own">{language.t("operator.locks.inheritOwn")}</SegmentedControlItemV2>
                  <SegmentedControlItemV2 value="parent">
                    {language.t("operator.locks.inheritParent")}
                  </SegmentedControlItemV2>
                </SegmentedControlV2>
              </Field>
            </Show>
            <AgentModelFields
              form={store.form}
              set={(key, value) => set(key, value)}
              directory={targetDirectory()}
              scope={scope()}
              namespace={namespace()}
              editing={editing()}
              where={where()}
              onModel={setModel}
            />
            <div data-slot="operator-form-row">
              <Field label={language.t("operator.agent.temperature")} hint={language.t("operator.help.temperature")}>
                <TextInputV2
                  appearance="base"
                  inputMode="decimal"
                  value={store.form.temperature}
                  invalid={!!checks().temperature.error}
                  onInput={(event) => set("temperature", event.currentTarget.value)}
                />
                {checkNote(checks().temperature, "check-temperature")}
              </Field>
              <Field label={language.t("operator.agent.topP")} hint={language.t("operator.help.topP")}>
                <TextInputV2
                  appearance="base"
                  inputMode="decimal"
                  value={store.form.top_p}
                  invalid={!!checks().top_p.error}
                  onInput={(event) => set("top_p", event.currentTarget.value)}
                />
                {checkNote(checks().top_p, "check-top-p")}
              </Field>
              <Field label={language.t("operator.agent.steps")} hint={language.t("operator.help.steps")}>
                <TextInputV2
                  appearance="base"
                  inputMode="numeric"
                  value={store.form.steps}
                  invalid={!!checks().steps.error}
                  onInput={(event) => set("steps", event.currentTarget.value)}
                />
                {checkNote(checks().steps, "check-steps")}
              </Field>
            </div>
            <div data-slot="operator-form-row">
              <Field
                group
                label={language.t("operator.agentForm.color")}
                hint={language.t("operator.agentForm.colorHint")}
              >
                <ColorField value={store.form.color} onChange={(value) => set("color", value)} />
              </Field>
              <Field group label={language.t("operator.agents.hidden")} hint={language.t("operator.help.hidden")}>
                <Switch checked={store.form.hidden} onChange={(checked) => set("hidden", checked)}>
                  {language.t("operator.agentForm.hiddenHint")}
                </Switch>
              </Field>
            </div>
            <Field label={language.t("operator.agentForm.home")} hint={language.t("operator.agentForm.homeHint")}>
              <div class="flex flex-wrap items-center gap-1" data-testid="agent-home">
                <code data-slot="operator-home-prefix">
                  {homeProject() ? `${homeProject()}/` : language.t("operator.agentForm.homeEachProject")}
                </code>
                <TextInputV2
                  appearance="base"
                  value={store.form.home}
                  placeholder="agents/<name>"
                  invalid={!!checks().home.error}
                  onInput={(event) => {
                    setHomeChanged(true)
                    set("home", event.currentTarget.value)
                  }}
                />
                <ButtonV2 size="small" variant="neutral" disabled={!homeProject()} onClick={() => void browseHome()}>
                  {language.t("operator.agentForm.homeBrowse")}
                </ButtonV2>
              </div>
              <Show when={checks().home.error}>
                {(key) => (
                  <p data-slot="operator-field-error" role="alert" data-testid="check-home">
                    {language.t(`operator.agentForm.check.${key()}`)}{" "}
                    <Show when={key() === "homeOutside" && store.form.name.trim()}>
                      <button
                        type="button"
                        data-slot="operator-link"
                        onClick={() => {
                          setHomeChanged(true)
                          set("home", `agents/${store.form.name.trim()}`)
                        }}
                      >
                        {language.t("operator.agentForm.homeMoveInside")}
                      </button>
                    </Show>
                  </p>
                )}
              </Show>
            </Field>
            <AgentFormPrompt
              directory={targetDirectory()}
              namespace={namespace()}
              agent={existing()?.name ?? store.form.name}
              prompt={store.form.prompt}
              mode={store.form.mode}
              model={model()}
              value={prompt}
              onChange={(next) => {
                setPrompt(next)
                setEdited(true)
              }}
              onPrompt={(text) => set("prompt", text)}
            />
            <Field
              group
              label={language.t("operator.agent.tab.permissions")}
              hint={language.t("operator.agent.rulesHint")}
            >
              <div data-slot="operator-permission-layout">
                <LevelEditor
                  {...(directory() ? { directory: directory() } : {})}
                  level="agent"
                  inherited={editing() ? (permissions.data?.inherited ?? []) : []}
                  value={{ lines: store.rules, deleted: [], locks: [] }}
                  onChange={(value) => setStore("rules", value.lines)}
                  canDeleteOpenCode={false}
                  canDelete={false}
                  canLock={false}
                  forms={permissions.data?.forms ?? {}}
                  known={permissions.data?.known ?? []}
                />
                <Show when={editing() && existing()}>
                  {(agent) => (
                    <PermissionImpact
                      agent={agent().name}
                      directory={directory() ?? ""}
                      agentRules={store.rules}
                      dirty={JSON.stringify(store.rules) !== savedRules()}
                    />
                  )}
                </Show>
              </div>
            </Field>
          </div>
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
          <div data-slot="operator-actions">
            <ButtonV2 variant="neutral" onClick={() => history.back()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2
              variant="contrast"
              disabled={store.saving || blocked() || (!editing() && !store.form.name.trim())}
              onClick={() => void save()}
            >
              {editing() ? language.t("operator.config.save") : language.t("operator.agentForm.create")}
            </ButtonV2>
          </div>
        </section>
      </Show>
    </Show>
  )
}
