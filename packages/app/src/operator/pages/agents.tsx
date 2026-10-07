import { useNavigate, useSearchParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorAgent } from "@opencode-ai/sdk/v2/client"
import { useQueries, useQuery } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { useOperatorClient } from "../data"
import { formatAgo, formatCount } from "../format"
import { useOperatorProjects, useScopedProject } from "../project"
import { useOperatorScope } from "../scope"
import { useNamespaces, useProfileNames } from "./profile-data"
import { type Catalog, OPENCODE, profileFor } from "./profile-model"
import { useProjectSettings } from "./project-prompt"
import { type Column, DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { DetailOverlay } from "../ui/detail-overlay"
import { ProjectAction } from "../ui/project-action"
import { useRecordOverlay } from "../ui/record-overlay"
import { AGENT_TABS, AgentDetail } from "./agent"
import { ScopePicker } from "../ui/scope-picker"
import { FieldHelp } from "../ui/field-help"
import { ModelWithSource } from "../ui/prompt-trace"
import { useOverlayParams } from "../ui/overlay-nav"

export function useAgents() {
  const api = useOperatorClient()
  const directory = useScopedProject()
  return useQuery(() => ({
    queryKey: api.key("agents", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: directory() })
        .then((result) => result.data ?? []),
  }))
}

// An agent as the page lists it: with its project, since all projects can be shown at once.
type Row = OperatorAgent & { project: string }

// The agents of the project in `?dir=`, or of every project without one.
function usePageAgents() {
  const api = useOperatorClient()
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  const folders = () => {
    const one = scope.directory()
    return one ? [one] : projects().map((project) => project.directory)
  }
  const queries = useQueries(() => ({
    queries: folders().map((directory) => ({
      queryKey: api.key("agents", directory),
      queryFn: () =>
        api
          .client()
          .operator.agent.list({ directory })
          .then((result) => result.data ?? []),
    })),
  }))
  return {
    folders,
    pending: () => queries.some((query) => query.isPending),
    rows: createMemo<Row[]>(() =>
      folders().flatMap((project, index) => (queries[index]?.data ?? []).map((agent) => ({ ...agent, project }))),
    ),
  }
}

// Every namespace's catalog, for the profile each agent uses.
function useCatalogs() {
  const api = useOperatorClient()
  const namespaces = useNamespaces()
  const ids = () => (namespaces.data ?? []).map((item) => item.namespace.id)
  const query = useQuery(() => ({
    queryKey: api.key("prompt-catalog", "all", ids()),
    enabled: ids().length > 0,
    queryFn: () =>
      Promise.all(
        ids().map((ns) =>
          api
            .client()
            .operator.namespace.catalog({ ns })
            .then((result) => result.data!),
        ),
      ),
  }))
  return (ns: string): Catalog | undefined => query.data?.find((item) => item.namespace.id === ns)
}

export function agentModel(agent: OperatorAgent) {
  return agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : ""
}

export default function AgentsPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const scope = useOperatorScope()
  const directory = () => scope.directory()
  const projects = useOperatorProjects()
  const agents = usePageAgents()
  const [store, setStore] = persisted(Persist.global("operator.agents"), createStore({ showHidden: false }))
  const [filter, setFilter] = createStore({ text: "" })

  const rows = createMemo(() => agents.rows().filter((agent) => store.showHidden || !agent.hidden))
  // Shown on the toggle, so hidden agents can be told apart from missing ones.
  const hiddenCount = createMemo(() => agents.rows().filter((agent) => agent.hidden).length)
  // An agent opens in the overlay: `agent` and its project `adir`, and the section `atab` (`aedit`:
  // its permissions are being edited; `aperm`: the permission they are filtered to).
  const [params, setParams] = useSearchParams<{
    agent?: string
    adir?: string
    atab?: string
    aedit?: string
    aperm?: string
  }>()
  useRecordOverlay(
    () => !!params.agent,
    () => <AgentOverlay rows={rows} />,
    ["agent", "adir", "atab", "aedit", "aperm"],
  )
  const sourceLabel = (agent: OperatorAgent) => language.t(`operator.agents.source.${agent.source.kind}`)
  const projectName = (key: string) =>
    projects().find((item) => item.directory === key)?.label ?? key.split("/").filter(Boolean).at(-1) ?? key
  // The profile each agent uses: resolved from its project's namespace's catalog.
  const names = useProfileNames()
  const settings = useProjectSettings()
  const catalogOf = useCatalogs()
  const profileOf = (agent: Row) => {
    const namespace = settings.data?.find((item) => item.key === agent.project)?.namespace ?? OPENCODE
    const catalog = catalogOf(namespace)
    const found = catalog ? profileFor(catalog, agent.project, agent.name) : undefined
    return found ? { name: names.profile(found.profile), source: found.source } : undefined
  }

  const columns = (): Column<Row>[] => [
    {
      id: "name",
      header: language.t("operator.column.name"),
      value: (agent) => agent.name,
      cell: (agent) => (
        <span class="flex items-center gap-2">
          <span data-slot="operator-color-dot" style={{ background: agent.color ?? "var(--v2-icon-icon-muted)" }} />
          {agent.name}
          <Show when={agent.hidden}>
            <Tag>{language.t("operator.agents.hidden")}</Tag>
          </Show>
          <Show when={agent.disabled}>
            <Tag>{language.t("operator.agent.off")}</Tag>
          </Show>
        </span>
      ),
    },
    ...(directory()
      ? []
      : [
          {
            id: "project",
            header: language.t("operator.column.project"),
            value: (agent: Row) => projectName(agent.project),
            cell: (agent: Row) => projectName(agent.project),
          },
        ]),
    {
      id: "mode",
      optional: true,
      header: language.t("operator.column.mode"),
      value: (agent) => agent.mode,
      cell: (agent) => language.t(`operator.agents.mode.${agent.mode}`),
    },
    {
      id: "model",
      optional: true,
      header: language.t("operator.column.model"),
      value: (agent) => agent.modelSource?.model ?? agentModel(agent),
      cell: (agent) => <ModelWithSource source={agent.modelSource} compact />,
    },
    {
      id: "source",
      optional: true,
      header: language.t("operator.column.source"),
      value: sourceLabel,
      cell: (agent) => (
        <span title={agent.source.path}>
          <Tag variant={agent.source.kind === "builtin" ? "neutral" : "accent"}>{sourceLabel(agent)}</Tag>
          <Show when={agent.source.customized}>
            {" "}
            <Tag>{language.t("operator.agents.customized")}</Tag>
          </Show>
        </span>
      ),
    },
    {
      id: "profile",
      optional: true,
      header: language.t("operator.prompts.profile"),
      value: (agent) => profileOf(agent)?.name,
      cell: (agent) => (
        <Show when={profileOf(agent)}>
          {(found) => (
            <span title={language.t(`operator.prompts.source.${found().source}`)}>
              {found().name}
              <Show when={found().source !== "namespace"}>
                <span data-slot="operator-note"> · {language.t(`operator.prompts.source.${found().source}`)}</span>
              </Show>
            </span>
          )}
        </Show>
      ),
    },
    {
      id: "description",
      optional: true,
      header: language.t("operator.column.description"),
      cell: (agent) => <span data-slot="operator-cell-clamp">{agent.description ?? ""}</span>,
    },
    {
      id: "sessions",
      optional: true,
      header: language.t("operator.column.sessions"),
      align: "end",
      value: (agent) => agent.sessions.total,
      cell: (agent) => formatCount(agent.sessions.total, language.intl()),
    },
    {
      id: "lastUsed",
      optional: true,
      header: language.t("operator.column.lastUsed"),
      align: "end",
      value: (agent) => agent.sessions.lastUsed,
      cell: (agent) => formatAgo(agent.sessions.lastUsed, language.intl()),
    },
  ]

  return (
    <>
      <PageHeader
        title={language.t("operator.page.agents.title")}
        description={language.t("operator.page.agents.description")}
        actions={
          <>
            <ScopePicker all />
            <Show when={agents.folders().length}>
              <ProjectAction
                size="small"
                variant="contrast"
                label={language.t("operator.agents.new")}
                directory={directory()}
                run={(folder) => navigate(`/operator/agents/new?dir=${encodeURIComponent(folder)}`)}
              />
            </Show>
          </>
        }
      />
      <Show
        when={agents.folders().length}
        fallback={
          <EmptyState
            icon="brain"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        <div data-slot="operator-toolbar">
          <TextInputV2
            type="search"
            appearance="base"
            value={filter.text}
            onInput={(event) => setFilter("text", event.currentTarget.value)}
            placeholder={language.t("operator.agents.search")}
            aria-label={language.t("operator.agents.search")}
          />
          <span class="inline-flex items-center">
            <Switch checked={store.showHidden} onChange={(checked) => setStore("showHidden", checked)}>
              {language.t("operator.agents.showHiddenCount", { count: hiddenCount() })}
            </Switch>
            <FieldHelp field={language.t("operator.agents.showHidden")} text={language.t("operator.help.showHidden")} />
          </span>
        </div>
        <DataTable
          columnsKey="agents"
          label={language.t("operator.page.agents.title")}
          rows={rows()}
          columns={columns()}
          filter={filter.text}
          search={(agent) => `${agent.name} ${agent.description ?? ""} ${agentModel(agent)}`}
          loading={agents.pending()}
          initialSort={{ column: "name", direction: "asc" }}
          onRowClick={(agent) => setParams({ agent: agent.name, adir: agent.project, atab: undefined })}
        />
      </Show>
    </>
  )
}

// The overlay an agent opens in: its sections (Overview, Sys Prompt, Tool Prompt, Permissions,
// Sessions) on the left; ‹ › move through the agents the page lists.
function AgentOverlay(props: { rows: () => ReadonlyArray<Row> }) {
  const language = useLanguage()
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  const [params, setParams] = useOverlayParams<{
    agent?: string
    adir?: string
    atab?: string
    aedit?: string
    aperm?: string
  }>()
  const dialog = useDialog()
  const directory = () => params.adir ?? scope.directory() ?? projects()[0]?.directory ?? ""
  const tab = () => (AGENT_TABS.includes(params.atab as (typeof AGENT_TABS)[number]) ? params.atab! : "overview")
  const keyOf = (project: string, name: string) => `${project}|${name}`
  const sections = () =>
    [
      { id: "overview", icon: "eye" as const },
      { id: "prompt", icon: "prompt" as const },
      { id: "tools", icon: "code" as const },
      { id: "permissions", icon: "shield" as const },
      { id: "requests", icon: "warning" as const },
      { id: "sessions", icon: "bubble-5" as const },
      { id: "queue", icon: "enter" as const },
    ].map((item) => ({ ...item, label: language.t(`operator.agent.tab.${item.id}` as "operator.agent.tab.overview") }))
  return (
    <DetailOverlay
      title={params.agent ?? ""}
      sections={sections()}
      section={tab()}
      records={props.rows().map((row) => keyOf(row.project, row.name))}
      record={keyOf(directory(), params.agent ?? "")}
      // Editing permissions keeps the overlay on this agent and section until saved or cancelled.
      editing={params.aedit === "1"}
      onSection={(id) => setParams({ atab: id, aperm: undefined })}
      onRecord={(key) => {
        const at = key.lastIndexOf("|")
        setParams({ agent: key.slice(at + 1), adir: key.slice(0, at), aperm: undefined })
      }}
    >
      <AgentDetail
        name={params.agent ?? ""}
        directory={directory()}
        tab={tab()}
        // Deleted: the overlay closes (and the page clears its URL state).
        onGone={() => dialog.close()}
      />
    </DetailOverlay>
  )
}
