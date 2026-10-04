import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { type Projects, ProjectScope, scopeLabel } from "../ui/project-scope"
import { usePromptProfile, useProfileNames } from "./profile-data"
import {
  type Catalog,
  goalOf,
  groupsUsing,
  type Layer,
  OPENCODE,
  overridesOf,
  type Section,
  SECTIONS,
  WRITTEN,
} from "./profile-model"

type Row = {
  key: string
  name: string
  layer?: Layer
  // An override shown under the text it replaces, or a project without a goal.
  indent?: boolean
  placeholder?: boolean
}

type Draft = {
  id?: string
  section: Section
  purpose?: "org" | "goal"
  overrides?: string
  name: string
  text: string
  projects: Projects
  agents: string
  enabled: boolean
  priority: string
  maxLength: string
  file?: string
}

// Every prompt layer, by section: OpenCode's texts (with your overrides under them), the layers you
// write, generated sections and slots. Picking one opens it on the right.
export function LayerDefinition() {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const confirm = useConfirm()
  const data = usePromptProfile()
  const names = useProfileNames()
  const [params, setParams] = useSearchParams<{ layer?: string; q?: string; scope?: string }>()
  const catalog = () => data.query.data
  const projects = () => catalog()?.projects ?? []
  const all = () => language.t("operator.scope.all")
  const scopes = (): Array<{ key?: string; name: string }> => [{ name: all() }, ...projects()]

  // Tool descriptions come from a project's tool registry: the filtered project's, else the first one's.
  const toolFolder = () =>
    params.scope && params.scope !== OPENCODE ? params.scope : projects().find((item) => item.key !== OPENCODE)?.key
  const tools = useQuery(() => ({
    queryKey: api.key("prompt-catalog", toolFolder()),
    enabled: !!toolFolder(),
    queryFn: () =>
      api
        .client()
        .operator.prompt.catalog({ directory: toolFolder() })
        .then((result) => result.data!),
  }))
  const toolLayers = createMemo<Layer[]>(() =>
    (tools.data?.tools ?? []).map((tool) => ({
      id: `tool.${tool.id}`,
      name: `tool.${tool.id}`,
      section: "tool",
      projects: "*",
      priority: 50,
      enabled: true,
      text: tool.builtin,
      origin: "builtin",
    })),
  )
  const find = (id: string) =>
    catalog()?.layers.find((item) => item.id === id) ?? toolLayers().find((item) => item.id === id)

  const sections = createMemo(() => {
    const loaded = catalog()
    if (!loaded) return []
    const query = (params.q ?? "").trim().toLowerCase()
    const shown = (layer: Layer) =>
      (!query || `${layer.id} ${layer.name} ${layer.text}`.toLowerCase().includes(query)) &&
      (!params.scope || layer.origin === "builtin" || layer.projects === "*" || layer.projects.includes(params.scope))
    const withOverrides = (layers: Layer[]) =>
      layers.flatMap((layer) => [
        ...(shown(layer) ? [{ key: layer.id, name: names.layer(layer), layer }] : []),
        ...overridesOf(loaded, layer.id)
          .filter(shown)
          .map((item) => ({ key: item.id, name: item.name, layer: item, indent: true })),
      ])
    const written = (section: Section) =>
      loaded.layers.filter(
        (layer) =>
          layer.section === section && !layer.overrides && layer.origin !== "slot" && layer.origin !== "collection",
      )
    const goals = projects()
      .filter((project) => !params.scope || params.scope === project.key)
      .map((project): Row => {
        if (project.key === OPENCODE)
          return { key: "goal:opencode", name: language.t("operator.profile.goalOf", { project: project.name }) }
        const goal = goalOf(loaded, project.key)
        if (goal) return { key: goal.id, name: goal.name, layer: goal }
        return {
          key: `new:goal:${project.key}`,
          name: language.t("operator.profile.noGoal", { project: project.name }),
          placeholder: true,
        }
      })
    const builtins = (section: Section) =>
      loaded.layers.filter((layer) => layer.origin === "builtin" && layer.section === section)
    const rows: Record<Section, Row[]> = {
      base: [
        ...[find("slot.base")!].filter(shown).map((layer) => ({ key: layer.id, name: names.layer(layer), layer })),
        ...withOverrides(builtins("base")),
      ],
      purpose: [
        ...written("purpose")
          .filter((layer) => layer.purpose !== "goal" && shown(layer))
          .map((layer) => ({ key: layer.id, name: layer.name, layer })),
        ...goals,
      ],
      role: written("role")
        .filter(shown)
        .map((layer) => ({ key: layer.id, name: layer.name, layer })),
      identity: [
        ...written("identity")
          .filter(shown)
          .map((layer) => ({ key: layer.id, name: layer.name, layer })),
        ...[find("slot.agent")!].map((layer) => ({ key: layer.id, name: names.layer(layer), layer })),
      ],
      tool: [
        ...withOverrides(toolLayers()),
        // Overrides of tools the listed project does not have.
        ...loaded.layers
          .filter((layer) => layer.section === "tool" && !toolLayers().some((tool) => tool.id === layer.overrides))
          .filter(shown)
          .map((layer) => ({ key: layer.id, name: layer.name, layer })),
      ],
      generated: loaded.layers
        .filter((layer) => layer.origin === "generated" && shown(layer))
        .map((layer) => ({ key: layer.id, name: names.layer(layer), layer })),
      output: withOverrides(builtins("output")),
      custom: written("custom")
        .filter(shown)
        .map((layer) => ({ key: layer.id, name: layer.name, layer })),
      message: withOverrides(builtins("message")),
    }
    return SECTIONS.map((section) => ({ section, rows: rows[section] }))
  })

  const select = (key: string) => setParams({ layer: key })

  return (
    <div data-slot="operator-columns">
      <div class="flex flex-col gap-4 min-w-0">
        <div data-slot="operator-toolbar">
          <TextInputV2
            type="search"
            appearance="base"
            value={params.q ?? ""}
            placeholder={language.t("operator.profile.searchLayers")}
            aria-label={language.t("operator.profile.searchLayers")}
            onInput={(event) => setParams({ q: event.currentTarget.value || undefined })}
          />
          <SelectV2<{ key?: string; name: string }>
            appearance="inline"
            aria-label={language.t("operator.profile.scopeFilter")}
            options={scopes()}
            current={scopes().find((item) => item.key === params.scope)}
            value={(item) => item.key ?? "*"}
            label={(item) => item.name}
            onSelect={(item) => setParams({ scope: item?.key })}
          />
        </div>
        <For each={sections()}>
          {(entry) => (
            <section data-component="operator-panel" data-section={entry.section}>
              <div data-slot="operator-panel-head">
                <h2 data-slot="operator-panel-title">{names.section(entry.section)}</h2>
                <Show when={WRITTEN.includes(entry.section)}>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    onClick={() => select(entry.section === "purpose" ? "new:org" : `new:${entry.section}`)}
                  >
                    {entry.section === "purpose"
                      ? language.t("operator.profile.newOrg")
                      : language.t("operator.profile.newLayer")}
                  </ButtonV2>
                </Show>
              </div>
              <p data-slot="operator-note">{language.t(`operator.layerSection.about.${entry.section}`)}</p>
              <DataTable
                label={names.section(entry.section)}
                rows={entry.rows}
                empty={language.t("operator.profile.noLayers")}
                onRowClick={(row) => select(row.key)}
                columns={[
                  {
                    id: "name",
                    header: language.t("operator.column.name"),
                    cell: (row) => (
                      <span
                        class="flex items-center gap-2"
                        style={{ "padding-inline-start": row.indent ? "16px" : "0" }}
                      >
                        <span data-selected={params.layer === row.key ? "" : undefined}>
                          {row.indent ? "↳ " : ""}
                          {row.name}
                        </span>
                        <Show when={row.layer?.origin === "file"}>
                          <Tag>{language.t("operator.profile.file")}</Tag>
                        </Show>
                        <Show when={row.layer?.overrides}>
                          <Tag variant="accent">{language.t("operator.profile.override")}</Tag>
                        </Show>
                      </span>
                    ),
                  },
                  {
                    id: "scope",
                    header: language.t("operator.profile.scope"),
                    cell: (row) =>
                      row.layer && !row.placeholder ? scopeLabel(row.layer.projects, projects(), all()) : "",
                  },
                  {
                    id: "agents",
                    header: language.t("operator.profile.agents"),
                    cell: (row) => row.layer?.agents?.join(", ") ?? "",
                  },
                  {
                    id: "enabled",
                    header: language.t("operator.profile.enabled"),
                    cell: (row) => (row.layer && !row.layer.enabled ? language.t("operator.agent.off") : ""),
                  },
                  {
                    id: "groups",
                    header: language.t("operator.profile.usedIn"),
                    cell: (row) =>
                      row.layer
                        ? groupsUsing(catalog()!, row.layer.id)
                            .map((group) => names.group(group))
                            .join(", ")
                        : "",
                  },
                ]}
              />
            </section>
          )}
        </For>
      </div>
      <section data-component="operator-panel" data-slot="operator-sticky">
        <Show
          when={catalog() && params.layer}
          fallback={<p data-slot="operator-note">{language.t("operator.profile.pickLayer")}</p>}
        >
          <LayerPanel
            key={params.layer!}
            catalog={catalog()!}
            find={find}
            onSelect={select}
            onDone={(id) => setParams({ layer: id })}
            onOpenMemory={() => navigate("/operator/memory")}
            onOpenAgents={() => navigate("/operator/agents")}
            confirm={confirm}
          />
        </Show>
      </section>
    </div>
  )
}

// The right-hand panel for the chosen row: an editor for layers you write and overrides, or what a
// built-in layer is.
function LayerPanel(props: {
  key: string
  catalog: Catalog
  find: (id: string) => Layer | undefined
  onSelect: (key: string) => void
  onDone: (id: string | undefined) => void
  onOpenMemory: () => void
  onOpenAgents: () => void
  confirm: ReturnType<typeof useConfirm>
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const layer = () => props.find(props.key)

  const draft = createMemo<Draft | undefined>(() => {
    const key = props.key
    if (key === "new:org") return blank({ section: "purpose", purpose: "org" })
    if (key.startsWith("new:goal:"))
      return blank({ section: "purpose", purpose: "goal", projects: [key.slice("new:goal:".length)] })
    if (key.startsWith("new:override:")) {
      const id = key.slice("new:override:".length)
      const builtin = props.find(id)
      return blank({ section: builtin?.section ?? "base", overrides: id, name: id, text: builtin?.text ?? "" })
    }
    if (key.startsWith("new:")) return blank({ section: key.slice("new:".length) as Section })
    const found = layer()
    if (
      !found ||
      found.origin === "builtin" ||
      found.origin === "slot" ||
      found.origin === "collection" ||
      found.origin === "generated"
    )
      return undefined
    return {
      id: found.id,
      section: found.section,
      purpose: found.purpose,
      overrides: found.overrides,
      name: found.name,
      text: found.text,
      projects: found.projects,
      agents: found.agents?.join(", ") ?? "",
      enabled: found.enabled,
      priority: String(found.priority),
      maxLength: found.maxLength ? String(found.maxLength) : "",
      file: found.origin === "file" ? found.path : undefined,
    }
  })

  return (
    <Show
      when={draft()}
      fallback={
        <Show when={props.key === "goal:opencode"} fallback={<BuiltinView {...props} />}>
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.goalOf", { project: "OpenCode" })}</h2>
          <p data-slot="operator-note">{language.t("operator.profile.opencodeGoal")}</p>
          <ButtonV2 size="small" variant="outline" onClick={() => props.onSelect("slot.base")}>
            {names.layer({ id: "slot.base", name: "" })}
          </ButtonV2>
        </Show>
      }
    >
      {(current) => <LayerEditor {...props} draft={current()} />}
    </Show>
  )
}

function BuiltinView(props: {
  key: string
  catalog: Catalog
  find: (id: string) => Layer | undefined
  onSelect: (key: string) => void
  onOpenMemory: () => void
  onOpenAgents: () => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const layer = () => props.find(props.key)
  const overrides = () => (layer() ? overridesOf(props.catalog, layer()!.id) : [])
  const overridable = () => layer()?.origin === "builtin"

  return (
    <Show when={layer()} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchLayer")}</p>}>
      {(current) => (
        <>
          <h2 data-slot="operator-panel-title">
            <code>{names.layer(current())}</code>
          </h2>
          <Show when={names.describe(current())}>{(about) => <p data-slot="operator-note">{about()}</p>}</Show>
          <Show when={current().id === "generated.instructions"}>
            <ButtonV2 size="small" variant="outline" onClick={props.onOpenMemory}>
              {language.t("operator.prompts.openMemory")}
            </ButtonV2>
          </Show>
          <Show when={current().id === "slot.agent"}>
            <ButtonV2 size="small" variant="outline" onClick={props.onOpenAgents}>
              {language.t("operator.profile.openAgents")}
            </ButtonV2>
          </Show>
          <Show when={overridable()}>
            <h3 data-slot="operator-panel-title">{language.t("operator.profile.overrides")}</h3>
            <Show
              when={overrides().length}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.noOverrides")}</p>}
            >
              <ul data-component="operator-layers">
                <For each={overrides()}>
                  {(item) => (
                    <li data-slot="operator-layer">
                      <button type="button" data-slot="operator-layer-open" onClick={() => props.onSelect(item.id)}>
                        <span data-slot="operator-layer-name">{item.name}</span>
                        <Tag>{scopeLabel(item.projects, props.catalog.projects, language.t("operator.scope.all"))}</Tag>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <div data-slot="operator-actions">
              <ButtonV2 variant="contrast" onClick={() => props.onSelect(`new:override:${current().id}`)}>
                {language.t("operator.profile.addOverride")}
              </ButtonV2>
            </div>
            <Show when={current().text}>
              <details data-slot="operator-details">
                <summary>{language.t("operator.prompts.builtin")}</summary>
                <pre data-component="operator-code">{current().text}</pre>
              </details>
            </Show>
          </Show>
        </>
      )}
    </Show>
  )
}

function LayerEditor(props: {
  draft: Draft
  catalog: Catalog
  find: (id: string) => Layer | undefined
  onSelect: (key: string) => void
  onDone: (id: string | undefined) => void
  confirm: ReturnType<typeof useConfirm>
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptProfile()
  const api = useOperatorClient()
  const [store, setStore] = createStore({ draft: props.draft, busy: false })
  createEffect(
    on(
      () => props.draft,
      (draft) => setStore({ draft }),
    ),
  )
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setStore("draft", key, value)
  const projects = () => props.catalog.projects
  const goal = () => store.draft.purpose === "goal"

  const save = async () => {
    const draft = store.draft
    setStore("busy", true)
    const body = {
      name: draft.name.trim(),
      section: draft.section,
      ...(draft.purpose ? { purpose: draft.purpose } : {}),
      ...(draft.overrides ? { overrides: draft.overrides } : {}),
      projects: draft.projects === "*" ? ("*" as const) : [...draft.projects],
      agents: draft.agents
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      ...(draft.priority.trim() ? { priority: Number(draft.priority) } : {}),
      ...(draft.maxLength.trim() ? { maxLength: Number(draft.maxLength) } : {}),
      enabled: draft.enabled,
      text: draft.text,
    }
    const client = api.client().operator.promptProfile
    await (draft.id ? client.layer.update({ id: draft.id, ...body }) : client.layer.create(body))
      .then(async (result) => {
        await data.refresh()
        props.onDone(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }

  const remove = async () => {
    const draft = store.draft
    if (!draft.id) return
    const ok = await props.confirm({
      title: draft.overrides
        ? language.t("operator.profile.resetTitle", { name: draft.name })
        : language.t("operator.profile.deleteLayerTitle", { name: draft.name }),
      description: draft.overrides
        ? language.t("operator.profile.resetBody")
        : language.t("operator.profile.deleteLayerBody"),
      confirm: draft.overrides ? language.t("operator.prompts.reset") : language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.promptProfile.layer.remove({ id: draft.id })
      .then(async () => {
        await data.refresh()
        props.onDone(draft.overrides)
      })
      .catch(data.fail)
  }

  return (
    <>
      <h2 data-slot="operator-panel-title">
        {store.draft.id
          ? store.draft.name
          : goal()
            ? language.t("operator.profile.newGoal")
            : store.draft.overrides
              ? language.t("operator.profile.newOverride", { id: store.draft.overrides })
              : language.t("operator.profile.newIn", { section: names.section(store.draft.section) })}
      </h2>
      <Show when={store.draft.file}>
        {(file) => (
          <p data-slot="operator-note">
            <Tag>{language.t("operator.profile.file")}</Tag> {file()}
          </p>
        )}
      </Show>
      <Show when={store.draft.overrides}>
        {(id) => (
          <p data-slot="operator-note">
            {language.t("operator.profile.replaces")}{" "}
            <button type="button" data-slot="operator-link" onClick={() => props.onSelect(id())}>
              {id()}
            </button>
          </p>
        )}
      </Show>
      <div data-component="operator-form">
        <Field label={language.t("operator.agentForm.name")}>
          <TextInputV2
            appearance="base"
            value={store.draft.name}
            onInput={(event) => set("name", event.currentTarget.value)}
          />
        </Field>
        <Show when={store.draft.section === "purpose" && !store.draft.id}>
          <Field group label={language.t("operator.profile.purposeKind")}>
            <SegmentedControlV2
              value={store.draft.purpose ?? "org"}
              onChange={(value) => {
                if (!value) return
                set("purpose", value as "org" | "goal")
                if (value === "goal" && store.draft.projects === "*")
                  set("projects", [projects().find((item) => item.key !== OPENCODE)?.key ?? ""])
              }}
            >
              <SegmentedControlItemV2 value="org">{language.t("operator.profile.org")}</SegmentedControlItemV2>
              <SegmentedControlItemV2 value="goal">{language.t("operator.profile.goal")}</SegmentedControlItemV2>
            </SegmentedControlV2>
          </Field>
        </Show>
        <Field
          group
          label={language.t("operator.profile.scope")}
          hint={goal() ? language.t("operator.profile.goalHint") : undefined}
        >
          <ProjectScope
            value={store.draft.projects}
            projects={goal() ? projects().filter((item) => item.key !== OPENCODE) : projects()}
            single={goal()}
            disabled={!!store.draft.file}
            onChange={(value) => set("projects", value)}
          />
        </Field>
        <Field label={language.t("operator.profile.agents")} hint={language.t("operator.profile.agentsHint")}>
          <TextInputV2
            appearance="base"
            value={store.draft.agents}
            placeholder="build, plan"
            onInput={(event) => set("agents", event.currentTarget.value)}
          />
        </Field>
        <div data-slot="operator-form-row">
          <Field label={language.t("operator.profile.priority")} hint={language.t("operator.profile.priorityHint")}>
            <TextInputV2
              appearance="base"
              inputMode="numeric"
              value={store.draft.priority}
              onInput={(event) => set("priority", event.currentTarget.value)}
            />
          </Field>
          <Field label={language.t("operator.profile.maxLength")} hint={language.t("operator.profile.maxLengthHint")}>
            <TextInputV2
              appearance="base"
              inputMode="numeric"
              value={store.draft.maxLength}
              onInput={(event) => set("maxLength", event.currentTarget.value)}
            />
          </Field>
          <Field group label={language.t("operator.profile.enabled")}>
            <Switch checked={store.draft.enabled} onChange={(checked) => set("enabled", checked)}>
              {language.t("operator.profile.enabledHint")}
            </Switch>
          </Field>
        </div>
        <Field
          label={language.t("operator.prompts.text")}
          hint={language.t("operator.profile.contentHint", { count: store.draft.text.length })}
        >
          <TextareaV2
            class="operator-editor"
            rows={14}
            value={store.draft.text}
            onInput={(event) => set("text", event.currentTarget.value)}
          />
        </Field>
      </div>
      <div data-slot="operator-actions">
        <Show when={store.draft.id && !store.draft.file}>
          <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
            {store.draft.overrides ? language.t("operator.prompts.reset") : language.t("operator.agent.delete")}
          </ButtonV2>
        </Show>
        <ButtonV2
          variant="contrast"
          disabled={store.busy || !store.draft.name.trim() || (goal() && store.draft.projects === "*")}
          onClick={() => void save()}
        >
          {language.t("operator.config.save")}
        </ButtonV2>
      </div>
    </>
  )
}

function blank(fields: Partial<Draft> & { section: Section }): Draft {
  return {
    name: "",
    text: "",
    projects: "*",
    agents: "",
    enabled: true,
    priority: "50",
    maxLength: "",
    ...fields,
  }
}
