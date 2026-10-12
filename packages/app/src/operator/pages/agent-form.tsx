import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useScopedProject } from "../project"
import { EmptyState } from "../ui/empty-state"
import { Field } from "../ui/field"
import { PageHeader } from "../ui/page-header"
import { LevelEditor } from "../ui/level-editor"
import { PermissionImpact } from "../ui/permission-impact"
import { orderCheck, type Rule, rulesFromConfig, rulesToConfig } from "../ui/rules"
import { useAgentPermissions, useRefreshAgent } from "./agent-permissions"
import { AgentModelFields } from "./agent-model-fields"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { useAgents } from "./agents"
import { agentPatch, type AgentForm, formFromSettings } from "./agent-form-state"
import type { Flavor, Mode } from "./agent-type"
import { requestError } from "./config-helpers"
import { usePromptCatalog, useProfileNames } from "./profile-data"
import { OPENCODE } from "./profile-model"
import { useProjectSettings } from "./project-prompt"
import { useAgentLocks } from "../ui/permission-locks"
import { useProjectConfigWrite } from "../ui/project-config-copy"

// The user kept the namespace's config: nothing was written.
const CANCELLED = Symbol("cancelled")

// Create a new agent (an agent file or a config entry) or edit an existing one.
export default function AgentFormPage() {
  const language = useLanguage()
  const params = useParams<{ name?: string }>()
  // Create agent… on a profile: the new agent uses that profile.
  const [search] = useSearchParams<{ profile?: string }>()
  const names = useProfileNames()
  const settings = useProjectSettings()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const write = useProjectConfigWrite()
  const queryClient = useQueryClient()
  const directory = useScopedProject()
  const agents = useAgents()
  const editing = () => params.name !== undefined
  const namespace = () => settings.data?.find((item) => item.key === directory())?.namespace ?? OPENCODE
  const prompts = usePromptCatalog(namespace)
  const profile = () =>
    !editing() && search.profile ? prompts.query.data?.profiles.find((item) => item.id === search.profile) : undefined
  const existing = createMemo(() => agents.data?.find((agent) => agent.name === decodeURIComponent(params.name ?? "")))
  // The full list the agent's own rules sit in (a new agent: build's, for the hints and the picker).
  const permissions = useAgentPermissions(() => existing()?.name ?? "build", directory)
  const savedRules = () => JSON.stringify(rulesFromConfig(existing()?.settings.permission))
  const refresh = useRefreshAgent()
  const [store, setStore] = createStore({
    scope: "project" as Scope,
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
      setStore({
        form: formFromSettings(agent.name, agent.settings),
        rules: rulesFromConfig(agent.settings.permission),
      })
    }),
  )

  // The config file and the agents folder at each scope, to say where the agent is saved.
  const layers = useQuery(() => ({
    queryKey: api.key("config-layers", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.config.layers({ directory: directory() })
        .then((result) => result.data),
  }))
  const target = () => {
    const name = (editing() ? existing()?.name : store.form.name.trim()) || "<name>"
    if (existing()?.source.kind === "file") return existing()?.source.path
    const found = layers.data
    if (!found) return undefined
    if (!editing() && store.format === "file") return `${found.folders[store.scope]}/agents/${name}.md`
    return language.t("operator.agentForm.configEntry", { file: found.targets[store.scope], name })
  }

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setStore("form", key, value)
  // A new agent works in agents/<name>/ of its project (its memory is kept there) unless its home is
  // changed or cleared (memory_spec.md §2.3).
  const [homeChanged, setHomeChanged] = createSignal(false)
  const named = (name: string) => {
    set("name", name)
    if (!editing() && !homeChanged()) set("home", name.trim() ? `agents/${name.trim()}/` : "")
  }
  const done = (name: string) => {
    void queryClient.invalidateQueries({ queryKey: api.key("agents", directory()) })
    void refresh(directory() ?? "")
    navigate(`/operator/agents/${encodeURIComponent(name)}?dir=${encodeURIComponent(directory() ?? "")}`)
  }

  const save = async () => {
    if (orderCheck(store.rules).duplicates.length)
      return setStore("error", language.t("operator.agentPermissions.duplicatesBlock"))
    setStore({ saving: true, error: "" })
    const patch = agentPatch(store.form, existing()?.settings ?? {}, rulesToConfig(store.rules))
    const client = api.client()
    const request = write((confirmCopy) =>
      editing()
        ? client.operator.agent.update({
            name: existing()!.name,
            directory: directory(),
            scope: store.scope,
            ...patch,
            ...(confirmCopy ? { confirmCopy } : {}),
          })
        : client.operator.agent.create({
            name: store.form.name.trim(),
            directory: directory(),
            scope: store.scope,
            format: store.format,
            ...patch,
            ...(confirmCopy ? { confirmCopy } : {}),
          }),
    )
    const chosen = profile()
    await request
      .then((written) => (written ? written : Promise.reject(CANCELLED)))
      .then(() =>
        chosen
          ? client.operator.agentPrompt.update({
              name: store.form.name.trim(),
              directory: directory(),
              profile: chosen.id,
            })
          : undefined,
      )
      .then(() =>
        subagent() && inherit() !== locks.current().inherit
          ? client.operator.agentPermissions.saveLocks(
              {
                name: store.form.name.trim(),
                directory: directory(),
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

  const fileAgent = () => existing()?.source.kind === "file"

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
      <section data-component="operator-panel">
        <div data-component="operator-form">
          <Show when={profile()}>
            {(found) => (
              <p data-slot="operator-note" role="status">
                {language.t("operator.agentForm.profile", { name: names.profile(found()) })}
              </p>
            )}
          </Show>
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
            when={!fileAgent()}
            fallback={
              <p data-slot="operator-note">
                {language.t("operator.agentForm.fileNote", { path: existing()?.source.path ?? "" })}
              </p>
            }
          >
            <Field
              group
              label={language.t("operator.agentForm.scope")}
              hint={
                editing()
                  ? language.t("operator.agentForm.scopeEditHint")
                  : language.t("operator.agentForm.scopeNewHint")
              }
            >
              <ScopeSwitch value={store.scope} onChange={(scope) => setStore("scope", scope)} />
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
          <Show when={!fileAgent() && target()}>
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
          <Field group label={language.t("operator.column.type")} hint={language.t("operator.help.agentType")}>
            <SegmentedControlV2
              class="operator-segmented-wide"
              value={store.form.mode}
              onChange={(value) => value && set("mode", value as Mode)}
            >
              <SegmentedControlItemV2 value="primary">
                {language.t("operator.agents.type.usual")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="subagent">
                {language.t("operator.agents.type.subagent")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="all">{language.t("operator.agents.type.both")}</SegmentedControlItemV2>
            </SegmentedControlV2>
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
            set={set}
            directory={directory()}
            scope={store.scope}
            editing={editing()}
            where={
              store.scope === "global"
                ? language.t("operator.modelChain.settingsName")
                : (settings.data?.find((item) => item.key === directory())?.name ?? directory() ?? "")
            }
          />
          <div data-slot="operator-form-row">
            <Field label={language.t("operator.agent.temperature")} hint={language.t("operator.help.temperature")}>
              <TextInputV2
                appearance="base"
                inputMode="decimal"
                value={store.form.temperature}
                onInput={(event) => set("temperature", event.currentTarget.value)}
              />
            </Field>
            <Field label={language.t("operator.agent.topP")} hint={language.t("operator.help.topP")}>
              <TextInputV2
                appearance="base"
                inputMode="decimal"
                value={store.form.top_p}
                onInput={(event) => set("top_p", event.currentTarget.value)}
              />
            </Field>
            <Field label={language.t("operator.agent.steps")} hint={language.t("operator.help.steps")}>
              <TextInputV2
                appearance="base"
                inputMode="numeric"
                value={store.form.steps}
                onInput={(event) => set("steps", event.currentTarget.value)}
              />
            </Field>
          </div>
          <div data-slot="operator-form-row">
            <Field label={language.t("operator.agentForm.color")} hint={language.t("operator.agentForm.colorHint")}>
              <TextInputV2
                appearance="base"
                value={store.form.color}
                placeholder="#FF6600"
                onInput={(event) => set("color", event.currentTarget.value)}
              />
            </Field>
            <Field group label={language.t("operator.agents.hidden")} hint={language.t("operator.help.hidden")}>
              <Switch checked={store.form.hidden} onChange={(checked) => set("hidden", checked)}>
                {language.t("operator.agentForm.hiddenHint")}
              </Switch>
            </Field>
          </div>
          <Field label={language.t("operator.agentForm.home")} hint={language.t("operator.agentForm.homeHint")}>
            <TextInputV2
              appearance="base"
              value={store.form.home}
              placeholder="agents/<name>/"
              onInput={(event) => {
                setHomeChanged(true)
                set("home", event.currentTarget.value)
              }}
            />
          </Field>
          <Field label={language.t("operator.agentForm.prompt")} hint={language.t("operator.agentForm.promptHint")}>
            <TextareaV2
              class="operator-editor"
              rows={10}
              value={store.form.prompt}
              onInput={(event) => set("prompt", event.currentTarget.value)}
            />
          </Field>
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
            disabled={store.saving || (!editing() && !store.form.name.trim())}
            onClick={() => void save()}
          >
            {editing() ? language.t("operator.config.save") : language.t("operator.agentForm.create")}
          </ButtonV2>
        </div>
      </section>
    </Show>
  )
}
