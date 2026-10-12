import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorAgent, OperatorHelper } from "@opencode-ai/sdk/v2/client"
import { useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
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
import { closeTopOverlay, useOverlayParams } from "../ui/overlay-nav"
import { Field } from "../ui/field"
import { requestError } from "./config-helpers"
import { SelectV2 } from "../ui/select"
import { TYPE_KEYS, type TypeKey, typeOf } from "./agent-type"
import { HELPER_TABS, HelperDetail, useHelperModel, useHelpers } from "./helper"

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

// An agent as the page lists it: with its project, since all projects can be shown at once. Helpers are listed
// with them (agent_types_spec.md §4.2, §5): namespace resources, with Type = Helper.
type AgentRow = OperatorAgent & { kind: "agent"; project: string }
type HelperRow = OperatorHelper & { kind: "helper" }
type Row = AgentRow | HelperRow
const rowType = (row: Row): TypeKey => (row.kind === "helper" ? "helper" : typeOf(row))

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
    rows: createMemo<AgentRow[]>(() =>
      folders().flatMap((project, index) =>
        (queries[index]?.data ?? []).map((agent) => ({ ...agent, kind: "agent" as const, project })),
      ),
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
  const [filter, setFilter] = createStore({ text: "", type: "" as TypeKey | "" })

  const settings = useProjectSettings()
  // The helpers of the project's namespace, or of every namespace.
  const helperNamespace = () => {
    const one = scope.directory()
    return one ? (settings.data?.find((item) => item.key === one)?.namespace ?? OPENCODE) : undefined
  }
  const helpers = useHelpers(helperNamespace)
  const helperRows = createMemo<HelperRow[]>(() =>
    (helpers.data ?? []).map((helper) => ({ ...helper, kind: "helper" as const })),
  )
  const agentRows = createMemo(() => agents.rows().filter((agent) => store.showHidden || !agent.hidden))
  const rows = createMemo<Row[]>(() =>
    [...agentRows(), ...helperRows()].filter((row) => !filter.type || rowType(row) === filter.type),
  )
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
    () => <AgentOverlay rows={agentRows} />,
    ["agent", "adir", "atab", "aedit", "aperm"],
  )
  // A helper opens in its own overlay: `helper` and its namespace `hns`, and the section `htab`.
  const [helperParams, setHelperParams] = useSearchParams<{ helper?: string; hns?: string; htab?: string }>()
  useRecordOverlay(
    () => !!helperParams.helper,
    () => <HelperOverlay rows={helperRows} />,
    ["helper", "hns", "htab"],
  )
  const helperModel = useHelperModel()
  const dialog = useDialog()
  const namespaces = useNamespaces()
  const namespaceName = (id: string) => namespaces.data?.find((item) => item.namespace.id === id)?.namespace.name ?? id
  const namespaceOf = (row: Row) =>
    row.kind === "helper"
      ? row.namespace
      : (settings.data?.find((item) => item.key === row.project)?.namespace ?? OPENCODE)
  const sourceLabel = (agent: OperatorAgent) => language.t(`operator.agents.source.${agent.source.kind}`)
  const helperSource = (helper: OperatorHelper) =>
    language.t(helper.builtin ? "operator.agents.source.builtin" : "operator.agents.source.helper")
  const projectName = (key: string) =>
    projects().find((item) => item.directory === key)?.label ?? key.split("/").filter(Boolean).at(-1) ?? key
  // The profile each agent uses: resolved from its project's namespace's catalog.
  const names = useProfileNames()
  const catalogOf = useCatalogs()
  const profileOf = (row: Row) => {
    const catalog = catalogOf(namespaceOf(row))
    if (row.kind === "helper") {
      const found = catalog?.profiles.find((item) => item.id === row.profile)
      return found ? { name: names.profile(found), source: "helper" as const } : undefined
    }
    const found = catalog ? profileFor(catalog, row.project, row.name) : undefined
    return found ? { name: names.profile(found.profile), source: found.source } : undefined
  }
  const typeLabel = (row: Row) => language.t(`operator.agents.type.${rowType(row)}`)
  const modelText = (row: Row) =>
    row.kind === "helper" ? helperModel(row) : (row.modelSource?.model ?? agentModel(row))
  const description = (row: Row) =>
    row.kind === "helper" && row.builtin
      ? language.t(`operator.helper.about.${row.name}` as "operator.helper.about.title")
      : (row.description ?? "")

  const columns = (): Column<Row>[] => [
    {
      id: "name",
      header: language.t("operator.column.name"),
      value: (row) => row.name,
      cell: (row) => (
        <span class="flex items-center gap-2">
          <Show
            when={row.kind === "agent" && row}
            fallback={
              <>
                <span data-slot="operator-color-dot" style={{ background: "var(--v2-icon-icon-muted)" }} />
                {row.name}
              </>
            }
          >
            {(agent) => (
              <>
                <span
                  data-slot="operator-color-dot"
                  style={{ background: agent().color ?? "var(--v2-icon-icon-muted)" }}
                />
                {agent().name}
                <Show when={agent().hidden}>
                  <Tag>{language.t("operator.agents.hidden")}</Tag>
                </Show>
                <Show when={agent().disabled}>
                  <Tag>{language.t("operator.agent.off")}</Tag>
                </Show>
              </>
            )}
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
            value: (row: Row) => (row.kind === "agent" ? projectName(row.project) : ""),
            cell: (row: Row) => (row.kind === "agent" ? projectName(row.project) : "—"),
          },
        ]),
    {
      id: "namespace",
      optional: true,
      header: language.t("operator.helper.namespace"),
      value: (row) => namespaceName(namespaceOf(row)),
      cell: (row) => namespaceName(namespaceOf(row)),
    },
    {
      id: "type",
      optional: true,
      header: language.t("operator.column.type"),
      value: typeLabel,
      cell: typeLabel,
    },
    {
      id: "model",
      optional: true,
      header: language.t("operator.column.model"),
      value: modelText,
      cell: (row) => (row.kind === "agent" ? <ModelWithSource source={row.modelSource} compact /> : helperModel(row)),
    },
    {
      id: "source",
      optional: true,
      header: language.t("operator.column.source"),
      value: (row) => (row.kind === "agent" ? sourceLabel(row) : helperSource(row)),
      cell: (row) => (
        <Show
          when={row.kind === "agent" && row}
          fallback={
            <Tag variant={row.kind === "helper" && row.builtin ? "neutral" : "accent"}>
              {row.kind === "helper" ? helperSource(row) : ""}
            </Tag>
          }
        >
          {(agent) => (
            <span title={agent().source.path}>
              <Tag variant={agent().source.kind === "builtin" ? "neutral" : "accent"}>{sourceLabel(agent())}</Tag>
              <Show when={agent().source.customized}>
                {" "}
                <Tag>{language.t("operator.agents.customized")}</Tag>
              </Show>
            </span>
          )}
        </Show>
      ),
    },
    {
      id: "profile",
      optional: true,
      header: language.t("operator.prompts.profile"),
      value: (row) => profileOf(row)?.name,
      cell: (row) => (
        <Show when={profileOf(row)}>
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
      cell: (row) => <span data-slot="operator-cell-clamp">{description(row)}</span>,
    },
    {
      id: "sessions",
      optional: true,
      header: language.t("operator.column.sessions"),
      align: "end",
      value: (row) => (row.kind === "agent" ? row.sessions.total : undefined),
      cell: (row) => (row.kind === "agent" ? formatCount(row.sessions.total, language.intl()) : ""),
    },
    {
      id: "lastUsed",
      optional: true,
      header: language.t("operator.column.lastUsed"),
      align: "end",
      value: (row) => (row.kind === "agent" ? row.sessions.lastUsed : undefined),
      cell: (row) => (row.kind === "agent" ? formatAgo(row.sessions.lastUsed, language.intl()) : ""),
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
            <ButtonV2 size="small" variant="outline" onClick={() => void dialog.show(() => <HelperSettingsDialog />)}>
              {language.t("operator.helper.settings")}
            </ButtonV2>
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
          <SelectV2<TypeKey | "">
            appearance="base"
            aria-label={language.t("operator.agents.typeFilter")}
            options={["", ...TYPE_KEYS]}
            current={filter.type}
            label={(key) => (key ? language.t(`operator.agents.type.${key}`) : language.t("operator.agents.type.all"))}
            onSelect={(key) => setFilter("type", key ?? "")}
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
          search={(row) => `${row.name} ${description(row)} ${modelText(row)}`}
          loading={agents.pending()}
          initialSort={{ column: "name", direction: "asc" }}
          onRowClick={(row) =>
            row.kind === "agent"
              ? setParams({ agent: row.name, adir: row.project, atab: undefined })
              : setHelperParams({ helper: row.name, hns: row.namespace, htab: undefined })
          }
        />
      </Show>
    </>
  )
}

// The overlay an agent opens in: its sections (Overview, Sys Prompt, Tool Prompt, Permissions,
// Sessions) on the left; ‹ › move through the agents the page lists.
function AgentOverlay(props: { rows: () => ReadonlyArray<AgentRow> }) {
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
        onGone={() => closeTopOverlay()}
      />
    </DetailOverlay>
  )
}

// The overlay a helper opens in (agent_types_spec.md §5): Overview and Text; ‹ › move through the helpers listed.
function HelperOverlay(props: { rows: () => ReadonlyArray<HelperRow> }) {
  const language = useLanguage()
  const [params, setParams] = useOverlayParams<{ helper?: string; hns?: string; htab?: string }>()
  const tab = () => (HELPER_TABS.includes(params.htab as (typeof HELPER_TABS)[number]) ? params.htab! : "overview")
  const keyOf = (ns: string, name: string) => `${ns}|${name}`
  const sections = () =>
    [
      { id: "overview", icon: "eye" as const, label: language.t("operator.agent.tab.overview") },
      { id: "text", icon: "prompt" as const, label: language.t("operator.helper.tab.text") },
      { id: "runs", icon: "bullet-list" as const, label: language.t("operator.helper.tab.runs") },
    ] as const
  return (
    <DetailOverlay
      title={params.helper ?? ""}
      sections={[...sections()]}
      section={tab()}
      records={props.rows().map((row) => keyOf(row.namespace, row.name))}
      record={keyOf(params.hns ?? "", params.helper ?? "")}
      onSection={(id) => setParams({ htab: id })}
      onRecord={(key) => {
        const at = key.indexOf("|")
        setParams({ hns: key.slice(0, at), helper: key.slice(at + 1) })
      }}
    >
      <HelperDetail
        namespace={params.hns ?? ""}
        name={params.helper ?? ""}
        tab={tab()}
        onGone={() => closeTopOverlay()}
      />
    </DetailOverlay>
  )
}

// The helper settings (agent_types_spec.md §4.7): how many days helper runs are kept.
function HelperSettingsDialog() {
  const language = useLanguage()
  const api = useOperatorClient()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const settings = useQuery(() => ({
    queryKey: api.key("helper-settings"),
    queryFn: () =>
      api
        .client()
        .operator.helper.settings()
        .then((result) => result.data!),
  }))
  const [form, setForm] = createStore({ days: "", error: "", saving: false })
  const days = () => form.days || String(settings.data?.runDays ?? "")
  const save = async () => {
    setForm({ saving: true, error: "" })
    await api
      .client()
      .operator.helper.saveSettings({ runDays: Number(days()) }, { throwOnError: true })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: api.key("helper-settings") })
        dialog.close()
      })
      .catch((error: unknown) => setForm("error", requestError(error)))
      .finally(() => setForm("saving", false))
  }
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>{language.t("operator.helper.settings")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Field label={language.t("operator.helper.runDays")} hint={language.t("operator.help.helperRunDays")}>
          <TextInputV2
            appearance="base"
            inputMode="numeric"
            value={days()}
            onInput={(event) => setForm("days", event.currentTarget.value)}
          />
        </Field>
        <Show when={form.error}>
          <p data-slot="operator-error" role="alert">
            {form.error}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={form.saving || !days()} onClick={() => void save()}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
