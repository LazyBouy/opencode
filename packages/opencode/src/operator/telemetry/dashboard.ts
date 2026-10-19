export * as OperatorTelemetryDashboard from "./dashboard"

import { OperatorTelemetryAlerts } from "./alerts"
import { OperatorTelemetryMetrics as M } from "./metrics"
import { OperatorTelemetryQuery as Q } from "./query"
import type { OperatorTelemetryStore } from "./store"

// The Dashboard's numbers (dashboard_spec.md §5, §6, §8.3–§8.4, §9.1), read from Observability's store: what needs a
// person now (the attention strip), the six golden-signal tiles with their previous period, and the breakdowns by
// agent, tool, model or project. Numbers, not sentences: the page builds the words. Links are a page and its
// parameters, never finished URLs. Tiles measure with Observability's metric lines (metrics.ts), so they agree with
// its Metrics tab; past the detailed window they read hourly totals (≈).

type Store = OperatorTelemetryStore.Store
type Clause = Q.Clause
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export type Link = { page: "inbox" | "observability" | "capabilities"; params: Record<string, string> }
export const ITEMS = [
  "approvals",
  "alerts",
  "errors",
  "stuck",
  "loops",
  "rate_limited",
  "mcp",
  "queue",
  "budget",
  "telemetry",
] as const
export type ItemKind = (typeof ITEMS)[number]
export type Item = {
  kind: ItemKind
  severity: "critical" | "warning"
  count: number
  /** The worst case: its name, age or status; for alerts, how many are critical; for the budget, the amounts. */
  worst: { label?: string; ageMs?: number; status?: string; amount?: number; limit?: number; critical?: number }
  /** An alert firing covers this item (it isn't counted again under alerts). */
  alert: boolean
  link: Link
}
export type Scope = { ns?: string; dir?: string }

const scopeOf = (scope: Scope, context: Q.Context, column = "project_key"): Clause => {
  const clauses = Q.scope(scope, context, column)
  return clauses[0] ?? { sql: "1 = 1", params: [] }
}

// ---- attention (§5) ----

export type FiringAlert = {
  id: string
  name: string
  severity: string
  metric: string
  scope: Record<string, string>
  ack_ms: number | null
  muted: boolean
  start_ms: number
}

// Built-in alerts that watch what an item already shows (§5.1 Duplicates).
const COVERS: Partial<Record<string, ItemKind>> = {
  oldest_approval: "approvals",
  rate_limits: "rate_limited",
  loops: "loops",
  mcp_down: "mcp",
  cost: "budget",
  oldest_queued: "queue",
}
const UP = new Set(["connected", "disabled"])
const CRITICAL_WAIT = 30 * MIN
const RUNNING_ROWS = 6

export function attention(
  store: Store,
  input: {
    scope: Scope
    context: Q.Context
    enabled: boolean
    stuckMinutes: number
    queueMinutes: number
    dailyBudget: number | undefined
    dropped: number
    backfill?: { done: number; total: number }
    alerts: ReadonlyArray<FiringAlert>
    /** Folders in use (their MCP servers are known, §5.9 of the observability spec). */
    activeFolders: ReadonlySet<string>
  },
) {
  const now = input.context.now
  const scope = scopeOf(input.scope, input.context)
  const items: Item[] = []
  const one = <T>(sql: string, ...params: Array<string | number>) =>
    store.db.query(sql).get(...scope.params, ...params) as T
  const all = <T>(sql: string, ...params: Array<string | number>) =>
    store.db.query(sql).all(...scope.params, ...params) as T[]
  const where = `(${scope.sql})`

  if (input.enabled) {
    // Approvals waiting: open waits, oldest first.
    const waits = all<{ request_id: string | null; start_ms: number }>(
      `SELECT request_id, start_ms FROM span WHERE ${where} AND kind = 'permission_wait' AND status = 'running' ORDER BY start_ms`,
    )
    if (waits.length) {
      const age = now - waits[0]!.start_ms
      items.push({
        kind: "approvals",
        severity: age > CRITICAL_WAIT ? "critical" : "warning",
        count: waits.length,
        worst: { ageMs: age },
        alert: false,
        link: {
          page: "inbox",
          params: waits.length === 1 && waits[0]!.request_id ? { ask: waits[0]!.request_id } : {},
        },
      })
    }
    // Sessions whose latest turn failed, with activity in the last 24 hours (top sessions).
    const failed = all<{ id: string; title: string | null }>(
      `SELECT id, title FROM session_row WHERE ${where} AND parent_id IS NULL AND status IN ('error', 'interrupted', 'denied')
       AND last_ms >= ? ORDER BY last_ms DESC`,
      now - DAY,
    )
    if (failed.length)
      items.push({
        kind: "errors",
        severity: "warning",
        count: failed.length,
        worst: { ...(failed[0]!.title ? { label: failed[0]!.title } : {}) },
        alert: false,
        link: {
          page: "observability",
          params:
            failed.length === 1
              ? { session: failed[0]!.id }
              : { tab: "sessions", sessionStatus: "error,interrupted,denied", range: "24h" },
        },
      })
    // Stuck: running, no new span for the threshold, no approval waiting (that would be "waiting").
    const stuck = all<{ id: string; last_ms: number }>(
      `SELECT id, last_ms FROM session_row WHERE ${where} AND parent_id IS NULL AND status = 'running' AND last_ms < ?
       ORDER BY last_ms`,
      now - input.stuckMinutes * MIN,
    )
    if (stuck.length)
      items.push({
        kind: "stuck",
        severity: "warning",
        count: stuck.length,
        worst: { ageMs: now - stuck[0]!.last_ms },
        alert: false,
        link: {
          page: "observability",
          params: stuck.length === 1 ? { session: stuck[0]!.id } : { tab: "sessions", stuck: "1" },
        },
      })
    // Possible loops in the last 24 hours.
    const loops = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM span WHERE ${where} AND kind = 'turn' AND loop IS NOT NULL AND COALESCE(end_ms, start_ms) >= ?`,
      now - DAY,
    ).n
    if (loops)
      items.push({
        kind: "loops",
        severity: "warning",
        count: loops,
        worst: {},
        alert: false,
        link: { page: "observability", params: { tab: "events", kind: "turn", loop: "1", range: "24h" } },
      })
    // Rate limited: 429s in the last 15 minutes, by provider.
    const limited = all<{ provider: string | null; n: number }>(
      `SELECT provider, COUNT(*) AS n FROM span WHERE ${where} AND kind IN ('model_call', 'retry') AND http_status = 429
       AND start_ms >= ? GROUP BY provider ORDER BY n DESC`,
      now - 15 * MIN,
    )
    const total429 = limited.reduce((sum, row) => sum + row.n, 0)
    if (total429)
      items.push({
        kind: "rate_limited",
        severity: "warning",
        count: total429,
        worst: { ...(limited[0]!.provider ? { label: limited[0]!.provider } : {}) },
        alert: false,
        link: { page: "observability", params: { tab: "events", http: "429", range: "15m" } },
      })
  }
  // MCP servers down: the latest status of each server in a folder in use.
  const mcpScope = scopeOf(input.scope, input.context, "directory")
  const statuses = store.db
    .query(`SELECT directory, server, status, time_ms FROM mcp_status WHERE (${mcpScope.sql}) ORDER BY time_ms`)
    .all(...mcpScope.params) as Array<{ directory: string; server: string; status: string; time_ms: number }>
  const latest = new Map<string, { directory: string; server: string; status: string; since: number }>()
  for (const row of statuses) {
    if (!input.activeFolders.has(row.directory)) continue
    const key = `${row.directory}\u0000${row.server}`
    const before = latest.get(key)
    const since = before && !UP.has(before.status) && !UP.has(row.status) ? before.since : row.time_ms
    latest.set(key, { directory: row.directory, server: row.server, status: row.status, since })
  }
  const down = [...latest.values()].filter((row) => !UP.has(row.status)).toSorted((a, b) => a.since - b.since)
  if (down.length)
    items.push({
      kind: "mcp",
      severity: "critical",
      count: down.length,
      worst: { label: down[0]!.server, status: down[0]!.status, ageMs: now - down[0]!.since },
      alert: false,
      // The project's MCP tab, with the server open (where it can be signed in or reconnected).
      link: {
        page: "capabilities",
        params: { dir: down[0]!.directory, tab: "mcp", kind: "mcp", item: down[0]!.server },
      },
    })
  // Queue backed up: the last samples (every minute) of the projects in scope.
  const queueScope = scopeOf(input.scope, input.context, "json_extract(dims, '$.project')")
  const sampled = (name: string) => {
    const time = store.db
      .query("SELECT MAX(time_ms) AS t FROM sample WHERE name = ? AND time_ms >= ?")
      .get(name, now - 3 * MIN) as { t: number | null }
    if (time.t === null) return []
    return store.db
      .query(`SELECT value FROM sample WHERE name = ? AND time_ms = ? AND (${queueScope.sql})`)
      .all(name, time.t, ...queueScope.params) as Array<{ value: number }>
  }
  const oldest = Math.max(0, ...sampled("queue_oldest_ms").map((row) => row.value))
  if (oldest > input.queueMinutes * MIN)
    items.push({
      kind: "queue",
      severity: "warning",
      count: sampled("queue_depth").reduce((sum, row) => sum + row.value, 0),
      worst: { ageMs: oldest },
      alert: false,
      link: { page: "observability", params: { tab: "events", kind: "queue_item", status: "running" } },
    })
  // Over budget today.
  if (input.enabled && input.dailyBudget !== undefined) {
    const today = costToday(store, input.scope, input.context)
    if (today > input.dailyBudget)
      items.push({
        kind: "budget",
        severity: "warning",
        count: 1,
        worst: { amount: today, limit: input.dailyBudget },
        alert: false,
        link: { page: "observability", params: { tab: "metrics", section: "tokens", range: "24h" } },
      })
  }
  // Telemetry problems.
  if (!input.enabled || input.dropped > 0)
    items.push({
      kind: "telemetry",
      severity: "warning",
      count: input.enabled ? input.dropped : 1,
      worst: { status: input.enabled ? "dropped" : "off" },
      alert: false,
      link: { page: "observability", params: { settings: "1" } },
    })

  // Alerts firing, not acknowledged, not muted, in scope; one an item covers marks that item instead.
  const inScope = (alert: FiringAlert) =>
    (!alert.scope.dir && !alert.scope.ns) ||
    (input.scope.dir ? alert.scope.dir === input.scope.dir : input.scope.ns ? alert.scope.ns === input.scope.ns : true)
  const firing = input.alerts.filter((alert) => alert.ack_ms === null && !alert.muted && inScope(alert))
  const rest = firing.filter((alert) => {
    const covered = items.find((item) => item.kind === COVERS[alert.metric])
    if (covered) covered.alert = true
    return !covered
  })
  if (rest.length) {
    const critical = rest.filter((alert) => alert.severity === "critical")
    const worst = (critical.length ? critical : rest).toSorted((a, b) => a.start_ms - b.start_ms)[0]!
    items.splice(items[0]?.kind === "approvals" ? 1 : 0, 0, {
      kind: "alerts",
      severity: critical.length ? "critical" : "warning",
      count: rest.length,
      worst: { label: worst.name, critical: critical.length },
      alert: false,
      link: { page: "observability", params: { tab: "alerts" } },
    })
  }
  const running = (
    store.db
      .query(
        `SELECT COUNT(*) AS n FROM session_row WHERE (${scope.sql}) AND parent_id IS NULL AND status IN ('running', 'waiting')`,
      )
      .get(...scope.params) as { n: number }
  ).n
  // Running now (§8.1): sessions running or waiting, subagents and helpers too, the longest-running turn first (stuck
  // work rises), whatever their last activity. It refreshes with the strip, so it comes with it.
  const runningNow = input.enabled
    ? Q.sessions(
        store,
        { ...input.scope, from: 0, to: now + 1, sessionStatus: "running,waiting", roots: "0" },
        input.context,
        { sort: "turnStart:asc", limit: RUNNING_ROWS },
      )
    : { rows: [], total: 0 }
  return {
    items: items.toSorted((a, b) => ITEMS.indexOf(a.kind) - ITEMS.indexOf(b.kind)),
    running,
    runningNow: { rows: runningNow.rows, total: runningNow.total },
    telemetry: {
      enabled: input.enabled,
      dropped: input.dropped,
      ...(input.backfill ? { backfill: input.backfill } : {}),
    },
  }
}

/** Cost since local midnight, in scope. */
export function costToday(store: Store, scope: Scope, context: Q.Context) {
  const from = OperatorTelemetryAlerts.windowStart("today", context.now)
  const where = Q.spanWhere({ ...scope, from, to: context.now + 1 }, context)
  return (
    (
      store.db
        .query(
          `SELECT SUM(COALESCE(cost, 0)) AS v FROM span WHERE (${where.sql}) AND kind IN ('model_call', 'helper_run')`,
        )
        .get(...where.params) as { v: number | null }
    ).v ?? 0
  )
}

// ---- tiles (§6) ----

export const RANGES: Record<string, number> = { "24h": DAY, "7d": 7 * DAY, "14d": 14 * DAY, "30d": 30 * DAY }
/** A sparkline's step (§6.3): 24 points for a day, 28 for a week or two, 30 for a month. */
export function stepFor(length: number) {
  return length <= DAY ? HOUR : length <= 7 * DAY ? 6 * HOUR : length <= 14 * DAY ? 12 * HOUR : DAY
}
export const TILES = ["turns", "turnErrors", "turnTime", "approvalWait", "rateLimits", "cost"] as const
export type TileId = (typeof TILES)[number]
export type Change = { kind: "relative" | "points" | "same" | "insufficient"; value?: number }
export type Tile<Hint = Record<string, unknown>> = {
  value: number | null
  previous: number | null
  change: Change
  /** The numbers the tile's hint line says (the page builds the words). */
  hint: Hint
  series: Array<[number, number | null]>
  approx: boolean
}
/** The fewest earlier events for a comparison of a rate or percentile (§6.2). */
export const MIN_EARLIER = 10

type Period = { from: number; to: number }
type Measured = { cells: M.Cell[]; total: M.Cell | undefined; times: number[]; totals: boolean }

/** A line over a period, a cell per step and their sum; undefined when hourly totals can't give it. */
function measure(
  store: Store,
  line: M.Line,
  period: Period,
  step: number,
  scope: Scope,
  context: Q.Context,
  eventsDays: number,
): Measured | undefined {
  const totals = period.from < context.now - eventsDays * DAY
  if (totals && !line.totals) return undefined
  const from = totals ? Math.floor(period.from / HOUR) * HOUR : period.from
  const size = totals ? Math.max(HOUR, Math.round(step / HOUR) * HOUR) : step
  const count = Math.max(1, Math.ceil((period.to - from) / size))
  const frame: M.Frame = { from, to: from + count * size, step: size, count }
  const where = totals
    ? M.totalsWhere(scope, context, frame).where
    : Q.spanWhere({ ...scope, from: period.from, to: period.to }, context)
  const cells = M.read({ store, frame, where, totals }, line, undefined).get("") ?? []
  const total = M.blank()
  for (const cell of cells) M.merge(total, cell)
  return { cells, total, times: Array.from({ length: count }, (_, at) => from + at * size), totals }
}

const sizeOf = (cell: M.Cell | undefined) =>
  cell ? cell.d || cell.list.length || cell.hist.reduce((sum, value) => sum + (value ?? 0), 0) : 0
const valueOf = (agg: M.Agg, measured: Measured | undefined) =>
  measured ? M.valueOf(agg, sizeOf(measured.total) || agg === "sum" ? measured.total : undefined) : null

export function changeOf(
  kind: "relative" | "points",
  value: number | null,
  previous: number | null,
  earlier?: number,
): Change {
  if (value === null || previous === null) return { kind: "insufficient" }
  if (earlier !== undefined && earlier < MIN_EARLIER) return { kind: "insufficient" }
  if (kind === "points") {
    const diff = value - previous
    return Math.abs(diff) < 0.1 ? { kind: "same" } : { kind: "points", value: diff }
  }
  if (previous === 0) return value === 0 ? { kind: "same" } : { kind: "insufficient" }
  const relative = ((value - previous) / previous) * 100
  return Math.abs(relative) < 1 ? { kind: "same" } : { kind: "relative", value: relative }
}

const FINISHED = "status != 'running'"
const TOKENS_SPAN =
  "COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_reasoning, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0)"
const TOKENS_TOTALS = "tokens_input + tokens_output + tokens_reasoning + tokens_cache_read + tokens_cache_write"
const LINES = {
  turns: M.count("turns", ["turn"]),
  errors: M.share("errors", ["turn"], FINISHED, "status IN ('error', 'interrupted')"),
  denied: M.share("denied", ["turn"], FINISHED, "status = 'denied'"),
  toolErrors: M.share("tool_errors", ["tool_call"], "status NOT IN ('running', 'denied')", "status = 'error'"),
  turnTime: M.pct("p95", "p95", ["turn"], "active_ms", "status = 'ok'", "hist_active"),
  ttft: M.pct("p95", "p95", ["model_call"], "ttft_ms", undefined, "hist_ttft"),
  approvalWait: M.pct("p95", "p95", ["permission_wait"], "COALESCE(wait_ms, duration_ms)", FINISHED, "hist_wait"),
  approvalDenied: { key: "denied", kinds: ["permission_wait"], agg: "sum", value: "1", where: "decision = 'deny'" },
  rateLimits: {
    key: "http_429",
    kinds: ["model_call", "retry"],
    agg: "sum",
    value: "1",
    where: "http_status = 429",
    totals: { value: "http_429" },
  },
  retries: M.count("retries", ["retry"]),
  compactions: M.count("compactions", ["compaction"]),
  cost: M.sumOf("cost", ["model_call", "helper_run"], "cost", "cost + cost_side"),
  tokens: M.sumOf("tokens", ["model_call"], TOKENS_SPAN, TOKENS_TOTALS),
} satisfies Record<string, M.Line>

const seriesOf = (measured: Measured | undefined, agg: M.Agg): Array<[number, number | null]> =>
  measured ? measured.times.map((time, at) => [time, M.valueOf(agg, measured.cells[at])]) : []

/**
 * Inside the detailed window: turns, model calls and approvals read once each (with helper cost and retry 429s),
 * worked out in one pass into the same cells the metric lines give (counts, ratios, value lists), plus the hint numbers
 * only rows have: distinct sessions, first-token times, context by model, the tool error rate.
 */
/** A model's context window in tokens, when known (models.dev). */
export type LimitOf = (provider: string, model: string) => number | undefined

function fromRows(store: Store, where: Clause, period: Period, step: number, limitOf: LimitOf) {
  const count = Math.max(1, Math.ceil((period.to - period.from) / step))
  const times = Array.from({ length: count }, (_, at) => period.from + at * step)
  const cells = () => Array.from({ length: count }, M.blank)
  const at = (time: number) => {
    const index = Math.floor((time - period.from) / step)
    return index >= 0 && index < count ? index : -1
  }
  const turns = cells()
  const errors = cells()
  const denied = cells()
  const time = cells()
  const sessions = new Set<string>()
  // Rows as arrays (cheaper to bring out than objects): start, status, session, active time.
  for (const [t, status, id, active] of store.db
    .query(`SELECT start_ms, status, session_id, active_ms FROM span WHERE (${where.sql}) AND kind = 'turn'`)
    .values(...where.params) as Array<[number, string, string | null, number | null]>) {
    const index = at(t)
    if (index < 0) continue
    turns[index]!.v++
    if (status !== "running") {
      errors[index]!.d++
      denied[index]!.d++
      if (status === "error" || status === "interrupted") errors[index]!.v++
      if (status === "denied") denied[index]!.v++
    }
    if (status === "ok" && active !== null) time[index]!.list.push(active)
    if (id) sessions.add(id)
  }
  const cost = cells()
  const tokens = cells()
  const limits = cells()
  const ttft: number[] = []
  // Each call's context as a share of its model's window (calls to models without a known window are left out).
  const shares: number[] = []
  // Start, cost, tokens, HTTP status, first token, context, provider, model.
  for (const [t, c, k, h, f, x, p, m] of store.db
    .query(
      `SELECT start_ms, cost, ${TOKENS_SPAN}, http_status, ttft_ms, context_tokens, provider, model
       FROM span WHERE (${where.sql}) AND kind = 'model_call'`,
    )
    .values(...where.params) as Array<
    [number, number | null, number, number | null, number | null, number | null, string | null, string | null]
  >) {
    const index = at(t)
    if (index < 0) continue
    cost[index]!.v += c ?? 0
    tokens[index]!.v += k
    if (h === 429) limits[index]!.v++
    if (f !== null) ttft.push(f)
    if (x !== null && x > 0 && p && m) {
      const limit = limitOf(p, m)
      if (limit) shares.push((x / limit) * 100)
    }
  }
  const wait = cells()
  const waitDenied = cells()
  // Start, status, wait, decision (the approvalWait and approvalDenied lines).
  for (const [t, status, w, decision] of store.db
    .query(
      `SELECT start_ms, status, COALESCE(wait_ms, duration_ms), decision FROM span
       WHERE (${where.sql}) AND kind = 'permission_wait'`,
    )
    .values(...where.params) as Array<[number, string, number | null, string | null]>) {
    const index = at(t)
    if (index < 0) continue
    if (status !== "running" && w !== null) wait[index]!.list.push(w)
    if (decision === "deny") waitDenied[index]!.v++
  }
  for (const row of store.db
    .query(`SELECT start_ms AS t, cost AS c FROM span WHERE (${where.sql}) AND kind = 'helper_run'`)
    .all(...where.params) as Array<{ t: number; c: number | null }>) {
    const index = at(row.t)
    if (index >= 0) cost[index]!.v += row.c ?? 0
  }
  for (const row of store.db
    .query(`SELECT start_ms AS t FROM span WHERE (${where.sql}) AND kind = 'retry' AND http_status = 429`)
    .all(...where.params) as Array<{ t: number }>) {
    const index = at(row.t)
    if (index >= 0) limits[index]!.v++
  }
  const measured = (list: M.Cell[]): Measured => {
    const total = M.blank()
    for (const cell of list) M.merge(total, cell)
    return { cells: list, total, times, totals: false }
  }
  // Tool calls by status from the tool index alone (every tool call names its tool), not a row per call.
  const [all, running, refused, failed] = store.db
    .query(
      `SELECT COUNT(*), SUM(status = 'running'), SUM(status = 'denied'), SUM(status = 'error')
       FROM span INDEXED BY span_tool_cover WHERE (${where.sql}) AND tool IS NOT NULL AND kind = 'tool_call'`,
    )
    .values(...where.params)[0] as [number, number | null, number | null, number | null]
  const finished = all - (running ?? 0) - (refused ?? 0)
  return {
    turns: measured(turns),
    errors: measured(errors),
    denied: measured(denied),
    time: measured(time),
    cost: measured(cost),
    tokens: measured(tokens),
    limits: measured(limits),
    wait: measured(wait),
    waitDenied: measured(waitDenied),
    toolErrorRate: finished ? ((failed ?? 0) / finished) * 100 : null,
    sessions: sessions.size,
    ttftP95: M.percentile(ttft, 0.95),
    contextP95: M.percentile(shares, 0.95),
  }
}

/** The six tiles over a range, each with its previous period of the same length (§6). */
export function tiles(
  store: Store,
  input: {
    filter: Q.Filter
    scope: Scope
    context: Q.Context
    eventsDays: number
    dailyBudget: number | undefined
    limitOf?: LimitOf
  },
) {
  const now = input.context.now
  const window = Q.window(input.filter, now)
  const length =
    input.filter.from === undefined && input.filter.to === undefined
      ? (RANGES[input.filter.range ?? "14d"] ?? window.to - window.from)
      : window.to - window.from
  const current: Period = { from: window.to - length, to: window.to }
  const before: Period = { from: current.from - length, to: current.from }
  const step = stepFor(length)
  const run = (line: M.Line, period: Period, size: number) =>
    measure(store, line, period, size, input.scope, input.context, input.eventsDays)
  const now_ = (line: M.Line) => run(line, current, step)
  const then = (line: M.Line) => run(line, before, length)
  const approx = (measured: Measured | undefined) => !!measured?.totals

  // Inside the detailed window, rows read once per kind; past it, hourly totals through the metric lines (≈).
  const inWindow = (period: Period) => period.from >= now - input.eventsDays * DAY
  const scopedOf = (period: Period) => Q.spanWhere({ ...input.scope, from: period.from, to: period.to }, input.context)
  const scoped = scopedOf(current)
  const events = inWindow(current)
  const limitOf = input.limitOf ?? (() => undefined)
  const rows = events ? fromRows(store, scoped, current, step, limitOf) : undefined
  const earlier = inWindow(before) ? fromRows(store, scopedOf(before), before, length, limitOf) : undefined
  const turns = rows?.turns ?? now_(LINES.turns)
  const turnsBefore = earlier?.turns ?? then(LINES.turns)
  const errors = rows?.errors ?? now_(LINES.errors)
  const errorsBefore = earlier?.errors ?? then(LINES.errors)
  const denied = rows?.denied ?? now_(LINES.denied)
  const time = rows?.time ?? now_(LINES.turnTime)
  const timeBefore = earlier?.time ?? then(LINES.turnTime)
  const wait = rows?.wait ?? now_(LINES.approvalWait)
  const waitBefore = earlier?.wait ?? then(LINES.approvalWait)
  const waitDenied = rows?.waitDenied ?? now_(LINES.approvalDenied)
  const limits = rows?.limits ?? now_(LINES.rateLimits)
  const limitsBefore = earlier?.limits ?? then(LINES.rateLimits)
  const retries = now_(LINES.retries)
  const compactions = now_(LINES.compactions)
  const cost = rows?.cost ?? now_(LINES.cost)
  const costBefore = earlier?.cost ?? then(LINES.cost)
  const tokens = rows?.tokens ?? now_(LINES.tokens)
  const sessions = rows ? rows.sessions : null
  const scope = scopeOf(input.scope, input.context)
  const running = (
    store.db
      .query(
        `SELECT COUNT(*) AS n FROM session_row WHERE (${scope.sql}) AND parent_id IS NULL AND status IN ('running', 'waiting')`,
      )
      .get(...scope.params) as { n: number }
  ).n
  const waiting = (
    store.db
      .query(`SELECT COUNT(*) AS n FROM span WHERE (${scope.sql}) AND kind = 'permission_wait' AND status = 'running'`)
      .get(...scope.params) as { n: number }
  ).n
  // Context used: p95 across model calls of context tokens ÷ the model's window (§6.1); only rows have it.
  const contextP95 = rows ? rows.contextP95 : null
  // First token: only recorded calls have it (§6.1); none means no recording.
  const ttftP95 = rows ? rows.ttftP95 : valueOf("p95", now_(LINES.ttft))
  const toolErrorRate = rows ? rows.toolErrorRate : valueOf("ratio", now_(LINES.toolErrors))

  const value = {
    turns: valueOf("sum", turns),
    errors: valueOf("ratio", errors),
    time: valueOf("p95", time),
    wait: valueOf("p95", wait),
    limits: valueOf("sum", limits),
    cost: valueOf("sum", cost),
  }
  const previous = {
    turns: valueOf("sum", turnsBefore),
    errors: valueOf("ratio", errorsBefore),
    time: valueOf("p95", timeBefore),
    wait: valueOf("p95", waitBefore),
    limits: valueOf("sum", limitsBefore),
    cost: valueOf("sum", costBefore),
  }
  const out = {
    turns: {
      value: value.turns,
      previous: previous.turns,
      change: changeOf("relative", value.turns, previous.turns),
      hint: { sessions, running },
      series: seriesOf(turns, "sum"),
      approx: false,
    },
    turnErrors: {
      value: value.errors,
      previous: previous.errors,
      change: changeOf("points", value.errors, previous.errors, sizeOf(errorsBefore?.total)),
      hint: {
        failed: errors?.total?.v ?? null,
        denied: denied?.total?.v ?? null,
        toolErrorRate,
      },
      series: seriesOf(errors, "ratio"),
      approx: false,
    },
    turnTime: {
      value: value.time,
      previous: previous.time,
      change: changeOf("relative", value.time, previous.time, sizeOf(timeBefore?.total)),
      hint: {
        p50: valueOf("p50", time),
        // No recorded calls: no first token (§6.1).
        ttftP95,
      },
      series: seriesOf(time, "p95"),
      approx: approx(time),
    },
    approvalWait: {
      value: value.wait,
      previous: previous.wait,
      change: changeOf("relative", value.wait, previous.wait, sizeOf(waitBefore?.total)),
      hint: { requests: sizeOf(wait?.total), denied: waitDenied?.total?.v ?? null, waiting },
      series: seriesOf(wait, "p95"),
      approx: approx(wait),
    },
    rateLimits: {
      value: value.limits,
      previous: previous.limits,
      change: changeOf("relative", value.limits, previous.limits),
      hint: {
        retries: retries?.total?.v ?? null,
        compactions: compactions?.total?.v ?? null,
        contextP95,
      },
      series: seriesOf(limits, "sum"),
      approx: false,
    },
    cost: {
      value: value.cost,
      previous: previous.cost,
      change: changeOf("relative", value.cost, previous.cost),
      hint: { tokens: tokens?.total?.v ?? null },
      series: seriesOf(cost, "sum"),
      approx: false,
    },
  } satisfies Record<TileId, Tile<unknown>>
  return {
    tiles: out,
    budget:
      input.dailyBudget !== undefined
        ? { today: costToday(store, input.scope, input.context), limit: input.dailyBudget }
        : null,
    source: events ? ("events" as const) : ("totals" as const),
    step,
    from: current.from,
    to: current.to,
  }
}

// ---- breakdowns (§8.3, §8.4) ----

export const BY = ["agent", "tool", "model", "project"] as const
export type By = (typeof BY)[number]
export const isBy = (value: string): value is By => (BY as ReadonlyArray<string>).includes(value)
export type Row = {
  key: string
  label: string
  type?: string
  /** A tool's MCP server. */
  server?: string
  /** Agents, models, projects (not tools: their panel doesn't show them). */
  turns?: number
  calls: number
  errors: number
  errorRate: number | null
  denials: number
  p95Active: number | null
  cost: number
  sessions?: number
  lastUsed: number | null
}

// A tool's key in SQL: its MCP server and its name, joined by the unit separator (char 31).
const SEPARATOR = "\u001f"

/**
 * A percentile worked out by SQLite: the count, then the one value at that position in order, so no rows are brought
 * out (the same nearest-rank percentile as metrics.ts).
 */
export function percentileIn(
  store: Store,
  input: { sql: string; params: Array<string | number>; value: string; p: number; count?: number },
) {
  const where = `${input.sql} AND (${input.value}) IS NOT NULL`
  const count =
    input.count ??
    (store.db.query(`SELECT COUNT(*) AS n FROM span WHERE ${where}`).get(...input.params) as { n: number }).n
  if (!count) return null
  const offset = Math.min(count - 1, Math.max(0, Math.ceil(input.p * count) - 1))
  const row = store.db
    .query(`SELECT ${input.value} AS v FROM span WHERE ${where} ORDER BY ${input.value} LIMIT 1 OFFSET ?`)
    .get(...input.params, offset) as { v: number } | null
  return row?.v ?? null
}

/** Agents, tools, models or projects in the range: the top `limit` and an Other row with the rest's sums. */
export function breakdown(store: Store, input: { by: By; limit: number; filter: Q.Filter; context: Q.Context }) {
  const where = Q.spanWhere(input.filter, input.context)
  const base = `(${where.sql})`
  const params = where.params
  // Grouped on plain columns (a tool by its MCP server and name), one small query per kind of span.
  const group =
    input.by === "agent"
      ? "agent"
      : input.by === "model"
        ? "model"
        : input.by === "project"
          ? "project_key"
          : "mcp_server, tool"
  const keyOf = (row: { a: string | null; b?: string | null }) =>
    input.by === "tool" ? `${row.a ?? ""}${SEPARATOR}${row.b ?? ""}` : (row.a ?? "")
  const select = input.by === "tool" ? "mcp_server AS a, tool AS b" : `${group} AS a`
  type Acc = {
    key: string
    type: string | null
    turns: number
    calls: number
    finished: number
    errors: number
    denials: number
    cost: number
    sessions: number
    ok: number
    runs: number
    last: number | null
  }
  const acc = new Map<string, Acc>()
  const at = (key: string) => {
    let found = acc.get(key)
    if (!found) {
      found = {
        key,
        type: null,
        turns: 0,
        calls: 0,
        finished: 0,
        errors: 0,
        denials: 0,
        cost: 0,
        sessions: 0,
        ok: 0,
        runs: 0,
        last: null,
      }
      acc.set(key, found)
    }
    return found
  }
  const later = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))
  type Got = { a: string | null; b?: string | null } & Record<string, number | string | null>
  const rows = (sql: string) => store.db.query(sql).all(...params) as Got[]
  if (input.by === "tool") {
    for (const row of rows(
      // From the tool index alone (store.ts v5): it holds everything this reads, unless a scope or text filter applies.
      `SELECT ${select}, COUNT(*) AS calls, SUM(status NOT IN ('running', 'denied')) AS finished,
         SUM(status = 'error') AS errors, SUM(status = 'denied') AS denials, SUM(status = 'ok') AS ok, MAX(start_ms) AS last
       FROM span INDEXED BY span_tool_cover WHERE tool IS NOT NULL AND ${base} AND kind = 'tool_call' GROUP BY ${group}`,
    )) {
      const item = at(keyOf(row))
      Object.assign(item, {
        calls: row.calls,
        finished: row.finished,
        errors: row.errors,
        denials: row.denials,
        ok: row.ok,
        last: row.last,
      })
    }
  } else if (input.by === "model") {
    for (const row of rows(
      `SELECT ${select}, COUNT(*) AS calls, SUM(status != 'running') AS finished, SUM(status = 'error') AS errors,
         SUM(status = 'ok') AS ok, SUM(COALESCE(cost, 0)) AS cost, COUNT(DISTINCT turn_id) AS turns,
         COUNT(DISTINCT session_id) AS sessions, MAX(start_ms) AS last
       FROM span WHERE ${base} AND kind = 'model_call' GROUP BY ${group}`,
    ))
      Object.assign(at(keyOf(row)), {
        calls: row.calls,
        finished: row.finished,
        errors: row.errors,
        ok: row.ok,
        cost: row.cost,
        turns: row.turns,
        sessions: row.sessions,
        last: row.last,
      })
  } else {
    // Turns: their counts, errors, sessions; then calls and cost; then denials.
    for (const row of rows(
      `SELECT ${select}, MAX(agent_type) AS type, COUNT(*) AS turns, SUM(status != 'running') AS finished,
         SUM(status IN ('error', 'interrupted')) AS errors, SUM(status = 'ok') AS ok,
         COUNT(DISTINCT session_id) AS sessions, MAX(start_ms) AS last
       FROM span WHERE ${base} AND kind = 'turn' GROUP BY ${group}`,
    ))
      Object.assign(at(keyOf(row)), {
        type: row.type,
        turns: row.turns,
        finished: row.finished,
        errors: row.errors,
        ok: row.ok,
        sessions: row.sessions,
        last: row.last,
      })
    for (const row of rows(
      `SELECT ${select}, MAX(agent_type) AS type, SUM(kind = 'model_call') AS calls, SUM(kind = 'helper_run') AS runs,
         SUM(COALESCE(cost, 0)) AS cost, MAX(start_ms) AS last
       FROM span WHERE ${base} AND kind IN ('model_call', 'helper_run') GROUP BY ${group}`,
    )) {
      const item = at(keyOf(row))
      item.calls = Number(row.calls)
      item.runs = Number(row.runs)
      item.cost = Number(row.cost)
      item.type ??= row.type as string | null
      item.last = later(item.last, row.last as number | null)
    }
    for (const row of rows(
      `SELECT ${select}, COUNT(*) AS n FROM span WHERE ${base} AND kind = 'tool_call' AND status = 'denied' GROUP BY ${group}`,
    ))
      at(keyOf(row)).denials = Number(row.n)
  }
  const rank = (row: Acc) => (input.by === "tool" || input.by === "model" ? row.calls : row.turns || row.calls)
  const ranked = [...acc.values()]
    .filter((row) => rank(row) > 0 || row.cost > 0 || row.runs > 0)
    .toSorted((a, b) => rank(b) - rank(a) || b.cost - a.cost || b.runs - a.runs)
  const top = ranked.slice(0, input.limit)
  const rest = ranked.slice(input.limit)
  // p95 active time, in one pass: successful turns (agents, projects) or calls (models). Tools have none: their panel
  // doesn't show it, and it would sort every call. `+status` keeps SQLite on the kind index.
  const actives = new Map<string, number[]>()
  if (input.by !== "tool" && top.length) {
    const value = input.by === "model" ? "duration_ms" : "active_ms"
    for (const row of store.db
      .query(
        `SELECT ${select}, ${value} AS v FROM span WHERE ${base} AND kind = '${input.by === "model" ? "model_call" : "turn"}'
         AND +status = 'ok' AND ${value} IS NOT NULL`,
      )
      .all(...params) as Array<{ a: string | null; v: number }>) {
      const key = keyOf(row)
      const list = actives.get(key)
      if (list) list.push(row.v)
      else actives.set(key, [row.v])
    }
  }
  const p95Of = (row: Acc) => {
    const values = actives.get(row.key)
    if (!values?.length) return null
    values.sort((a, b) => a - b)
    return values[Math.min(values.length - 1, Math.ceil(0.95 * values.length) - 1)]!
  }
  const label = (row: Acc) => (input.by === "tool" ? (row.key.split(SEPARATOR)[1] ?? "") : row.key)
  const sum = (field: keyof Acc) => rest.reduce((total, row) => total + (Number(row[field]) || 0), 0)
  const finished = sum("finished")
  const tools = input.by === "tool"
  return {
    rows: top.map(
      (row): Row => ({
        key: label(row),
        label: label(row),
        ...(row.type ? { type: row.type } : {}),
        ...(tools && row.key.split(SEPARATOR)[0] ? { server: row.key.split(SEPARATOR)[0] } : {}),
        // A tool's turns and sessions would cost a distinct count over every call, and its panel doesn't show them.
        ...(tools ? {} : { turns: row.turns, sessions: row.sessions }),
        calls: row.calls,
        errors: row.errors,
        errorRate: row.finished ? (row.errors / row.finished) * 100 : null,
        denials: row.denials,
        p95Active: p95Of(row),
        cost: row.cost,
        lastUsed: row.last,
      }),
    ),
    other: rest.length
      ? {
          keys: rest.map(label),
          ...(tools ? {} : { turns: sum("turns"), sessions: sum("sessions") }),
          calls: sum("calls"),
          errors: sum("errors"),
          errorRate: finished ? (sum("errors") / finished) * 100 : null,
          denials: sum("denials"),
          cost: sum("cost"),
        }
      : null,
  }
}
