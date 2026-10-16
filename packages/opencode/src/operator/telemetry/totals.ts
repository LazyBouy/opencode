export * as OperatorTelemetryTotals from "./totals"

import { OperatorTelemetryDerive } from "./derive"
import type { OperatorTelemetryStore } from "./store"

// Hourly totals (observability_spec.md §6.2): one row per UTC hour and combination of dimensions, with counts, sums and
// histograms, kept longer than spans. An hour is recomputed from its spans whenever one of them is written (marked
// dirty, recomputed every 60 s), which stays right for late updates. Spans that go before their hour's totals do (a
// session deleted for good, retention) leave what they added in `total_frozen` first, so the totals don't change:
// an hour's totals are its spans plus what was frozen there. Histograms use fixed buckets; percentiles from them are
// estimated within a bucket (shown with "≈").

export const HOUR = 60 * 60 * 1000

/** Bucket upper bounds in ms: 10, 20, 50 ms … 30 min, 1 h; one more bucket holds what is above. */
export const BUCKETS = [
  10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000,
  1_800_000, 3_600_000,
] as const

export const DIMENSIONS = [
  "kind",
  "project_key",
  "agent",
  "agent_type",
  "model",
  "provider",
  "tool",
  "mcp_server",
  "status",
  "error_type",
] as const satisfies ReadonlyArray<keyof OperatorTelemetryStore.Span>
export type Dimension = (typeof DIMENSIONS)[number]

export type Measures = {
  count: number
  duration_ms: number
  active_ms: number
  wait_ms: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  /** Cost counted in sessions' totals. */
  cost: number
  /** Cost of side calls and helper runs, which sessions' totals leave out. */
  cost_side: number
  cost_billed: number
  http_429: number
  retries: number
  loops: number
  hist_active: number[]
  hist_ttft: number[]
  hist_wait: number[]
}

export type Row = { hour_ms: number } & Record<Dimension, string | null> & Measures

export const MEASURES = [
  "count",
  "duration_ms",
  "active_ms",
  "wait_ms",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost",
  "cost_side",
  "cost_billed",
  "http_429",
  "retries",
  "loops",
] as const satisfies ReadonlyArray<keyof Measures>
const HISTOGRAMS = ["hist_active", "hist_ttft", "hist_wait"] as const

export const hourOf = (time: number) => Math.floor(time / HOUR) * HOUR

/** The bucket a duration falls in (the last one is "above 1 h"). */
export function bucketOf(ms: number) {
  const index = BUCKETS.findIndex((bound) => ms <= bound)
  return index < 0 ? BUCKETS.length : index
}

const histogram = () => Array.from({ length: BUCKETS.length + 1 }, () => 0)

const empty = (): Measures => ({
  count: 0,
  duration_ms: 0,
  active_ms: 0,
  wait_ms: 0,
  tokens_input: 0,
  tokens_output: 0,
  tokens_reasoning: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost: 0,
  cost_side: 0,
  cost_billed: 0,
  http_429: 0,
  retries: 0,
  loops: 0,
  hist_active: histogram(),
  hist_ttft: histogram(),
  hist_wait: histogram(),
})

export function add(a: Measures, b: Measures): Measures {
  const out = empty()
  for (const key of MEASURES) out[key] = a[key] + b[key]
  for (const key of HISTOGRAMS) out[key] = out[key].map((_, at) => (a[key][at] ?? 0) + (b[key][at] ?? 0))
  return out
}

const keyOf = (dims: Record<Dimension, string | null>) => JSON.stringify(DIMENSIONS.map((dim) => dims[dim]))

/** Spans' totals by hour and dimensions. */
export function aggregate(spans: ReadonlyArray<OperatorTelemetryStore.Span>) {
  const groups = new Map<string, Row>()
  for (const span of spans) {
    const hour = hourOf(span.start_ms ?? 0)
    const dims = Object.fromEntries(DIMENSIONS.map((dim) => [dim, (span[dim] as string | null) ?? null])) as Record<
      Dimension,
      string | null
    >
    const key = `${hour}\u0000${keyOf(dims)}`
    const row = groups.get(key) ?? ({ hour_ms: hour, ...dims, ...empty() } as Row)
    const side = OperatorTelemetryDerive.side(span) || span.kind === "helper_run"
    row.count += 1
    row.duration_ms += span.duration_ms ?? 0
    row.active_ms += span.active_ms ?? 0
    row.wait_ms += span.wait_ms ?? 0
    // Turns hold their calls' sums: counted once, on the calls.
    if (span.kind !== "turn") {
      row.tokens_input += span.tokens_input ?? 0
      row.tokens_output += span.tokens_output ?? 0
      row.tokens_reasoning += span.tokens_reasoning ?? 0
      row.tokens_cache_read += span.tokens_cache_read ?? 0
      row.tokens_cache_write += span.tokens_cache_write ?? 0
      if (side) row.cost_side += span.cost ?? 0
      else row.cost += span.cost ?? 0
      row.cost_billed += span.cost_billed ?? 0
    }
    if (span.http_status === 429) row.http_429 += 1
    if (span.kind === "retry") row.retries += 1
    if (span.loop) row.loops += 1
    if (span.active_ms !== null && span.active_ms !== undefined) row.hist_active[bucketOf(span.active_ms)]! += 1
    if (span.ttft_ms !== null && span.ttft_ms !== undefined) row.hist_ttft[bucketOf(span.ttft_ms)]! += 1
    if (span.wait_ms) row.hist_wait[bucketOf(span.wait_ms)]! += 1
    groups.set(key, row)
  }
  return [...groups.values()]
}

/** The p-th percentile (0–1) from a histogram, estimated linearly within its bucket. */
export function percentile(hist: ReadonlyArray<number>, p: number) {
  const total = hist.reduce((sum, value) => sum + value, 0)
  if (!total) return undefined
  const target = p * total
  let seen = 0
  for (let at = 0; at < hist.length; at++) {
    const count = hist[at] ?? 0
    if (!count) continue
    if (seen + count >= target) {
      const low = at === 0 ? 0 : BUCKETS[at - 1]!
      const high = BUCKETS[at] ?? BUCKETS[BUCKETS.length - 1]! * 2
      return low + ((high - low) * Math.max(0, target - seen)) / count
    }
    seen += count
  }
  return BUCKETS[BUCKETS.length - 1]! * 2
}

const COLUMNS = ["hour_ms", ...DIMENSIONS, ...MEASURES, ...HISTOGRAMS] as const

function toRecord(row: Row) {
  return COLUMNS.map((column) =>
    (HISTOGRAMS as ReadonlyArray<string>).includes(column)
      ? JSON.stringify(row[column as (typeof HISTOGRAMS)[number]])
      : (row[column as keyof Row] as string | number | null),
  )
}

function fromRecord(record: Record<string, unknown>): Row {
  const row = { ...record } as Record<string, unknown>
  for (const key of HISTOGRAMS) {
    try {
      row[key] = JSON.parse(String(record[key] ?? "[]"))
    } catch {
      row[key] = histogram()
    }
  }
  return row as Row
}

function write(store: OperatorTelemetryStore.Store, table: "total_hour" | "total_frozen", rows: ReadonlyArray<Row>) {
  const statement = store.db.prepare(
    `INSERT INTO ${table} (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
  )
  for (const row of rows) statement.run(...(toRecord(row) as Array<string | number | null>))
}

export function rows(
  store: OperatorTelemetryStore.Store,
  table: "total_hour" | "total_frozen",
  from: number,
  to: number,
) {
  return (
    store.db.query(`SELECT * FROM ${table} WHERE hour_ms >= ? AND hour_ms < ?`).all(from, to) as Array<
      Record<string, unknown>
    >
  ).map(fromRecord)
}

/** Keeps what these spans add to their hours' totals, before they go (§5.10, §6.1). Call inside a transaction. */
export function freeze(store: OperatorTelemetryStore.Store, spans: ReadonlyArray<OperatorTelemetryStore.Span>) {
  const groups = aggregate(spans)
  const hours = [...new Set(groups.map((row) => row.hour_ms))]
  for (const hour of hours) {
    const merged = new Map<string, Row>()
    for (const row of [
      ...rows(store, "total_frozen", hour, hour + 1),
      ...groups.filter((row) => row.hour_ms === hour),
    ]) {
      const key = keyOf(row)
      const before = merged.get(key)
      merged.set(key, before ? { ...before, ...add(before, row) } : row)
    }
    store.db.query("DELETE FROM total_frozen WHERE hour_ms = ?").run(hour)
    write(store, "total_frozen", [...merged.values()])
  }
}

/** Recomputes the dirty hours: their spans plus what was frozen there. Call inside a transaction. */
export function recompute(store: OperatorTelemetryStore.Store) {
  const hours = (store.db.query("SELECT hour_ms FROM dirty_hour").all() as Array<{ hour_ms: number }>).map(
    (row) => row.hour_ms,
  )
  for (const hour of hours) {
    const spans = store.db
      .query("SELECT * FROM span WHERE start_ms >= ? AND start_ms < ?")
      .all(hour, hour + HOUR) as OperatorTelemetryStore.Span[]
    const merged = new Map<string, Row>()
    for (const row of [...aggregate(spans), ...rows(store, "total_frozen", hour, hour + 1)]) {
      const key = keyOf(row)
      const before = merged.get(key)
      merged.set(key, before ? { ...before, ...add(before, row) } : row)
    }
    store.db.query("DELETE FROM total_hour WHERE hour_ms = ?").run(hour)
    write(store, "total_hour", [...merged.values()])
    store.db.query("DELETE FROM dirty_hour WHERE hour_ms = ?").run(hour)
  }
  return hours.length
}

/** Marks the hours these spans start in, for the next recompute. Call inside a transaction. */
export function mark(store: OperatorTelemetryStore.Store, starts: Iterable<number | null | undefined>) {
  const statement = store.db.prepare("INSERT OR IGNORE INTO dirty_hour (hour_ms) VALUES (?)")
  for (const start of new Set([...starts].filter((value): value is number => typeof value === "number").map(hourOf)))
    statement.run(start)
}
