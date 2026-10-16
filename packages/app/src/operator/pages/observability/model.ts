// The Observability page's pure rules (observability_spec.md §8–§10): the URL as the state (§8.4), durations, statuses
// and the turn timeline's rows. The page and its tabs read and write these.

/** Filter parameters, as the API names them (§7.2); the page's URL uses the same names. */
export const FILTERS = [
  "ns",
  "dir",
  "agent",
  "agentType",
  "model",
  "provider",
  "tool",
  "mcp",
  "kind",
  "status",
  "errorType",
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
  "roots",
  "sessionStatus",
  "stuck",
] as const
export type FilterKey = (typeof FILTERS)[number]

// `session`, `turn` and `span` open the session detail (§8.4: the Dashboard links with them); a filter on one session
// is `inSession` in the page's URL (the API's `session`).
export const OVERLAY = ["session", "turn", "span"] as const
export const PAGE = ["tab", "range", "from", "to", "sort", "view", "live", "cols", "section", "inSession"] as const

export const TABS = ["sessions", "events", "metrics", "logs", "alerts"] as const
export type Tab = (typeof TABS)[number]

export const RANGES = ["15m", "1h", "6h", "24h", "7d", "30d", "90d", "365d"] as const
export type Range = { range?: string; from?: number; to?: number }
export const DEFAULT_RANGE = "24h"

export type Params = Partial<Record<string, string | string[] | undefined>>

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined

/** The filter in the URL, for the API. */
export function filterOf(params: Params): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of FILTERS) {
    const value = one(params[key])
    if (value !== undefined) out[key] = value
  }
  const inSession = one(params.inSession)
  if (inSession) out.session = inSession
  return out
}

/** The time range in the URL: a relative range, or a custom from and to (ms). */
export function rangeOf(params: Params, remembered?: string): Range {
  const from = Number(one(params.from))
  const to = Number(one(params.to))
  if (Number.isFinite(from) && from > 0 && Number.isFinite(to) && to > from) return { from, to }
  const range = one(params.range) ?? remembered
  return { range: range && (RANGES as ReadonlyArray<string>).includes(range) ? range : DEFAULT_RANGE }
}

/** The range as API parameters. */
export function rangeQuery(range: Range): Record<string, string> {
  return range.from !== undefined && range.to !== undefined
    ? { from: String(range.from), to: String(range.to) }
    : { range: range.range ?? DEFAULT_RANGE }
}

const STEPS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  "90d": 90 * 24 * 60 * 60_000,
  "365d": 365 * 24 * 60 * 60_000,
}

/** The range's length, and whether it reaches past the detailed window (§8.2). */
export function reach(range: Range, now: number, eventsDays: number) {
  const from = range.from ?? now - (STEPS[range.range ?? DEFAULT_RANGE] ?? STEPS[DEFAULT_RANGE]!)
  return { from, beyond: from < now - eventsDays * 24 * 60 * 60_000 }
}

export const isTab = (value: string | undefined): value is Tab =>
  !!value && (TABS as ReadonlyArray<string>).includes(value)

/** What the active filters say, as chips: a key, its values. */
export function chips(params: Params) {
  return FILTERS.filter(
    (key) => key !== "ns" && key !== "dir" && key !== "roots" && one(params[key]) !== undefined,
  ).map((key) => ({ key, value: one(params[key])! }))
}

// ---- durations ----

/** A duration as its biggest two units: 850 ms, 12.4 s, 2 m 4 s, 1 h 10 m. */
export function durationParts(ms: number): Array<{ unit: "ms" | "s" | "m" | "h" | "d"; value: number }> {
  if (!Number.isFinite(ms) || ms < 0) return []
  if (ms < 1000) return [{ unit: "ms", value: Math.round(ms) }]
  if (ms < 10_000) return [{ unit: "s", value: Math.round(ms / 100) / 10 }]
  if (ms < 60_000) return [{ unit: "s", value: Math.round(ms / 1000) }]
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600)
    return [
      { unit: "m", value: Math.floor(seconds / 60) },
      ...(seconds % 60 ? [{ unit: "s" as const, value: seconds % 60 }] : []),
    ]
  const minutes = Math.round(seconds / 60)
  if (minutes < 24 * 60)
    return [
      { unit: "h", value: Math.floor(minutes / 60) },
      ...(minutes % 60 ? [{ unit: "m" as const, value: minutes % 60 }] : []),
    ]
  const hours = Math.round(minutes / 60)
  return [
    { unit: "d", value: Math.floor(hours / 24) },
    ...(hours % 24 ? [{ unit: "h" as const, value: hours % 24 }] : []),
  ]
}

// ---- statuses ----

export const SESSION_STATUSES = [
  "running",
  "waiting",
  "idle",
  "error",
  "denied",
  "stopped",
  "interrupted",
  "trash",
] as const
export const SPAN_STATUSES = ["running", "ok", "error", "denied", "cancelled", "interrupted"] as const

/** The icon beside a status's word (colour is never the only signal). */
export const STATUS_ICON: Record<string, string> = {
  running: "status-active",
  waiting: "shield",
  idle: "circle-check",
  ok: "circle-check",
  error: "circle-x",
  denied: "circle-ban-sign",
  stopped: "stop",
  cancelled: "stop",
  interrupted: "warning",
  trash: "trash",
}

export const tokensOf = (row: {
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}) =>
  (row.tokens_input ?? 0) +
  (row.tokens_output ?? 0) +
  (row.tokens_reasoning ?? 0) +
  (row.tokens_cache_read ?? 0) +
  (row.tokens_cache_write ?? 0)

/** Cache read ÷ total input. */
export function cacheHit(row: {
  tokens_input: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}) {
  const total = (row.tokens_input ?? 0) + (row.tokens_cache_read ?? 0) + (row.tokens_cache_write ?? 0)
  return total ? (row.tokens_cache_read ?? 0) / total : undefined
}

export function attrsOf(span: { attrs: string | null }): Record<string, unknown> {
  if (!span.attrs) return {}
  try {
    const value = JSON.parse(span.attrs)
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

// ---- the turn timeline (§10.3) ----

export type SpanLike = {
  id: string
  kind: string
  parent_id: string | null
  start_ms: number | null
  end_ms: number | null
  attempt: number | null
  attempts: number | null
  attrs: string | null
}

export type Row<T extends SpanLike> = { span: T; depth: number; children: number }

/**
 * The turn's spans in tree order (each under its parent, children in start order), with their depth. Spans whose
 * parent isn't in the turn sit under the turn.
 */
export function treeRows<T extends SpanLike>(
  turn: T,
  spans: ReadonlyArray<T>,
  collapsed: ReadonlySet<string> = new Set(),
) {
  const ids = new Set([turn.id, ...spans.map((span) => span.id)])
  const children = new Map<string, T[]>()
  for (const span of spans) {
    const parent = span.parent_id && ids.has(span.parent_id) && span.parent_id !== span.id ? span.parent_id : turn.id
    children.set(parent, [...(children.get(parent) ?? []), span])
  }
  for (const list of children.values())
    list.sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0) || (a.id < b.id ? -1 : 1))
  const out: Array<Row<T>> = []
  const seen = new Set<string>()
  const walk = (span: T, depth: number) => {
    if (seen.has(span.id)) return
    seen.add(span.id)
    const kids = children.get(span.id) ?? []
    out.push({ span, depth, children: kids.length })
    if (collapsed.has(span.id)) return
    for (const kid of kids) walk(kid, depth + 1)
  }
  walk(turn, 0)
  return out
}

/** Where a bar sits on the turn's axis, as fractions of it. */
export function bar(span: Pick<SpanLike, "start_ms" | "end_ms">, axis: { from: number; to: number }, now: number) {
  const length = Math.max(1, axis.to - axis.from)
  const start = Math.max(axis.from, span.start_ms ?? axis.from)
  const end = Math.min(axis.to, Math.max(start, span.end_ms ?? now))
  return { left: (start - axis.from) / length, width: Math.max(0.002, (end - start) / length) }
}
