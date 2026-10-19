export * as OperatorTelemetryAlerts from "./alerts"

import { OperatorTelemetryQuery } from "./query"
import type { OperatorTelemetryStore } from "./store"

// Basic alerts (observability_spec.md §14): fixed metrics, a threshold over a window, shown inside the app only. This
// file holds the rules' shape, the built-in rules, measuring a metric over a window and scope from spans and samples,
// and one evaluation step of a rule's state (the service, alerting.ts, runs it every 60 s and keeps the state).

type Store = OperatorTelemetryStore.Store
const MIN = 60_000

export const METRICS = [
  "turn_error_rate",
  "call_error_rate",
  "tool_error_rate",
  "denials",
  "rate_limits",
  "retries_exhausted",
  "oldest_approval",
  "turn_active_p95",
  "ttft_p95",
  "cost",
  "loops",
  "mcp_down",
  "oldest_queued",
] as const
export type Metric = (typeof METRICS)[number]

export type Unit = "percent" | "count" | "minutes" | "seconds" | "usd"
/** Each metric's unit, whether it has a window, and whether a minimum count applies (ratios and percentiles). */
export const METRIC_INFO: Record<Metric, { unit: Unit; windowless?: boolean; minimum?: boolean }> = {
  turn_error_rate: { unit: "percent", minimum: true },
  call_error_rate: { unit: "percent", minimum: true },
  tool_error_rate: { unit: "percent", minimum: true },
  denials: { unit: "count" },
  rate_limits: { unit: "count" },
  retries_exhausted: { unit: "count" },
  oldest_approval: { unit: "minutes", windowless: true },
  turn_active_p95: { unit: "seconds", minimum: true },
  ttft_p95: { unit: "seconds", minimum: true },
  cost: { unit: "usd" },
  loops: { unit: "count" },
  mcp_down: { unit: "minutes", windowless: true },
  oldest_queued: { unit: "minutes", windowless: true },
}

export const OPS = [">", ">=", "<", "<="] as const
export type Op = (typeof OPS)[number]
export const WINDOWS = ["5", "15", "30", "60", "today"] as const
export type Window = (typeof WINDOWS)[number]
export const SEVERITIES = ["warning", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]
export const SCOPE_FIELDS = ["ns", "dir", "agent", "model", "provider", "tool"] as const
export type Scope = Partial<Record<(typeof SCOPE_FIELDS)[number], string>>

/** What a rule says (§14.1). */
export type RuleInput = {
  name: string
  metric: Metric
  op: Op
  threshold: number
  window: Window
  /** The fewest events in the window before the rule can fire (ratios and percentiles). */
  minCount?: number
  /** How many evaluations in a row the condition must hold: 1 to 10. */
  consecutive: number
  scope: Scope
  severity: Severity
  enabled: boolean
}
export type Rule = RuleInput & {
  id: string
  /** A built-in rule's key: it can be edited, disabled and reset, not deleted. */
  builtin?: string
  /** Muted until a time, or (no `until`) until turned back on. */
  mute?: { until?: number }
  createdAt: number
  updatedAt: number
}

export const BUILTIN_PREFIX = "builtin-"

/** The built-in rules (§14.3). The daily cost rule is off until a budget is entered. */
export function builtins(budget: number | undefined): Array<RuleInput & { builtin: string }> {
  const rule = (builtin: string, input: Omit<RuleInput, "scope" | "consecutive"> & { consecutive?: number }) => ({
    builtin,
    consecutive: 1,
    scope: {},
    ...input,
  })
  return [
    rule("approval_waiting", {
      name: "Approval waiting long",
      metric: "oldest_approval",
      op: ">",
      threshold: 10,
      window: "15",
      severity: "warning",
      enabled: true,
    }),
    rule("calls_failing", {
      name: "Model calls failing",
      metric: "call_error_rate",
      op: ">",
      threshold: 20,
      window: "15",
      minCount: 10,
      severity: "critical",
      enabled: true,
    }),
    rule("rate_limited", {
      name: "Rate limited",
      metric: "rate_limits",
      op: ">=",
      threshold: 5,
      window: "15",
      severity: "warning",
      enabled: true,
    }),
    rule("retries_exhausted", {
      name: "Retries exhausted",
      metric: "retries_exhausted",
      op: ">=",
      threshold: 1,
      window: "15",
      severity: "critical",
      enabled: true,
    }),
    rule("mcp_down", {
      name: "MCP server down",
      metric: "mcp_down",
      op: ">",
      threshold: 5,
      window: "15",
      severity: "warning",
      enabled: true,
    }),
    rule("possible_loop", {
      name: "Possible loop",
      metric: "loops",
      op: ">=",
      threshold: 1,
      window: "15",
      severity: "warning",
      enabled: true,
    }),
    rule("tools_failing", {
      name: "Tools failing",
      metric: "tool_error_rate",
      op: ">",
      threshold: 30,
      window: "30",
      minCount: 10,
      severity: "warning",
      enabled: true,
    }),
    rule("daily_cost", {
      name: "Daily cost",
      metric: "cost",
      op: ">",
      threshold: budget ?? 0,
      window: "today",
      severity: "warning",
      enabled: budget !== undefined,
    }),
  ]
}

/** Where a window starts: minutes back, or local midnight for "today". */
export function windowStart(window: Window, now: number) {
  if (window !== "today") return now - Number(window) * MIN
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime()
}

export type Measured = {
  value: number | null
  /** Events counted (the denominator of a ratio, the values of a percentile). */
  count: number | null
}

/** What measuring reads besides the store: the namespaces' projects, and the MCP folders in use. */
export type Context = OperatorTelemetryQuery.Context & {
  /** Folders with activity in the last 15 minutes: only their MCP servers are known (§5.9). */
  activeFolders: ReadonlySet<string>
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

// MCP statuses that mean a server isn't usable (disabled is a choice, not a failure).
const UP = new Set(["connected", "disabled"])

/** Measures a rule's metric over its window and scope (§14.2). Throws if the store can't be read. */
export function measure(
  store: Store,
  rule: Pick<RuleInput, "metric" | "window" | "scope">,
  context: Context,
): Measured {
  const now = context.now
  const from = windowStart(rule.window, now)
  const scope = { ...rule.scope }
  // Spans that started up to a day before the window, so ones that end inside it count; the window applies below.
  const base = OperatorTelemetryQuery.spanWhere({ ...scope, from: from - 24 * 60 * MIN, to: now + 1 }, context)
  const where = (kinds: string, extra: string) => `(${base.sql}) AND kind IN (${kinds}) AND (${extra})`
  const ended = `end_ms IS NOT NULL AND end_ms >= ${from} AND end_ms <= ${now}`
  const started = `start_ms >= ${from} AND start_ms <= ${now}`
  const one = (sql: string) => store.db.query(sql).get(...base.params) as Record<string, number | null>
  const values = (sql: string) =>
    (store.db.query(sql).all(...base.params) as Array<{ v: number | null }>)
      .map((row) => row.v)
      .filter((value): value is number => value !== null)
  const ratio = (kinds: string, extra: string, part: string): Measured => {
    const row = one(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ${part} THEN 1 ELSE 0 END) AS k FROM span WHERE ${where(kinds, extra)}`,
    )
    const n = row.n ?? 0
    return { value: n ? ((row.k ?? 0) / n) * 100 : null, count: n }
  }
  const count = (kinds: string, extra: string): Measured => ({
    value: one(`SELECT COUNT(*) AS n FROM span WHERE ${where(kinds, extra)}`).n ?? 0,
    count: null,
  })
  switch (rule.metric) {
    case "turn_error_rate":
      return ratio("'turn'", `status != 'running' AND ${ended}`, "status IN ('error', 'interrupted')")
    case "call_error_rate":
      return ratio("'model_call'", `status != 'running' AND ${ended}`, "status = 'error'")
    case "tool_error_rate":
      return ratio("'tool_call'", `status NOT IN ('running', 'denied') AND ${ended}`, "status = 'error'")
    case "denials":
      return count("'tool_call'", `status = 'denied' AND COALESCE(end_ms, start_ms) >= ${from}`)
    case "rate_limits":
      return count("'model_call', 'retry'", `http_status = 429 AND ${started}`)
    case "retries_exhausted":
      return count("'turn'", `error_type = 'retries_exhausted' AND ${ended}`)
    case "loops":
      return count("'turn'", `loop IS NOT NULL AND COALESCE(end_ms, start_ms) >= ${from}`)
    case "cost": {
      const row = one(
        `SELECT SUM(COALESCE(cost, 0)) AS v FROM span WHERE ${where("'model_call', 'helper_run'", started)}`,
      )
      return { value: row.v ?? 0, count: null }
    }
    case "turn_active_p95": {
      const found = values(
        `SELECT active_ms AS v FROM span WHERE ${where("'turn'", `status != 'running' AND ${ended}`)}`,
      )
      const p95 = percentile(found, 0.95)
      return { value: p95 === null ? null : p95 / 1000, count: found.length }
    }
    case "ttft_p95": {
      const found = values(
        `SELECT ttft_ms AS v FROM span WHERE ${where("'model_call'", `ttft_ms IS NOT NULL AND ${ended}`)}`,
      )
      const p95 = percentile(found, 0.95)
      return { value: p95 === null ? null : p95 / 1000, count: found.length }
    }
    case "oldest_approval": {
      // Waits still open, in scope (spans say which project and agent; the sample doesn't).
      const all = OperatorTelemetryQuery.spanWhere({ ...scope, from: 0, to: now + 1 }, context)
      const row = store.db
        .query(
          `SELECT MIN(start_ms) AS v FROM span WHERE (${all.sql}) AND kind = 'permission_wait' AND status = 'running'`,
        )
        .get(...all.params) as { v: number | null }
      return { value: row.v === null ? 0 : Math.max(0, now - row.v) / MIN, count: null }
    }
    case "oldest_queued": {
      // The last sample (taken every minute) for each project in scope.
      const where = OperatorTelemetryQuery.scope(scope, context, "json_extract(dims, '$.project')")[0]
      const latest = store.db
        .query("SELECT MAX(time_ms) AS t FROM sample WHERE name = 'queue_oldest_ms' AND time_ms >= ?")
        .get(now - 3 * MIN) as { t: number | null }
      if (latest.t === null) return { value: 0, count: null }
      const row = store.db
        .query(
          `SELECT MAX(value) AS v FROM sample WHERE name = 'queue_oldest_ms' AND time_ms = ? ${where ? `AND (${where.sql})` : ""}`,
        )
        .get(latest.t, ...(where?.params ?? [])) as { v: number | null }
      return { value: (row.v ?? 0) / MIN, count: null }
    }
    case "mcp_down": {
      // How long the longest-failing server in a folder in use has been down: since the first status of its current
      // run of failures.
      const where = OperatorTelemetryQuery.scope(scope, context, "directory")[0]
      const rows = store.db
        .query(
          `SELECT directory, server, status, time_ms FROM mcp_status ${where ? `WHERE ${where.sql}` : ""} ORDER BY time_ms`,
        )
        .all(...(where?.params ?? [])) as Array<{ directory: string; server: string; status: string; time_ms: number }>
      const since = new Map<string, number | undefined>()
      for (const row of rows) {
        if (!context.activeFolders.has(row.directory)) continue
        const key = `${row.directory}\u0000${row.server}`
        if (UP.has(row.status)) since.set(key, undefined)
        else if (since.get(key) === undefined) since.set(key, row.time_ms)
      }
      const down = [...since.values()].filter((time): time is number => time !== undefined)
      return { value: down.length ? (now - Math.min(...down)) / MIN : 0, count: null }
    }
  }
}

/** Where View events goes: the Events filter for a rule's metric and scope (§14.4). */
export function linkOf(rule: Pick<RuleInput, "metric" | "scope">): Record<string, string> {
  const scope = Object.fromEntries(Object.entries(rule.scope).filter(([, value]) => value)) as Record<string, string>
  const filters: Record<Metric, Record<string, string>> = {
    turn_error_rate: { kind: "turn", status: "error,interrupted" },
    call_error_rate: { kind: "model_call", status: "error" },
    tool_error_rate: { kind: "tool_call", status: "error" },
    denials: { kind: "tool_call", status: "denied" },
    rate_limits: { http: "429" },
    retries_exhausted: { kind: "turn", errorType: "retries_exhausted" },
    oldest_approval: { kind: "permission_wait", status: "running" },
    turn_active_p95: { kind: "turn", sort: "active:desc" },
    ttft_p95: { kind: "model_call", sort: "ttft:desc" },
    cost: { kind: "model_call", sort: "cost:desc" },
    loops: { kind: "turn", loop: "1" },
    mcp_down: { kind: "tool_call", status: "error" },
    oldest_queued: { kind: "queue_item" },
  }
  return { ...filters[rule.metric], ...scope }
}

export const compare = (value: number, op: Op, threshold: number) =>
  op === ">"
    ? value > threshold
    : op === ">="
      ? value >= threshold
      : op === "<"
        ? value < threshold
        : value <= threshold

// ---- one evaluation (§14.4) ----

export const STATES = ["ok", "insufficient", "firing", "muted", "error", "disabled"] as const
export type StateName = (typeof STATES)[number]
export type State = {
  state: StateName
  /** Evaluations in a row the condition held. */
  streak: number
  /** Evaluations in a row it didn't, while firing. */
  clear: number
  value: number | null
  count: number | null
  evaluated_ms: number | null
  error: string | null
  /** The open alert event while firing. */
  event_id: string | null
  last_fired_ms: number | null
}
export const INITIAL: State = {
  state: "ok",
  streak: 0,
  clear: 0,
  value: null,
  count: null,
  evaluated_ms: null,
  error: null,
  event_id: null,
  last_fired_ms: null,
}
/** Evaluations in a row the condition must be false before a firing rule resolves, so it doesn't flap. */
export const RESOLVE_AFTER = 2

export const mutedAt = (rule: Pick<Rule, "mute">, now: number) =>
  !!rule.mute && (rule.mute.until === undefined || rule.mute.until > now)

export type Step = {
  next: State
  /** Open an alert event with this value. */
  open?: number
  /** Close the open event. */
  close?: boolean
  /** The open event's new worst value. */
  worst?: number
}

/** One evaluation of a rule: its new state, and whether an alert event opens, closes or gets a worse value. */
export function advance(
  previous: State,
  rule: Pick<Rule, "op" | "threshold" | "minCount" | "consecutive" | "enabled" | "mute" | "metric">,
  measured: Measured | { error: string },
  now: number,
): Step {
  const firing = previous.event_id !== null
  if (!rule.enabled)
    return {
      next: { ...previous, state: "disabled", streak: 0, clear: 0, error: null },
      ...(firing ? { close: true } : {}),
    }
  const muted = mutedAt(rule, now)
  // Evaluation failed: say so, never fire because of it (§14.4).
  if ("error" in measured)
    return { next: { ...previous, state: firing ? "firing" : "error", error: measured.error, evaluated_ms: now } }
  const insufficient =
    !!METRIC_INFO[rule.metric].minimum && rule.minCount !== undefined && (measured.count ?? 0) < rule.minCount
  const holds = !insufficient && measured.value !== null && compare(measured.value, rule.op, rule.threshold)
  const streak = holds ? previous.streak + 1 : 0
  const clear = holds || !firing ? 0 : previous.clear + 1
  const base = {
    ...previous,
    streak,
    clear,
    value: measured.value,
    count: measured.count,
    evaluated_ms: now,
    error: null,
  }
  if (firing) {
    if (clear >= RESOLVE_AFTER)
      return { next: { ...base, clear: 0, event_id: null, state: muted ? "muted" : "ok" }, close: true }
    return {
      next: { ...base, state: muted ? "muted" : "firing" },
      ...(holds && measured.value !== null ? { worst: measured.value } : {}),
    }
  }
  if (holds && streak >= rule.consecutive && !muted)
    return { next: { ...base, state: "firing", last_fired_ms: now }, open: measured.value! }
  return { next: { ...base, state: muted ? "muted" : insufficient ? "insufficient" : "ok" } }
}

/** The worse of two values for a condition: higher for > and ≥, lower for < and ≤. */
export const worse = (op: Op, a: number | null, b: number) =>
  a === null ? b : op === ">" || op === ">=" ? Math.max(a, b) : Math.min(a, b)
