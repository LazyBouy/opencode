import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type {
  GlobalSession,
  OperatorDashboardBreakdownGroup,
  OperatorDashboardBreakdownRow,
  OperatorTelemetrySessionRow,
} from "@opencode-ai/sdk/v2/client"
import { A, useNavigate } from "@solidjs/router"
import { createMemo, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { formatAgo, formatCost, formatCount, formatDateTime, sessionFolder, shortPath } from "../../format"
import { useOperatorProjects } from "../../project"
import { type Column, DataTable } from "../../ui/data-table"
import { FieldHelp } from "../../ui/field-help"
import { BarList, type BarRow } from "../../ui/charts/bar-list"
import { Cost, Status, useDuration } from "../observability/parts"
import { hrefOf } from "./model"

// The four panels (dashboard_spec.md §8): Running now (now, whatever the range), Recent sessions, Agents and Tools
// (in the range). Each has "View all → Observability" with the matching filter. A session row opens the session
// overlay; an agent or a tool row opens Observability filtered to it. Top rows and an Other row whose sums are
// correct, never a silent cut.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Session = OperatorTelemetrySessionRow
type Breakdown = OperatorDashboardBreakdownRow
type Scope = { ns?: string; dir?: string }
const TOOL_WARN = 10

const num = (value: number | null | undefined) => (typeof value === "number" ? value : null)

function Panel(props: { id: string; title: string; help: string; view?: string; children: JSX.Element }) {
  const t = useLanguage().t
  return (
    <section data-component="operator-panel" data-slot="operator-dash-panel" aria-labelledby={`${props.id}-title`}>
      <div data-slot="operator-dash-panel-head">
        <h2 id={`${props.id}-title`} data-slot="operator-panel-title" tabindex="-1">
          {props.title}
          <FieldHelp field={props.title} text={props.help} />
        </h2>
        <Show when={props.view}>
          {(href) => (
            <A href={href()} data-slot="operator-link" data-testid={`${props.id}-view-all`}>
              {t("operator.dash.viewAll")}
            </A>
          )}
        </Show>
      </div>
      {props.children}
    </section>
  )
}

/** Telemetry off (§9.3): what the panel can't show, and where to turn it on. */
export function TelemetryOff() {
  const t = useLanguage().t
  return (
    <div data-slot="operator-panel-empty" data-testid="dash-telemetry-off">
      <span>{t("operator.dash.tile.off")}</span>{" "}
      <A href="/operator/observability?settings=1" data-slot="operator-link">
        {t("operator.dash.openSettings")}
      </A>
    </div>
  )
}

function AgentName(props: { name: string | null | undefined; type: string | null | undefined }) {
  const t = useLanguage().t
  return (
    <span class="inline-flex items-center gap-1">
      {props.name || t("operator.dash.noAgent")}
      <Show when={props.type && props.type !== "usual"}>
        <Tag>{t(`operator.obs.agentType.${props.type}` as Key)}</Tag>
      </Show>
    </span>
  )
}

function useProjectLabel() {
  const projects = useOperatorProjects()
  return (key: string | null | undefined) => {
    if (!key) return ""
    return projects().find((item) => item.directory === key)?.label ?? shortPath(key)
  }
}

export function RunningNow(props: {
  rows: ReadonlyArray<Session> | undefined
  total: number
  loading: boolean
  off: boolean
  now: number
  scope: Scope
  onOpen: (row: Session) => void
}) {
  const language = useLanguage()
  const t = language.t
  const duration = useDuration()
  const project = useProjectLabel()
  const all = () =>
    hrefOf(
      { page: "observability", params: { tab: "sessions", sessionStatus: "running,waiting", roots: "0" } },
      props.scope,
    )
  const columns: Column<Session>[] = [
    {
      id: "status",
      header: t("operator.obs.col.status"),
      help: t("operator.dash.help.runningStatus"),
      cell: (row) => <Status status={row.status} scope="session" />,
    },
    {
      id: "title",
      header: t("operator.obs.col.session"),
      help: t("operator.obs.help.session"),
      cell: (row) => (
        <span data-slot="operator-obs-session">
          <span>{row.title || row.id}</span>
          <span data-slot="operator-obs-row-actions">
            <A
              href={hrefOf({ page: "observability", params: { session: row.id } }, props.scope)}
              data-slot="operator-link"
              onClick={(event: MouseEvent) => event.stopPropagation()}
            >
              {t("operator.dash.timeline")}
            </A>
          </span>
        </span>
      ),
    },
    {
      id: "agent",
      header: t("operator.obs.col.agent"),
      help: t("operator.obs.help.agent"),
      cell: (row) => <AgentName name={row.agent} type={row.agent_type} />,
    },
    {
      id: "project",
      optional: true,
      header: t("operator.obs.col.project"),
      help: t("operator.obs.help.project"),
      cell: (row) => project(row.project_key),
    },
    {
      id: "for",
      header: t("operator.dash.col.for"),
      help: t("operator.dash.help.for"),
      align: "end",
      cell: (row) => {
        const start = num(row.turn_start_ms)
        return start === null ? "" : duration(Math.max(0, props.now - start))
      },
    },
    {
      id: "now",
      optional: true,
      header: t("operator.dash.col.now"),
      help: t("operator.dash.help.now"),
      cell: (row) => <code data-slot="operator-dash-current">{row.current ?? ""}</code>,
    },
    {
      id: "cost",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.cost"),
      help: t("operator.dash.help.sessionCost"),
      align: "end",
      cell: (row) => <Cost value={row.cost_total} />,
    },
  ]
  return (
    <Panel
      id="dash-running"
      title={t("operator.dash.panel.running")}
      help={t("operator.dash.help.running")}
      {...(props.off ? {} : { view: all() })}
    >
      <Show when={!props.off} fallback={<TelemetryOff />}>
        <DataTable
          columnsKey="dashboard-running"
          label={t("operator.dash.panel.running")}
          rows={props.rows ?? []}
          loading={props.loading}
          empty={t("operator.dash.nothingRunning")}
          onRowClick={(row) => props.onOpen(row)}
          columns={columns}
        />
        <Show when={props.total > (props.rows?.length ?? 0)}>
          <A href={all()} data-slot="operator-link" data-testid="dash-running-more">
            {t("operator.dash.moreRows", { count: props.total - (props.rows?.length ?? 0) })}
          </A>
        </Show>
      </Show>
    </Panel>
  )
}

export function RecentSessions(props: {
  rows: ReadonlyArray<Session> | undefined
  /** Telemetry off: the sessions list, without status or cost (§9.3). */
  plain: ReadonlyArray<GlobalSession> | undefined
  loading: boolean
  off: boolean
  scope: Scope
  onOpen: (id: string) => void
}) {
  const language = useLanguage()
  const t = language.t
  const project = useProjectLabel()
  const columns: Column<Session>[] = [
    {
      id: "status",
      header: t("operator.obs.col.status"),
      help: t("operator.obs.help.sessionStatus"),
      cell: (row) => <Status status={row.status} scope="session" />,
    },
    {
      id: "title",
      header: t("operator.obs.col.session"),
      help: t("operator.obs.help.session"),
      cell: (row) => row.title || row.id,
    },
    {
      id: "project",
      optional: true,
      header: t("operator.obs.col.project"),
      help: t("operator.obs.help.project"),
      cell: (row) => project(row.project_key),
    },
    {
      id: "agent",
      optional: true,
      header: t("operator.obs.col.agent"),
      help: t("operator.obs.help.agent"),
      cell: (row) => <AgentName name={row.agent} type={row.agent_type} />,
    },
    {
      id: "lastActivity",
      optional: true,
      header: t("operator.obs.col.lastActivity"),
      help: t("operator.obs.help.lastActivity"),
      align: "end",
      cell: (row) => (
        <span title={formatDateTime(num(row.last_ms) ?? undefined, language.intl())}>
          {formatAgo(num(row.last_ms) ?? undefined, language.intl())}
        </span>
      ),
    },
    {
      id: "cost",
      optional: true,
      header: t("operator.obs.col.cost"),
      help: t("operator.dash.help.sessionCost"),
      align: "end",
      cell: (row) => <Cost value={row.cost_total} />,
    },
    {
      id: "turns",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.turns"),
      help: t("operator.obs.help.turns"),
      align: "end",
      cell: (row) => formatCount(row.turns, language.intl()),
    },
    {
      id: "errors",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.errors"),
      help: t("operator.obs.help.errors"),
      align: "end",
      cell: (row) => (row.errors ? formatCount(row.errors, language.intl()) : ""),
    },
  ]
  const plainColumns: Column<GlobalSession>[] = [
    {
      id: "title",
      header: t("operator.obs.col.session"),
      help: t("operator.obs.help.session"),
      cell: (row) => row.title,
    },
    {
      id: "project",
      optional: true,
      header: t("operator.obs.col.project"),
      help: t("operator.obs.help.project"),
      cell: (row) => shortPath(sessionFolder(row)),
    },
    {
      id: "agent",
      optional: true,
      header: t("operator.obs.col.agent"),
      help: t("operator.obs.help.agent"),
      cell: (row) => row.agent ?? "",
    },
    {
      id: "updated",
      optional: true,
      header: t("operator.obs.col.lastActivity"),
      help: t("operator.obs.help.lastActivity"),
      align: "end",
      cell: (row) => formatAgo(row.time.updated, language.intl()),
    },
  ]
  return (
    <Panel
      id="dash-recent"
      title={t("operator.dash.panel.recent")}
      help={t("operator.dash.help.recent")}
      view={
        props.off ? "/operator/sessions" : hrefOf({ page: "observability", params: { tab: "sessions" } }, props.scope)
      }
    >
      <Show
        when={!props.off}
        fallback={
          <DataTable
            columnsKey="dashboard-recent-plain"
            label={t("operator.dash.panel.recent")}
            rows={props.plain ?? []}
            loading={props.loading}
            empty={t("operator.dash.noSessions")}
            onRowClick={(row) => props.onOpen(row.id)}
            columns={plainColumns}
          />
        }
      >
        <DataTable
          columnsKey="dashboard-recent"
          label={t("operator.dash.panel.recent")}
          rows={props.rows ?? []}
          loading={props.loading}
          empty={t("operator.dash.noSessions")}
          onRowClick={(row) => props.onOpen(row.id)}
          columns={columns}
        />
      </Show>
    </Panel>
  )
}

/** Agents (§8.3): sorted by turns, the top 8 and "Other (5 agents)" with their combined numbers. */
export function AgentsPanel(props: {
  group: OperatorDashboardBreakdownGroup | undefined
  loading: boolean
  off: boolean
  scope: Scope
  /** The page's range, as links carry it. */
  extra: Record<string, string>
}) {
  const language = useLanguage()
  const t = language.t
  const navigate = useNavigate()
  const duration = useDuration()
  type Row = Breakdown & { other?: ReadonlyArray<string> }
  const rows = createMemo<Row[]>(() => {
    const group = props.group
    if (!group) return []
    const other = group.other
    return [
      ...group.rows,
      ...(other
        ? [
            {
              key: "",
              label: t("operator.dash.otherAgents", { count: other.keys.length }),
              calls: other.calls,
              errors: other.errors,
              errorRate: other.errorRate,
              denials: other.denials,
              cost: other.cost,
              turns: other.turns,
              sessions: other.sessions,
              p95Active: null as unknown as number,
              lastUsed: null as unknown as number,
              other: other.keys,
            } satisfies Row,
          ]
        : []),
    ]
  })
  const percent = (value: number | null) =>
    value === null
      ? ""
      : new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 1 }).format(value / 100)
  const open = (row: Row) =>
    navigate(
      hrefOf(
        { page: "observability", params: { tab: "sessions", agent: row.other ? row.other.join(",") : row.key } },
        props.scope,
        props.extra,
      ),
    )
  const columns: Column<Row>[] = [
    {
      id: "agent",
      header: t("operator.obs.col.agent"),
      help: t("operator.dash.help.agentName"),
      cell: (row) =>
        row.other ? (
          <span data-slot="operator-dash-other">{row.label}</span>
        ) : (
          <AgentName name={row.label} type={row.type} />
        ),
    },
    {
      id: "turns",
      header: t("operator.obs.col.turns"),
      help: t("operator.dash.help.agentTurns"),
      align: "end",
      cell: (row) => formatCount(row.turns ?? 0, language.intl()),
    },
    {
      id: "errorRate",
      optional: true,
      header: t("operator.dash.col.errorRate"),
      help: t("operator.dash.help.agentErrors"),
      align: "end",
      cell: (row) => percent(num(row.errorRate)),
    },
    {
      id: "p95Active",
      optional: true,
      header: t("operator.dash.col.p95"),
      help: t("operator.dash.help.agentP95"),
      align: "end",
      cell: (row) => duration(num(row.p95Active)),
    },
    {
      id: "cost",
      optional: true,
      header: t("operator.obs.col.cost"),
      help: t("operator.dash.help.agentCost"),
      align: "end",
      cell: (row) => formatCost(row.cost, language.intl()),
    },
    {
      id: "lastUsed",
      optional: true,
      header: t("operator.dash.col.lastUsed"),
      help: t("operator.dash.help.lastUsed"),
      align: "end",
      cell: (row) => formatAgo(num(row.lastUsed) ?? undefined, language.intl()),
    },
    {
      id: "sessions",
      optional: true,
      hidden: true,
      header: t("operator.dash.col.sessions"),
      help: t("operator.dash.help.agentSessions"),
      align: "end",
      cell: (row) => formatCount(row.sessions ?? 0, language.intl()),
    },
    {
      id: "denials",
      optional: true,
      hidden: true,
      header: t("operator.dash.col.denials"),
      help: t("operator.dash.help.agentDenials"),
      align: "end",
      cell: (row) => (row.denials ? formatCount(row.denials, language.intl()) : ""),
    },
  ]
  return (
    <Panel
      id="dash-agents"
      title={t("operator.dash.panel.agents")}
      help={t("operator.dash.help.agents")}
      {...(props.off
        ? {}
        : {
            view: hrefOf({ page: "observability", params: { tab: "sessions" } }, props.scope, props.extra),
          })}
    >
      <Show when={!props.off} fallback={<TelemetryOff />}>
        <DataTable
          columnsKey="dashboard-agents"
          label={t("operator.dash.panel.agents")}
          rows={rows()}
          loading={props.loading}
          empty={t("operator.dash.noAgents")}
          onRowClick={open}
          rowAttrs={(row) => ({ "data-other": row.other ? "" : undefined })}
          columns={columns}
        />
      </Show>
    </Panel>
  )
}

/** Tools (§8.4): a ranked list by calls, MCP tools under their server; error rates over 10% warn in words too. */
export function ToolsPanel(props: {
  group: OperatorDashboardBreakdownGroup | undefined
  loading: boolean
  off: boolean
  scope: Scope
  /** The page's range, as links carry it. */
  extra: Record<string, string>
}) {
  const language = useLanguage()
  const t = language.t
  const navigate = useNavigate()
  const n = (value: number) => formatCount(value, language.intl())
  const nameOf = (row: Breakdown) => {
    if (!row.server) return row.label
    const prefix = `${row.server}_`
    return `${row.server} › ${row.label.startsWith(prefix) ? row.label.slice(prefix.length) : row.label}`
  }
  const bars = createMemo<BarRow[]>(() =>
    (props.group?.rows ?? []).map((row) => {
      const rate = num(row.errorRate)
      const warn = rate !== null && rate > TOOL_WARN
      const parts = [n(row.calls)]
      if (rate !== null && row.errors)
        parts.push(
          t(warn ? "operator.dash.toolErrorsWarn" : "operator.dash.toolErrors", {
            rate: new Intl.NumberFormat(language.intl(), { maximumFractionDigits: 1 }).format(rate),
          }),
        )
      if (row.denials) parts.push(t("operator.dash.toolDenied", { count: n(row.denials) }))
      return {
        key: row.key,
        label: nameOf(row),
        value: row.calls,
        display: parts.join("  "),
        ...(warn ? { tone: "warning" as const } : {}),
      }
    }),
  )
  const serverOf = (key: string) => props.group?.rows.find((row) => row.key === key)?.server
  const toolLink = (params: Record<string, string>) =>
    hrefOf({ page: "observability", params: { tab: "events", kind: "tool_call", ...params } }, props.scope, {
      ...props.extra,
    })
  return (
    <Panel
      id="dash-tools"
      title={t("operator.dash.panel.tools")}
      help={t("operator.dash.help.tools")}
      {...(props.off ? {} : { view: toolLink({}) })}
    >
      <Show when={!props.off} fallback={<TelemetryOff />}>
        <Show
          when={bars().length}
          fallback={
            <div data-slot="operator-panel-empty">
              {props.loading ? t("common.loading") : t("operator.dash.noTools")}
            </div>
          }
        >
          <BarList
            rows={bars()}
            label={t("operator.dash.panel.tools")}
            onOpen={(row) => {
              const server = serverOf(row.key)
              navigate(toolLink({ tool: row.key, ...(server ? { mcp: server } : {}) }))
            }}
          />
        </Show>
        <Show when={props.group?.other}>
          {(other) => (
            <A href={toolLink({})} data-slot="operator-link" data-testid="dash-tools-other">
              {t("operator.dash.otherTools", { count: other().keys.length })}
            </A>
          )}
        </Show>
      </Show>
    </Panel>
  )
}
