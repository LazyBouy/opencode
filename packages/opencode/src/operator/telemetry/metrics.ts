export * as OperatorTelemetryMetrics from "./metrics"

import { OperatorTelemetryQuery } from "./query"
import { OperatorTelemetryStore } from "./store"
import { OperatorTelemetryTotals } from "./totals"

// The Metrics tab's series (observability_spec.md §12): fixed, curated charts, each one metric id. Inside the detailed
// window a metric is computed from spans (percentiles exact); a range reaching past it comes from hourly totals
// (percentiles estimated within a bucket, "≈"), and a metric that totals can't give says so. Counting, summing and
// bucketing run in SQL; only percentiles bring values out. A split (a chart's own, or the section's group-by) shows the
// top 5 values and "Other", never dropping the rest. Each series says which Events filter a point opens (§12.1).

type Store = OperatorTelemetryStore.Store
type Kind = OperatorTelemetryStore.Kind
type Clause = OperatorTelemetryQuery.Clause
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const TOP = 5

export type Unit = "count" | "ms" | "percent" | "usd" | "tokens" | "tps"
export type Series = {
  key: string
  label: string
  points: Array<[number, number | null]>
  /** The Events filter a point of this series opens, besides the metric's kind and the step's time. */
  filter?: Record<string, string>
  /** Drawn as a line over the stacked series. */
  line?: boolean
}
export type Result = {
  step: number
  from: number
  to: number
  source: "events" | "totals"
  approx: boolean
  unit: Unit
  /** The span kind a point opens in Events. */
  kind?: Kind
  series: Series[]
  /** The values in "Other". */
  other: string[]
  /** What the series' keys are values of, when split: status, decision, model, project, agent, … */
  split?: string
  /** Table metrics: one row per tool or permission. */
  table?: Array<Record<string, string | number | null>>
  /** Histogram metrics: the buckets' labels (a point's time is its bucket's index). */
  buckets?: string[]
  /** Why there is nothing: the metric needs detailed events, or call recording (§5.1). */
  note?: "needs-events" | "needs-recording"
  /** Filters, or the group-by, that hourly totals don't keep, so they were not applied. */
  ignored?: string[]
}

// ---- splits ----

type Key = {
  /** SQL on spans. */
  span: string
  /** SQL on hourly totals; absent when totals don't keep it. */
  totals?: string
  /** The Events filter for one value. */
  filter?: (value: string) => Record<string, string>
}
const column = (name: string, filter: string): Key => ({
  span: `COALESCE(${name}, '')`,
  totals: `COALESCE(${name}, '')`,
  filter: (value: string): Record<string, string> => (value ? { [filter]: value } : {}),
})
const KEYS = {
  agent: column("agent", "agent"),
  project: column("project_key", "dir"),
  model: column("model", "model"),
  provider: column("provider", "provider"),
  status: column("status", "status"),
  tool: column("tool", "tool"),
  kind: { span: "COALESCE(json_extract(attrs, '$.callKind'), 'agent')" },
  decision: {
    span: "COALESCE(decision, status)",
    filter: (value: string): Record<string, string> =>
      (OperatorTelemetryStore.STATUSES as ReadonlyArray<string>).includes(value)
        ? { status: value }
        : { decision: value },
  },
  loop: { span: "COALESCE(loop, '')", filter: (): Record<string, string> => ({ loop: "1" }) },
  providerModel: {
    span: "COALESCE(provider, '') || '/' || COALESCE(model, '')",
    filter: (value: string): Record<string, string> => ({ model: value.slice(value.indexOf("/") + 1) }),
  },
} satisfies Record<string, Key>
type KeyName = keyof typeof KEYS

/** What each section offers to group by (§12.3). */
export const GROUPS = {
  turns: ["agent", "project", "model"],
  calls: ["model", "provider", "agent", "kind"],
  tokens: ["model", "project", "agent"],
  tools: [],
  approvals: [],
  agents: ["agent"],
  saturation: [],
} as const satisfies Record<string, ReadonlyArray<KeyName>>
export type Section = keyof typeof GROUPS

// ---- definitions ----

type Agg = "sum" | "ratio" | "p50" | "p95"
type Hist = "hist_active" | "hist_ttft" | "hist_wait"
type Line = {
  key: string
  kinds: ReadonlyArray<Kind>
  /** A condition on spans (SQL, no parameters). */
  where?: string
  agg: Agg
  /** sum and ratio: the value added up (`1` counts); p50 and p95: the value ranked. */
  value: string
  /** ratio: what `value` is a share of, in %. */
  of?: string
  filter?: Record<string, string>
  /** Drawn as a line over the stacked series; kept when the chart is split. */
  line?: boolean
  /** The same from hourly totals (SQL on total_hour, or a histogram); absent when only events have it. */
  totals?: { where?: string; value: string; of?: string } | { where?: string; hist: Hist }
}
type Lines = {
  type: "lines"
  section: Section
  unit: Unit
  kind?: Kind
  lines: Line[]
  /** Split the first line by this key (top 5 + Other): a stacked chart's own split. */
  by?: KeyName
  /** The section's group-by applies, splitting `group` (default the first line). */
  grouped?: boolean
  group?: Line
  /** The value comes only from recorded calls (§5.1): "needs recording" when calls have none. */
  recorded?: boolean
}
type Samples = {
  type: "samples"
  section: Section
  unit: Unit
  samples: Array<{ name: string; key: string; across: "sum" | "max"; split?: string }>
  /** The samples' dims field holding a project key, for the scope filter. */
  project?: string
}
type Histogram = { type: "histogram"; section: Section; field: "modelCalls" | "toolCalls" }
type Table = { type: "table"; section: Section; table: "tools" | "approvals"; kind: Kind }
type Def = Lines | Samples | Histogram | Table

const count = (key: string, kinds: ReadonlyArray<Kind>, extra: Partial<Line> = {}): Line => ({
  key,
  kinds,
  agg: "sum",
  value: "1",
  totals: { value: "count", ...(extra.where ? { where: extra.where } : {}) },
  ...extra,
})
const share = (
  key: string,
  kinds: ReadonlyArray<Kind>,
  where: string,
  part: string,
  extra: Partial<Line> = {},
): Line => ({
  key,
  kinds,
  where,
  agg: "ratio",
  value: `CASE WHEN ${part} THEN 1 ELSE 0 END`,
  of: "1",
  totals: { where, value: `CASE WHEN ${part} THEN count ELSE 0 END`, of: "count" },
  ...extra,
})
const pct = (
  key: string,
  agg: "p50" | "p95",
  kinds: ReadonlyArray<Kind>,
  value: string,
  where: string | undefined,
  hist: Hist | undefined,
  extra: Partial<Line> = {},
): Line => ({
  key,
  kinds,
  agg,
  value,
  ...(where ? { where } : {}),
  ...(hist ? { totals: { hist, ...(where ? { where } : {}) } } : {}),
  ...extra,
})
const sumOf = (
  key: string,
  kinds: ReadonlyArray<Kind>,
  value: string,
  totals: string | undefined,
  extra: Partial<Line> = {},
): Line => ({
  key,
  kinds,
  agg: "sum",
  value: `COALESCE(${value}, 0)`,
  ...(totals ? { totals: { value: totals, ...(extra.where ? { where: extra.where } : {}) } } : {}),
  ...extra,
})

const FINISHED = "status != 'running'"
const FAILED = "status IN ('error', 'interrupted')"
const TURN = ["turn"] as const
const CALL = ["model_call"] as const

export const METRICS = {
  // 1. Turns
  turns: {
    type: "lines",
    section: "turns",
    unit: "count",
    kind: "turn",
    by: "status",
    grouped: true,
    lines: [count("turns", TURN)],
  },
  turn_error_rate: {
    type: "lines",
    section: "turns",
    unit: "percent",
    kind: "turn",
    grouped: true,
    lines: [
      share("errors", TURN, FINISHED, FAILED, { filter: { status: "error,interrupted" } }),
      share("denied", TURN, FINISHED, "status = 'denied'", { filter: { status: "denied" } }),
    ],
  },
  turn_active: {
    type: "lines",
    section: "turns",
    unit: "ms",
    kind: "turn",
    grouped: true,
    group: pct("p95", "p95", TURN, "active_ms", FINISHED, "hist_active"),
    lines: [
      pct("ok_p50", "p50", TURN, "active_ms", "status = 'ok'", "hist_active", { filter: { status: "ok" } }),
      pct("ok_p95", "p95", TURN, "active_ms", "status = 'ok'", "hist_active", { filter: { status: "ok" } }),
      pct("failed_p50", "p50", TURN, "active_ms", FAILED, "hist_active", { filter: { status: "error,interrupted" } }),
      pct("failed_p95", "p95", TURN, "active_ms", FAILED, "hist_active", { filter: { status: "error,interrupted" } }),
    ],
  },
  turn_wait: {
    type: "lines",
    section: "turns",
    unit: "ms",
    kind: "turn",
    grouped: true,
    group: pct("p95", "p95", TURN, "wait_ms", "wait_ms > 0", "hist_wait"),
    lines: [
      pct("p50", "p50", TURN, "wait_ms", "wait_ms > 0", "hist_wait"),
      pct("p95", "p95", TURN, "wait_ms", "wait_ms > 0", "hist_wait"),
    ],
  },
  // 2. Model calls
  calls: {
    type: "lines",
    section: "calls",
    unit: "count",
    kind: "model_call",
    grouped: true,
    lines: [count("calls", CALL)],
  },
  call_errors: {
    type: "lines",
    section: "calls",
    unit: "count",
    kind: "model_call",
    grouped: true,
    lines: [
      count("errors", CALL, { where: "status = 'error'", filter: { status: "error" } }),
      {
        key: "http_429",
        kinds: CALL,
        agg: "sum",
        value: "1",
        where: "http_status = 429",
        filter: { http: "429" },
        totals: { value: "http_429" },
      },
      count("retries_exhausted", TURN, {
        where: "error_type = 'retries_exhausted'",
        filter: { kind: "turn", errorType: "retries_exhausted" },
      }),
    ],
  },
  retries: {
    type: "lines",
    section: "calls",
    unit: "count",
    kind: "retry",
    grouped: true,
    lines: [count("retries", ["retry"])],
  },
  call_duration: {
    type: "lines",
    section: "calls",
    unit: "ms",
    kind: "model_call",
    grouped: true,
    group: pct("p95", "p95", CALL, "duration_ms", "status = 'ok'", "hist_active"),
    lines: [
      pct("p50", "p50", CALL, "duration_ms", "status = 'ok'", "hist_active"),
      pct("p95", "p95", CALL, "duration_ms", "status = 'ok'", "hist_active"),
    ],
  },
  ttft: {
    type: "lines",
    section: "calls",
    unit: "ms",
    kind: "model_call",
    grouped: true,
    recorded: true,
    group: pct("p95", "p95", CALL, "ttft_ms", undefined, "hist_ttft"),
    lines: [
      pct("p50", "p50", CALL, "ttft_ms", undefined, "hist_ttft"),
      pct("p95", "p95", CALL, "ttft_ms", undefined, "hist_ttft"),
    ],
  },
  output_speed: {
    type: "lines",
    section: "calls",
    unit: "tps",
    kind: "model_call",
    grouped: true,
    recorded: true,
    lines: [
      pct(
        "p50",
        "p50",
        CALL,
        "tokens_output * 1000.0 / (end_ms - start_ms - ttft_ms)",
        "ttft_ms IS NOT NULL AND end_ms IS NOT NULL AND tokens_output > 0 AND end_ms - start_ms - ttft_ms > 0",
        undefined,
      ),
    ],
  },
  // 3. Tokens and cost
  tokens: {
    type: "lines",
    section: "tokens",
    unit: "tokens",
    kind: "model_call",
    lines: (["input", "cache_read", "cache_write", "output", "reasoning"] as const).map((type) =>
      sumOf(type, CALL, `tokens_${type}`, `tokens_${type}`),
    ),
  },
  cache_hit: {
    type: "lines",
    section: "tokens",
    unit: "percent",
    kind: "model_call",
    by: "model",
    lines: [
      {
        key: "cache_hit",
        kinds: CALL,
        agg: "ratio",
        value: "COALESCE(tokens_cache_read, 0)",
        of: "COALESCE(tokens_input, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0)",
        totals: { value: "tokens_cache_read", of: "tokens_input + tokens_cache_read + tokens_cache_write" },
      },
    ],
  },
  cost: {
    type: "lines",
    section: "tokens",
    unit: "usd",
    kind: "model_call",
    grouped: true,
    lines: [sumOf("cost", ["model_call", "helper_run"], "cost", "cost + cost_side")],
  },
  cost_per_turn: {
    type: "lines",
    section: "tokens",
    unit: "usd",
    kind: "turn",
    grouped: true,
    group: pct("p95", "p95", TURN, "COALESCE(cost, 0)", FINISHED, undefined),
    lines: [
      pct("p50", "p50", TURN, "COALESCE(cost, 0)", FINISHED, undefined),
      pct("p95", "p95", TURN, "COALESCE(cost, 0)", FINISHED, undefined),
    ],
  },
  cost_billed: {
    type: "lines",
    section: "tokens",
    unit: "usd",
    kind: "model_call",
    lines: [
      sumOf("billed", CALL, "cost_billed", "cost_billed", { where: "cost_billed IS NOT NULL" }),
      sumOf("estimated", CALL, "cost", undefined, {
        where: "cost_billed IS NOT NULL",
        totals: { where: "cost_billed > 0", value: "cost" },
      }),
    ],
  },
  // 4. Tools
  tool_calls: {
    type: "lines",
    section: "tools",
    unit: "count",
    kind: "tool_call",
    by: "tool",
    lines: [count("tools", ["tool_call"])],
  },
  tool_table: { type: "table", section: "tools", table: "tools", kind: "tool_call" },
  tool_errors: {
    type: "lines",
    section: "tools",
    unit: "count",
    kind: "tool_call",
    lines: [
      count("errors", ["tool_call"], { where: "status = 'error'", filter: { status: "error" } }),
      count("denials", ["tool_call"], { where: "status = 'denied'", filter: { status: "denied" } }),
    ],
  },
  // 5. Approvals
  approvals: {
    type: "lines",
    section: "approvals",
    unit: "count",
    kind: "permission_wait",
    by: "decision",
    lines: [count("requests", ["permission_wait"], { where: FINISHED })],
  },
  approval_wait: {
    type: "lines",
    section: "approvals",
    unit: "ms",
    kind: "permission_wait",
    lines: [
      pct("p50", "p50", ["permission_wait"], "COALESCE(wait_ms, duration_ms)", FINISHED, "hist_wait"),
      pct("p95", "p95", ["permission_wait"], "COALESCE(wait_ms, duration_ms)", FINISHED, "hist_wait"),
    ],
  },
  approval_pending: {
    type: "samples",
    section: "approvals",
    unit: "count",
    samples: [{ name: "approvals_pending", key: "pending", across: "sum" }],
  },
  approval_oldest: {
    type: "samples",
    section: "approvals",
    unit: "ms",
    samples: [{ name: "approvals_oldest_ms", key: "oldest", across: "max" }],
  },
  approval_table: { type: "table", section: "approvals", table: "approvals", kind: "permission_wait" },
  // 6. Agents and loops
  calls_per_turn: { type: "histogram", section: "agents", field: "modelCalls" },
  tools_per_turn: { type: "histogram", section: "agents", field: "toolCalls" },
  loops: {
    type: "lines",
    section: "agents",
    unit: "count",
    kind: "turn",
    by: "loop",
    lines: [
      {
        key: "loops",
        kinds: TURN,
        agg: "sum",
        value: "1",
        where: "loop IS NOT NULL",
        filter: { loop: "1" },
        totals: { value: "loops" },
      },
    ],
  },
  subagents: {
    type: "lines",
    section: "agents",
    unit: "count",
    kind: "subagent",
    by: "agent",
    lines: [count("subagents", ["subagent"])],
  },
  helpers: {
    type: "lines",
    section: "agents",
    unit: "count",
    kind: "helper_run",
    by: "agent",
    lines: [
      count("helpers", ["helper_run"]),
      count("errors", ["helper_run"], { where: "status = 'error'", filter: { status: "error" }, line: true }),
    ],
  },
  helper_cost: {
    type: "lines",
    section: "agents",
    unit: "usd",
    kind: "helper_run",
    by: "agent",
    lines: [sumOf("cost", ["helper_run"], "cost", "cost_side")],
  },
  // 7. Saturation
  rate_limits: {
    type: "lines",
    section: "saturation",
    unit: "count",
    kind: "model_call",
    by: "provider",
    lines: [
      {
        key: "http_429",
        kinds: ["model_call", "retry"],
        agg: "sum",
        value: "1",
        where: "http_status = 429",
        filter: { http: "429" },
        totals: { value: "http_429", where: "http_429 > 0" },
      },
    ],
  },
  context_used: {
    type: "lines",
    section: "saturation",
    unit: "tokens",
    kind: "model_call",
    by: "providerModel",
    lines: [pct("p95", "p95", CALL, "context_tokens", "context_tokens > 0", undefined)],
  },
  compactions: {
    type: "lines",
    section: "saturation",
    unit: "count",
    kind: "compaction",
    lines: [count("compactions", ["compaction"])],
  },
  queue: {
    type: "samples",
    section: "saturation",
    unit: "count",
    project: "project",
    samples: [{ name: "queue_depth", key: "depth", across: "sum" }],
  },
  queue_oldest: {
    type: "samples",
    section: "saturation",
    unit: "ms",
    project: "project",
    samples: [{ name: "queue_oldest_ms", key: "oldest", across: "max" }],
  },
  queue_wait: {
    type: "lines",
    section: "saturation",
    unit: "ms",
    kind: "queue_item",
    lines: [pct("p95", "p95", ["queue_item"], "wait_ms", FINISHED, "hist_wait")],
  },
  mcp: {
    type: "samples",
    section: "saturation",
    unit: "count",
    samples: [{ name: "mcp_servers", key: "servers", across: "sum", split: "status" }],
  },
  mcp_errors: {
    type: "lines",
    section: "saturation",
    unit: "percent",
    kind: "tool_call",
    lines: [
      share("errors", ["tool_call"], "mcp_server IS NOT NULL", "status = 'error'", { filter: { status: "error" } }),
    ],
  },
  running: {
    type: "samples",
    section: "saturation",
    unit: "count",
    samples: [
      { name: "sessions_running", key: "running", across: "sum" },
      { name: "sessions_waiting", key: "waiting", across: "sum" },
    ],
  },
} satisfies Record<string, Def>
export type Metric = keyof typeof METRICS
export const IDS = Object.keys(METRICS) as Metric[]

// ---- steps and frames ----

/** The time step for a range (§12.2); past the detailed window, at least an hour. */
export function stepOf(length: number, beyond: boolean) {
  const step =
    length <= 15 * MIN
      ? 15_000
      : length <= HOUR
        ? MIN
        : length <= 6 * HOUR
          ? 5 * MIN
          : length <= DAY
            ? 15 * MIN
            : length <= 7 * DAY
              ? HOUR
              : length <= 30 * DAY
                ? 6 * HOUR
                : DAY
  return beyond ? Math.max(HOUR, step) : step
}

type Frame = { from: number; to: number; step: number; count: number }
const frameOf = (from: number, to: number, step: number): Frame => {
  const start = Math.floor(from / step) * step
  const count = Math.max(1, Math.ceil((to - start) / step))
  return { from: start, to: start + count * step, step, count }
}
const times = (frame: Frame) => Array.from({ length: frame.count }, (_, index) => frame.from + index * frame.step)
// The step a time falls in (the frame's start and step are bound first).
const BUCKET = (time: string) => `CAST((${time} - ?) / ? AS INTEGER)`

// ---- cells ----

type Cell = { v: number; d: number; list: number[]; hist: number[] }
const blank = (): Cell => ({ v: 0, d: 0, list: [], hist: [] })
const merge = (into: Cell, from: Cell) => {
  into.v += from.v
  into.d += from.d
  for (const value of from.list) into.list.push(value)
  from.hist.forEach((value, at) => (into.hist[at] = (into.hist[at] ?? 0) + (value ?? 0)))
}
const weight = (cell: Cell) =>
  cell.v + cell.d + cell.list.length + cell.hist.reduce((sum, value) => sum + (value ?? 0), 0)

const percentile = (values: number[], p: number) => {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

function valueOf(agg: Agg, cell: Cell | undefined): number | null {
  if (agg === "sum") return cell?.v ?? 0
  if (!cell) return null
  if (agg === "ratio") return cell.d ? (cell.v / cell.d) * 100 : null
  const p = agg === "p50" ? 0.5 : 0.95
  if (cell.hist.length)
    return (
      OperatorTelemetryTotals.percentile(
        Array.from(cell.hist, (value) => value ?? 0),
        p,
      ) ?? null
    )
  return percentile(cell.list, p)
}

/** Cells per split value and step. */
type Grid = Map<string, Cell[]>
const cellAt = (grid: Grid, frame: Frame, key: string, index: number) => {
  if (index < 0 || index >= frame.count) return undefined
  let row = grid.get(key)
  if (!row) {
    row = Array.from({ length: frame.count }, blank)
    grid.set(key, row)
  }
  return row[index]!
}

// ---- reading ----

type Source = {
  store: Store
  frame: Frame
  /** The filter on spans (events) or on hourly totals (totals). */
  where: Clause
  totals: boolean
}

const kindsIn = (kinds: ReadonlyArray<Kind>): Clause => ({
  sql: `kind IN (${kinds.map(() => "?").join(", ")})`,
  params: [...kinds],
})

type Sums = Array<{ b: number; k: string; v: number | null; d: number | null }>

/** One line's cells, split by a key (SQL) or not (one key, ""). */
function read(source: Source, line: Line, key: string | undefined): Grid {
  const { store, frame } = source
  const grid: Grid = new Map()
  const kinds = kindsIn(line.kinds)
  const split = key ?? "''"
  const params = [frame.from, frame.step, ...source.where.params, ...kinds.params]
  const add = (rows: Sums) => {
    for (const row of rows) {
      const cell = cellAt(grid, frame, row.k, row.b)
      if (!cell) continue
      cell.v += row.v ?? 0
      cell.d += row.d ?? 0
    }
    return grid
  }
  if (source.totals) {
    const totals = line.totals!
    const where = `(${source.where.sql}) AND (${kinds.sql}) AND (${totals.where ?? "1 = 1"})`
    if ("hist" in totals) {
      const rows = store.db
        .query(
          `SELECT b, k, j.key AS at, SUM(j.value) AS n
           FROM (SELECT ${BUCKET("hour_ms")} AS b, ${split} AS k, ${totals.hist} AS h FROM total_hour WHERE ${where}), json_each(h) j
           GROUP BY b, k, at`,
        )
        .all(...params) as Array<{ b: number; k: string; at: number; n: number }>
      for (const row of rows) {
        const cell = cellAt(grid, frame, row.k, row.b)
        if (cell) cell.hist[row.at] = (cell.hist[row.at] ?? 0) + row.n
      }
      return grid
    }
    return add(
      store.db
        .query(
          `SELECT ${BUCKET("hour_ms")} AS b, ${split} AS k, SUM(${totals.value}) AS v, SUM(${totals.of ?? "0"}) AS d
           FROM total_hour WHERE ${where} GROUP BY b, k`,
        )
        .all(...params) as Sums,
    )
  }
  const where = `(${source.where.sql}) AND (${kinds.sql}) AND (${line.where ?? "1 = 1"})`
  if (line.agg === "p50" || line.agg === "p95") {
    const rows = store.db
      .query(
        `SELECT ${BUCKET("start_ms")} AS b, ${split} AS k, ${line.value} AS v FROM span
         WHERE ${where} AND (${line.value}) IS NOT NULL`,
      )
      .all(...params) as Array<{ b: number; k: string; v: number }>
    for (const row of rows) cellAt(grid, frame, row.k, row.b)?.list.push(row.v)
    return grid
  }
  return add(
    store.db
      .query(
        `SELECT ${BUCKET("start_ms")} AS b, ${split} AS k, SUM(${line.value}) AS v, SUM(${line.of ?? "0"}) AS d
         FROM span WHERE ${where} GROUP BY b, k`,
      )
      .all(...params) as Sums,
  )
}

const seriesOf = (frame: Frame, agg: Agg, cells: Cell[] | undefined, base: Omit<Series, "points">): Series => ({
  ...base,
  points: times(frame).map((time, index) => [time, valueOf(agg, cells?.[index])]),
})

/** The top 5 values and Other, as series. */
function top(frame: Frame, line: Line, grid: Grid, key: Key) {
  const total = (cells: Cell[]) => cells.reduce((sum, cell) => sum + weight(cell), 0)
  const ranked = [...grid].toSorted((a, b) => total(b[1]) - total(a[1]))
  const shown = ranked.slice(0, TOP)
  const rest = ranked.slice(TOP)
  const series = shown.map(([value, cells]) =>
    seriesOf(frame, line.agg, cells, {
      key: value,
      label: value,
      filter: { ...line.filter, ...key.filter?.(value) },
    }),
  )
  if (rest.length) {
    const merged = Array.from({ length: frame.count }, blank)
    for (const [, cells] of rest) cells.forEach((cell, index) => merge(merged[index]!, cell))
    series.push(
      seriesOf(frame, line.agg, merged, {
        key: "Other",
        label: "Other",
        ...(line.filter ? { filter: line.filter } : {}),
      }),
    )
  }
  return { series, other: rest.map(([value]) => value) }
}

const plain = (source: Source, line: Line, extra: Partial<Series> = {}) =>
  seriesOf(source.frame, line.agg, read(source, line, undefined).get(""), {
    key: line.key,
    label: line.key,
    ...(line.filter ? { filter: line.filter } : {}),
    ...(line.line ? { line: true } : {}),
    ...extra,
  })

function lineSeries(
  source: Source,
  def: Lines,
  groupBy: KeyName | undefined,
): Pick<Result, "series" | "other" | "note" | "split"> {
  const usable = (line: Line) => !source.totals || !!line.totals
  const name = groupBy ?? def.by
  const key = name ? (KEYS[name] as Key) : undefined
  // A split hourly totals don't keep falls back to the whole (the group-by is reported as ignored).
  if (key && (!source.totals || key.totals)) {
    const line = groupBy ? (def.group ?? def.lines[0]!) : def.lines[0]!
    if (!usable(line)) return { series: [], other: [], note: "needs-events" }
    const split = top(source.frame, line, read(source, line, source.totals ? key.totals : key.span), key)
    const overlays = def.lines.filter((item) => item.line && usable(item))
    return {
      series: [...split.series, ...overlays.map((item) => plain(source, item))],
      other: split.other,
      split: name!,
    }
  }
  const shown = def.lines.filter(usable)
  if (!shown.length) return { series: [], other: [], note: "needs-events" }
  return { series: shown.map((line) => plain(source, line)), other: [] }
}

function sampleSeries(store: Store, frame: Frame, def: Samples, scope: Clause | undefined): Series[] {
  const series: Series[] = []
  for (const item of def.samples) {
    const split = item.split ? `COALESCE(json_extract(dims, '$.${item.split}'), '')` : "''"
    // One value per sample time (summed, or the largest, across dims), then the largest in each step.
    const rows = store.db
      .query(
        `SELECT ${BUCKET("time_ms")} AS b, k, MAX(v) AS v
         FROM (SELECT time_ms, ${split} AS k, ${item.across === "sum" ? "SUM" : "MAX"}(value) AS v FROM sample
               WHERE name = ? AND time_ms >= ? AND time_ms < ? ${scope ? `AND (${scope.sql})` : ""} GROUP BY time_ms, k)
         GROUP BY b, k`,
      )
      .all(frame.from, frame.step, item.name, frame.from, frame.to, ...(scope?.params ?? [])) as Array<{
      b: number
      k: string
      v: number
    }>
    const byKey = new Map<string, Array<number | null>>()
    for (const row of rows) {
      if (row.b < 0 || row.b >= frame.count) continue
      const values = byKey.get(row.k) ?? Array.from({ length: frame.count }, () => null)
      values[row.b] = row.v
      byKey.set(row.k, values)
    }
    if (!byKey.size && !item.split)
      byKey.set(
        "",
        Array.from({ length: frame.count }, () => null),
      )
    for (const [value, values] of byKey)
      series.push({
        key: item.split ? value : item.key,
        label: item.split ? value : item.key,
        points: times(frame).map((time, index) => [time, values[index] ?? null]),
      })
  }
  return series
}

const HISTOGRAM = [1, 2, 4, 8, 16, 32, 64, 128]

function histogramSeries(source: Source, def: Histogram, groupBy: KeyName | undefined) {
  const key = groupBy ? (KEYS[groupBy] as Key) : undefined
  const rows = source.store.db
    .query(
      `SELECT ${key?.span ?? "''"} AS k, CAST(json_extract(attrs, '$.${def.field}') AS INTEGER) AS n FROM span
       WHERE (${source.where.sql}) AND kind = 'turn' AND ${FINISHED}`,
    )
    .all(...source.where.params) as Array<{ k: string; n: number | null }>
  const grid = new Map<string, number[]>()
  for (const row of rows) {
    if (!row.n) continue
    const at = HISTOGRAM.findIndex((bound, index) => row.n! <= bound || index === HISTOGRAM.length - 1)
    const values = grid.get(row.k) ?? HISTOGRAM.map(() => 0)
    values[at]! += 1
    grid.set(row.k, values)
  }
  const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0)
  const ranked = [...grid].toSorted((a, b) => total(b[1]) - total(a[1]))
  const shown = key ? ranked.slice(0, TOP) : ranked
  const rest = key ? ranked.slice(TOP) : []
  const points = (values: number[]) => values.map((value, index): [number, number] => [index, value])
  const series: Series[] = shown.map(([value, values]) => ({
    key: key ? value : "turns",
    label: key ? value : "turns",
    points: points(values),
    ...(key?.filter ? { filter: key.filter(value) } : {}),
  }))
  if (rest.length)
    series.push({
      key: "Other",
      label: "Other",
      points: points(HISTOGRAM.map((_, index) => rest.reduce((sum, [, values]) => sum + values[index]!, 0))),
    })
  if (!series.length) series.push({ key: "turns", label: "turns", points: points(HISTOGRAM.map(() => 0)) })
  return {
    series,
    other: rest.map(([value]) => value),
    buckets: HISTOGRAM.map((bound, index) => (index === HISTOGRAM.length - 1 ? `${bound}+` : String(bound))),
  }
}

type Row = Record<string, string | number | null>
const TOOL = "CASE WHEN mcp_server IS NOT NULL THEN mcp_server ELSE COALESCE(tool, '') END"
const MCP = "CASE WHEN mcp_server IS NOT NULL THEN 1 ELSE 0 END"

/** Per tool (MCP tools under their server): calls, errors, error rate, denials, p50 and p95 active time, mean wait. */
function toolTable(source: Source): Row[] {
  const { store } = source
  const base = `(${source.where.sql}) AND kind = 'tool_call'`
  type Sum = { tool: string; mcp: number; calls: number; errors: number; denials: number; wait: number }
  const rows = store.db
    .query(
      source.totals
        ? `SELECT ${TOOL} AS tool, ${MCP} AS mcp, SUM(count) AS calls, SUM(CASE WHEN status = 'error' THEN count ELSE 0 END) AS errors,
             SUM(CASE WHEN status = 'denied' THEN count ELSE 0 END) AS denials, SUM(wait_ms) * 1.0 / MAX(SUM(count), 1) AS wait
           FROM total_hour WHERE ${base} GROUP BY tool, mcp`
        : `SELECT ${TOOL} AS tool, ${MCP} AS mcp, COUNT(*) AS calls, SUM(status = 'error') AS errors,
             SUM(status = 'denied') AS denials, AVG(COALESCE(wait_ms, 0)) AS wait
           FROM span WHERE ${base} GROUP BY tool, mcp`,
    )
    .all(...source.where.params) as Sum[]
  const cells = new Map<string, Cell>()
  const cell = (key: string) => {
    const found = cells.get(key) ?? blank()
    cells.set(key, found)
    return found
  }
  if (source.totals) {
    for (const row of store.db
      .query(
        `SELECT k, m, j.key AS at, SUM(j.value) AS n
         FROM (SELECT ${TOOL} AS k, ${MCP} AS m, hist_active AS h FROM total_hour WHERE ${base}), json_each(h) j
         GROUP BY k, m, at`,
      )
      .all(...source.where.params) as Array<{ k: string; m: number; at: number; n: number }>) {
      const found = cell(`${row.m}:${row.k}`)
      found.hist[row.at] = (found.hist[row.at] ?? 0) + row.n
    }
  } else {
    for (const row of store.db
      .query(`SELECT ${TOOL} AS k, ${MCP} AS m, active_ms AS v FROM span WHERE ${base} AND active_ms IS NOT NULL`)
      .all(...source.where.params) as Array<{ k: string; m: number; v: number }>)
      cell(`${row.m}:${row.k}`).list.push(row.v)
  }
  return rows
    .map((row) => {
      const found = cells.get(`${row.mcp}:${row.tool}`)
      return {
        tool: row.tool,
        mcp: row.mcp,
        calls: row.calls,
        errors: row.errors,
        error_rate: row.calls ? (row.errors / row.calls) * 100 : 0,
        denials: row.denials,
        p50: valueOf("p50", found),
        p95: valueOf("p95", found),
        wait: row.wait ?? 0,
      }
    })
    .toSorted((a, b) => b.calls - a.calls)
}

/** Per permission: requests, % allowed, p95 wait, who decides most. */
function approvalTable(source: Source): Row[] {
  const { store } = source
  const base = `(${source.where.sql}) AND kind = 'permission_wait' AND ${FINISHED}`
  const params = source.where.params
  const rows = store.db
    .query(
      `SELECT COALESCE(permission, '') AS permission, COUNT(*) AS requests, SUM(decision LIKE 'allow%') AS allowed
       FROM span WHERE ${base} GROUP BY permission`,
    )
    .all(...params) as Array<{ permission: string; requests: number; allowed: number }>
  const waits = new Map<string, number[]>()
  for (const row of store.db
    .query(
      `SELECT COALESCE(permission, '') AS k, COALESCE(wait_ms, duration_ms) AS v FROM span
       WHERE ${base} AND COALESCE(wait_ms, duration_ms) IS NOT NULL`,
    )
    .all(...params) as Array<{ k: string; v: number }>)
    waits.set(row.k, [...(waits.get(row.k) ?? []), row.v])
  // The decider seen most often wins (rows in ascending count, the last one kept).
  const deciders = new Map<string, string>()
  for (const row of store.db
    .query(
      `SELECT COALESCE(permission, '') AS k, COALESCE(decided_by, decision_source) AS who, COUNT(*) AS n FROM span
       WHERE ${base} AND COALESCE(decided_by, decision_source) IS NOT NULL GROUP BY k, who ORDER BY n ASC`,
    )
    .all(...params) as Array<{ k: string; who: string }>)
    deciders.set(row.k, row.who)
  return rows
    .map((row) => ({
      permission: row.permission,
      requests: row.requests,
      allowed: row.requests ? (row.allowed / row.requests) * 100 : 0,
      p95: percentile(waits.get(row.permission) ?? [], 0.95),
      decided_by: deciders.get(row.permission) ?? null,
    }))
    .toSorted((a, b) => b.requests - a.requests)
}

// ---- the filter on hourly totals ----

const TOTALS_FIELDS = {
  agent: "agent",
  agentType: "agent_type",
  model: "model",
  provider: "provider",
  tool: "tool",
  mcp: "mcp_server",
  status: "status",
  errorType: "error_type",
} as const
/** Filters hourly totals can't apply: they keep no sessions, texts, decisions, per-span costs or HTTP statuses. */
const NOT_IN_TOTALS = [
  "session",
  "finish",
  "decision",
  "minCost",
  "maxCost",
  "minDuration",
  "maxDuration",
  "minTokens",
  "loop",
  "http",
  "q",
] as const

function totalsWhere(filter: OperatorTelemetryQuery.Filter, context: OperatorTelemetryQuery.Context, frame: Frame) {
  const clauses: Clause[] = [
    { sql: "hour_ms >= ? AND hour_ms < ?", params: [frame.from, frame.to] },
    ...OperatorTelemetryQuery.scope(filter, context),
  ]
  for (const [name, field] of Object.entries(TOTALS_FIELDS)) {
    const values = (filter[name as keyof typeof TOTALS_FIELDS] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    if (values.length) clauses.push({ sql: `${field} IN (${values.map(() => "?").join(", ")})`, params: values })
  }
  return {
    where: {
      sql: clauses.map((clause) => `(${clause.sql})`).join(" AND "),
      params: clauses.flatMap((clause) => clause.params),
    },
    ignored: NOT_IN_TOTALS.filter((name) => filter[name] !== undefined && filter[name] !== "") as string[],
  }
}

// ---- one metric ----

export function compute(
  store: Store,
  input: {
    metric: Metric
    groupBy?: string
    step?: number
    filter: OperatorTelemetryQuery.Filter
    context: OperatorTelemetryQuery.Context
    eventsDays: number
  },
): Result {
  const def: Def = METRICS[input.metric]
  const now = input.context.now
  const range = OperatorTelemetryQuery.window(input.filter, now)
  const beyond = range.from < now - input.eventsDays * DAY
  // A named range's own length (its window ends a millisecond past now, to include now).
  const length =
    input.filter.from === undefined && input.filter.to === undefined
      ? (OperatorTelemetryQuery.RANGES[input.filter.range ?? "24h"] ?? range.to - range.from)
      : range.to - range.from
  const step = Math.max(beyond ? HOUR : 15_000, input.step ?? stepOf(length, beyond))
  const frame = frameOf(range.from, Math.min(range.to, now + 1), step)
  const offered = GROUPS[def.section] as ReadonlyArray<string>
  const wanted =
    input.groupBy &&
    offered.includes(input.groupBy) &&
    (def.type === "histogram" || (def.type === "lines" && def.grouped))
      ? (input.groupBy as KeyName)
      : undefined
  // Each chart has its own kind; the range is the frame's whole steps.
  const filter: OperatorTelemetryQuery.Filter = {
    ...input.filter,
    kind: undefined,
    range: undefined,
    from: frame.from,
    to: frame.to,
  }
  const head = { step, from: frame.from, to: frame.to }

  if (def.type === "samples") {
    const scope = def.project
      ? OperatorTelemetryQuery.scope(filter, input.context, `json_extract(dims, '$.${def.project}')`)[0]
      : undefined
    const split = def.samples.find((item) => item.split)?.split
    return {
      ...head,
      source: "events",
      approx: false,
      unit: def.unit,
      series: sampleSeries(store, frame, def, scope),
      other: [],
      ...(split ? { split } : {}),
    }
  }

  const totals = beyond ? totalsWhere(filter, input.context, frame) : undefined
  const source: Source = {
    store,
    frame,
    totals: !!totals,
    where: totals?.where ?? OperatorTelemetryQuery.spanWhere(filter, input.context),
  }
  const ignored = [...(totals?.ignored ?? [])]
  const groupBy = wanted && totals && !(KEYS[wanted] as Key).totals ? undefined : wanted
  if (wanted && !groupBy) ignored.push("groupBy")
  const meta = {
    ...head,
    source: totals ? ("totals" as const) : ("events" as const),
    approx: !!totals,
    ...(ignored.length ? { ignored } : {}),
  }
  const nothing = { series: [], other: [], note: "needs-events" as const }

  if (def.type === "histogram") {
    if (totals) return { ...meta, unit: "count", ...nothing }
    return {
      ...meta,
      unit: "count",
      kind: "turn",
      ...histogramSeries(source, def, groupBy),
      ...(groupBy ? { split: groupBy } : {}),
    }
  }
  if (def.type === "table") {
    if (totals && def.table === "approvals") return { ...meta, unit: "count", kind: def.kind, ...nothing }
    return {
      ...meta,
      unit: "count",
      kind: def.kind,
      series: [],
      other: [],
      table: def.table === "tools" ? toolTable(source) : approvalTable(source),
    }
  }
  const result = lineSeries(source, def, groupBy)
  // A value only recorded calls have: say so when there are calls and none has it.
  if (def.recorded && !totals && result.series.every((line) => line.points.every(([, value]) => value === null))) {
    const found = store.db
      .query(`SELECT COUNT(*) AS n FROM span WHERE (${source.where.sql}) AND kind = 'model_call'`)
      .get(...source.where.params) as { n: number }
    if (found.n) return { ...meta, unit: def.unit, kind: def.kind, series: [], other: [], note: "needs-recording" }
  }
  return { ...meta, unit: def.unit, ...(def.kind ? { kind: def.kind } : {}), ...result }
}
