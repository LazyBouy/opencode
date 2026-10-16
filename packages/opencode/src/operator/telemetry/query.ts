export * as OperatorTelemetryQuery from "./query"

import type { OperatorTelemetryStore } from "./store"

// Reading the store (observability_spec.md §7.2–§7.3): one filter for every list, as query parameters (the page's URL
// uses the same names, §8.4), sorting on any column then on the id, so a page edge never skips rows that share a value
// (opaque cursors), facets that ignore their own field's filter, and the live tail's `after=<seq>`.

export type Filter = {
  range?: string
  from?: number
  to?: number
  ns?: string
  dir?: string
  session?: string
  agent?: string
  agentType?: string
  model?: string
  provider?: string
  tool?: string
  mcp?: string
  kind?: string
  status?: string
  errorType?: string
  finish?: string
  decision?: string
  minCost?: number
  maxCost?: number
  minDuration?: number
  maxDuration?: number
  minTokens?: number
  loop?: string
  http?: string
  q?: string
  roots?: string
  sessionStatus?: string
  stuck?: string
}

export const RANGES: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "14d": 14 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  "90d": 90 * 24 * 60 * 60_000,
  "365d": 365 * 24 * 60 * 60_000,
}

/** What reading needs besides the filter: the namespaces' projects, and the time. */
export type Context = {
  now: number
  /** The project keys of a namespace; `rest` adds projects in no namespace (they count under OpenCode). */
  projectsOf: (ns: string) => { keys: ReadonlyArray<string>; rest: boolean }
  /** Every project in a namespace, to tell the projects in none. */
  known: ReadonlyArray<string>
  stuckMinutes: number
}

export function window(filter: Filter, now: number) {
  if (filter.from !== undefined || filter.to !== undefined) return { from: filter.from ?? 0, to: filter.to ?? now }
  const length = RANGES[filter.range ?? "24h"] ?? RANGES["24h"]!
  return { from: now - length, to: now + 1 }
}

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? []

type Clause = { sql: string; params: Array<string | number> }
const AND = (clauses: Clause[]): Clause => ({
  sql: clauses.length ? clauses.map((clause) => `(${clause.sql})`).join(" AND ") : "1 = 1",
  params: clauses.flatMap((clause) => clause.params),
})
const IN = (column: string, values: ReadonlyArray<string>): Clause => ({
  sql: `${column} IN (${values.map(() => "?").join(", ")})`,
  params: [...values],
})

// Span columns by filter name.
const SPAN_FIELDS = {
  agent: "agent",
  agentType: "agent_type",
  model: "model",
  provider: "provider",
  tool: "tool",
  mcp: "mcp_server",
  kind: "kind",
  status: "status",
  errorType: "error_type",
  finish: "finish_reason",
  decision: "decision",
} as const
export type Field = keyof typeof SPAN_FIELDS | "dir"

function scope(filter: Filter, context: Context, column = "project_key"): Clause[] {
  const out: Clause[] = []
  if (filter.dir) out.push({ sql: `${column} = ?`, params: [filter.dir] })
  else if (filter.ns) {
    const found = context.projectsOf(filter.ns)
    const own = found.keys.length ? IN(column, found.keys) : { sql: "0 = 1", params: [] }
    out.push(
      found.rest
        ? {
            sql: `${own.sql} OR ${column} IS NULL OR ${column} NOT IN (${context.known.map(() => "?").join(", ") || "''"})`,
            params: [...own.params, ...context.known],
          }
        : own,
    )
  }
  return out
}

function http(value: string): Clause | undefined {
  const parts = list(value)
  const exact = parts.filter((part) => /^\d{3}$/.test(part)).map(Number)
  const classes = parts.filter((part) => /^\dxx$/i.test(part)).map((part) => Number(part[0]))
  const clauses: Clause[] = [
    ...(exact.length ? [{ sql: `http_status IN (${exact.map(() => "?").join(", ")})`, params: exact }] : []),
    ...classes.map((digit) => ({
      sql: "http_status >= ? AND http_status < ?",
      params: [digit * 100, digit * 100 + 100],
    })),
  ]
  if (!clauses.length) return undefined
  return { sql: clauses.map((clause) => `(${clause.sql})`).join(" OR "), params: clauses.flatMap((c) => c.params) }
}

/** The filter on spans, leaving out one field (facets). */
export function spanWhere(filter: Filter, context: Context, without?: Field): Clause {
  const { from, to } = window(filter, context.now)
  const clauses: Clause[] = [{ sql: "start_ms >= ? AND start_ms < ?", params: [from, to] }]
  if (without !== "dir") clauses.push(...scope(filter, context))
  if (filter.session)
    clauses.push({
      sql: "session_id = ? OR root_session_id = ? OR session_id IN (SELECT id FROM session_row WHERE parent_id = ?)",
      params: [filter.session, filter.session, filter.session],
    })
  for (const [name, column] of Object.entries(SPAN_FIELDS)) {
    if (name === without) continue
    const values = list(filter[name as keyof typeof SPAN_FIELDS])
    if (values.length) clauses.push(IN(column, values))
  }
  if (filter.minCost !== undefined) clauses.push({ sql: "cost >= ?", params: [filter.minCost] })
  if (filter.maxCost !== undefined) clauses.push({ sql: "cost <= ?", params: [filter.maxCost] })
  if (filter.minDuration !== undefined) clauses.push({ sql: "active_ms >= ?", params: [filter.minDuration] })
  if (filter.maxDuration !== undefined) clauses.push({ sql: "active_ms <= ?", params: [filter.maxDuration] })
  if (filter.minTokens !== undefined)
    clauses.push({
      sql: "COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_reasoning, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0) >= ?",
      params: [filter.minTokens],
    })
  if (filter.loop === "1") clauses.push({ sql: "loop IS NOT NULL", params: [] })
  const status = filter.http ? http(filter.http) : undefined
  if (status) clauses.push(status)
  if (filter.q?.trim()) {
    const like = `%${filter.q.trim().replace(/[%_\\]/g, (char) => `\\${char}`)}%`
    clauses.push({
      sql: `name LIKE ? ESCAPE '\\' OR error_message LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\'
        OR agent LIKE ? ESCAPE '\\' OR session_id IN (SELECT id FROM session_row WHERE title LIKE ? ESCAPE '\\')`,
      params: [like, like, like, like, like, like],
    })
  }
  return AND(clauses)
}

const SESSION_FIELDS = { agent: "agent", agentType: "agent_type", model: "model" } as const

/** The filter on sessions (with activity in the range). */
export function sessionWhere(filter: Filter, context: Context, without?: string): Clause {
  const { from, to } = window(filter, context.now)
  const clauses: Clause[] = [{ sql: "last_ms >= ? AND first_ms < ?", params: [from, to] }]
  if (without !== "dir") clauses.push(...scope(filter, context))
  if (filter.session) clauses.push({ sql: "id = ? OR parent_id = ?", params: [filter.session, filter.session] })
  if (filter.roots !== "0" && !filter.session) clauses.push({ sql: "parent_id IS NULL", params: [] })
  for (const [name, column] of Object.entries(SESSION_FIELDS)) {
    if (name === without) continue
    const values = list(filter[name as keyof typeof SESSION_FIELDS])
    if (values.length) clauses.push(IN(column, values))
  }
  const statuses = list(filter.sessionStatus)
  if (statuses.length && without !== "sessionStatus") clauses.push(IN("status", statuses))
  if (filter.stuck === "1")
    clauses.push({ sql: "status = 'running' AND last_ms < ?", params: [context.now - context.stuckMinutes * 60_000] })
  if (filter.minCost !== undefined) clauses.push({ sql: "cost_total >= ?", params: [filter.minCost] })
  if (filter.maxCost !== undefined) clauses.push({ sql: "cost_total <= ?", params: [filter.maxCost] })
  if (filter.loop === "1") clauses.push({ sql: "loop IS NOT NULL", params: [] })
  if (filter.q?.trim()) {
    const like = `%${filter.q.trim().replace(/[%_\\]/g, (char) => `\\${char}`)}%`
    clauses.push({ sql: "title LIKE ? ESCAPE '\\' OR agent LIKE ? ESCAPE '\\'", params: [like, like] })
  }
  return AND(clauses)
}

// ---- sorting and cursors ----

export const SPAN_SORTS: Record<string, string> = {
  start: "start_ms",
  end: "end_ms",
  duration: "duration_ms",
  active: "active_ms",
  wait: "wait_ms",
  cost: "cost",
  tokens:
    "(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_reasoning, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0))",
  ttft: "ttft_ms",
  kind: "kind",
  name: "name",
  status: "status",
  agent: "agent",
  model: "model",
  tool: "tool",
  http: "http_status",
}

export const SESSION_SORTS: Record<string, string> = {
  lastActivity: "last_ms",
  started: "first_ms",
  turnStart: "turn_start_ms",
  duration: "(COALESCE(last_ms, 0) - COALESCE(first_ms, 0))",
  active: "active_ms",
  wait: "wait_ms",
  turns: "turns",
  modelCalls: "model_calls",
  toolCalls: "tool_calls",
  errors: "errors",
  denials: "denials",
  retries: "retries",
  tokens: "(tokens_input + tokens_output + tokens_reasoning + tokens_cache_read + tokens_cache_write)",
  cost: "cost_total",
  title: "title",
  agent: "agent",
  status: "status",
  model: "model",
  subagents: "subagents",
}

const TEXT = new Set(["kind", "name", "status", "agent", "model", "tool", "title"])

/** `column[:asc|:desc]`, a known column or the default. */
export function sortOf(sort: string | undefined, columns: Record<string, string>, fallback: string) {
  const [name, way] = (sort ?? fallback).split(":")
  const key = columns[name ?? ""] ? name! : fallback.split(":")[0]!
  const direction = way === "asc" ? "asc" : way === "desc" ? "desc" : (fallback.split(":")[1] ?? "desc")
  const expression = TEXT.has(key) ? `COALESCE(${columns[key]}, '')` : `COALESCE(${columns[key]}, -9e18)`
  return { key, direction: direction as "asc" | "desc", expression }
}

type Cursor = { v: string | number; id: string }
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url")
function decode(cursor: string | undefined): Cursor | undefined {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    return value && typeof value.id === "string" ? value : undefined
  } catch {
    return undefined
  }
}

/** One page: rows sorted on the column then the id; the cursor names the last row's value and id. */
function page<Row extends { id: string }>(
  db: OperatorTelemetryStore.Store["db"],
  input: {
    table: string
    where: Clause
    sort: ReturnType<typeof sortOf>
    cursor?: string
    limit: number
  },
) {
  const after = decode(input.cursor)
  const op = input.sort.direction === "desc" ? "<" : ">"
  const clauses = [input.where]
  if (after)
    clauses.push({
      sql: `${input.sort.expression} ${op} ? OR (${input.sort.expression} = ? AND id ${op} ?)`,
      params: [after.v, after.v, after.id],
    })
  const where = AND(clauses)
  const rows = db
    .query(
      `SELECT *, ${input.sort.expression} AS sort_value FROM ${input.table} WHERE ${where.sql}
       ORDER BY ${input.sort.expression} ${input.sort.direction}, id ${input.sort.direction} LIMIT ?`,
    )
    .all(...where.params, input.limit + 1) as Array<Row & { sort_value: string | number }>
  const more = rows.length > input.limit
  const kept = rows.slice(0, input.limit)
  const last = kept.at(-1)
  return {
    rows: kept.map(({ sort_value, ...row }) => row as unknown as Row),
    nextCursor: more && last ? encode({ v: last.sort_value, id: last.id }) : undefined,
  }
}

const limitOf = (limit: number | undefined, fallback: number, max: number) =>
  Math.min(max, Math.max(1, Math.round(limit ?? fallback)))

export function events(
  store: OperatorTelemetryStore.Store,
  filter: Filter,
  context: Context,
  options: { sort?: string; cursor?: string; limit?: number; after?: number } = {},
) {
  const where = spanWhere(filter, context)
  const limit = limitOf(options.limit, 100, 1000)
  // The live tail: rows written since `after`, oldest first.
  if (options.after !== undefined) {
    const tail = AND([where, { sql: "seq > ?", params: [options.after] }])
    const rows = store.db
      .query(`SELECT * FROM span WHERE ${tail.sql} ORDER BY seq ASC LIMIT ?`)
      .all(...tail.params, limit) as OperatorTelemetryStore.Span[]
    return { rows, nextCursor: undefined, seq: rows.at(-1)?.seq ?? options.after }
  }
  const result = page<OperatorTelemetryStore.Span>(store.db, {
    table: "span",
    where,
    sort: sortOf(options.sort, SPAN_SORTS, "start:desc"),
    cursor: options.cursor,
    limit,
  })
  return { ...result, seq: store.lastSeq() }
}

export function sessions(
  store: OperatorTelemetryStore.Store,
  filter: Filter,
  context: Context,
  options: { sort?: string; cursor?: string; limit?: number } = {},
) {
  const where = sessionWhere(filter, context)
  const total = (
    store.db.query(`SELECT count(*) AS n FROM session_row WHERE ${where.sql}`).get(...where.params) as {
      n: number
    }
  ).n
  const result = page<OperatorTelemetryStore.SessionRow>(store.db, {
    table: "session_row",
    where,
    sort: sortOf(options.sort, SESSION_SORTS, "lastActivity:desc"),
    cursor: options.cursor,
    limit: limitOf(options.limit, 50, 500),
  })
  return { ...result, total }
}

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"]

export function logs(
  store: OperatorTelemetryStore.Store,
  filter: {
    range?: string
    from?: number
    to?: number
    level?: string
    q?: string
    session?: string
    service?: string
  },
  context: Pick<Context, "now">,
  options: { cursor?: string; limit?: number; after?: number } = {},
) {
  const { from, to } = window(filter, context.now)
  const clauses: Clause[] = [{ sql: "time_ms >= ? AND time_ms < ?", params: [from, to] }]
  const level = (filter.level ?? "").toUpperCase()
  if (LEVELS.includes(level)) clauses.push(IN("level", LEVELS.slice(0, LEVELS.indexOf(level) + 1)))
  if (filter.session) clauses.push({ sql: "session_id = ?", params: [filter.session] })
  if (filter.service) clauses.push(IN("service", list(filter.service)))
  if (filter.q?.trim()) {
    const like = `%${filter.q.trim().replace(/[%_\\]/g, (char) => `\\${char}`)}%`
    clauses.push({ sql: "message LIKE ? ESCAPE '\\' OR fields LIKE ? ESCAPE '\\'", params: [like, like] })
  }
  const limit = limitOf(options.limit, 100, 1000)
  if (options.after !== undefined) {
    const tail = AND([...clauses, { sql: "seq > ?", params: [options.after] }])
    const rows = store.db
      .query(`SELECT * FROM log_entry WHERE ${tail.sql} ORDER BY seq ASC LIMIT ?`)
      .all(...tail.params, limit) as OperatorTelemetryStore.LogEntry[]
    return { rows, nextCursor: undefined, seq: rows.at(-1)?.seq ?? options.after }
  }
  const result = page<OperatorTelemetryStore.LogEntry>(store.db, {
    table: "log_entry",
    where: AND(clauses),
    sort: sortOf("time:desc", { time: "time_ms" }, "time:desc"),
    cursor: options.cursor,
    limit,
  })
  return { ...result, seq: store.lastSeq() }
}

export const FACETS = {
  events: ["kind", "status", "agent", "agentType", "model", "provider", "tool", "mcp", "errorType", "decision", "dir"],
  sessions: ["sessionStatus", "agent", "agentType", "model", "dir"],
  logs: ["level", "service"],
} as const

/** Up to 20 values of a field with their counts, under the filter without that field's own filter. */
export function facet(
  store: OperatorTelemetryStore.Store,
  filter: Filter & { level?: string; service?: string },
  context: Context,
  input: { scope: "events" | "sessions" | "logs"; field: string },
) {
  if (input.scope === "events") {
    const column = input.field === "dir" ? "project_key" : SPAN_FIELDS[input.field as keyof typeof SPAN_FIELDS]
    if (!column) return []
    const where = spanWhere(filter, context, input.field as Field)
    return store.db
      .query(
        `SELECT ${column} AS value, count(*) AS count FROM span WHERE ${where.sql} AND ${column} IS NOT NULL
         GROUP BY ${column} ORDER BY count DESC, value LIMIT 20`,
      )
      .all(...where.params) as Array<{ value: string; count: number }>
  }
  if (input.scope === "sessions") {
    const column =
      input.field === "dir"
        ? "project_key"
        : input.field === "sessionStatus"
          ? "status"
          : SESSION_FIELDS[input.field as keyof typeof SESSION_FIELDS]
    if (!column) return []
    const where = sessionWhere(filter, context, input.field)
    return store.db
      .query(
        `SELECT ${column} AS value, count(*) AS count FROM session_row WHERE ${where.sql} AND ${column} IS NOT NULL
         GROUP BY ${column} ORDER BY count DESC, value LIMIT 20`,
      )
      .all(...where.params) as Array<{ value: string; count: number }>
  }
  const column = input.field === "service" ? "service" : input.field === "level" ? "level" : undefined
  if (!column) return []
  const { from, to } = window(filter, context.now)
  return store.db
    .query(
      `SELECT ${column} AS value, count(*) AS count FROM log_entry WHERE time_ms >= ? AND time_ms < ?
       AND ${column} IS NOT NULL GROUP BY ${column} ORDER BY count DESC, value LIMIT 20`,
    )
    .all(from, to) as Array<{ value: string; count: number }>
}

/** A session's turns, numbered from 1, newest last: the latest 20 (or all), or those before a time (paging back). */
export function turns(
  store: OperatorTelemetryStore.Store,
  sessionID: string,
  input: { all?: boolean; before?: number },
) {
  const rows = store.db
    .query("SELECT * FROM span WHERE session_id = ? AND kind = 'turn' ORDER BY start_ms, id")
    .all(sessionID) as OperatorTelemetryStore.Span[]
  const numbered = rows.map((span, index) => ({ span, number: index + 1 }))
  const earlierThan =
    input.before === undefined ? numbered : numbered.filter((item) => item.span.start_ms < input.before!)
  const shown = input.all ? earlierThan : earlierThan.slice(-20)
  return { turns: shown, earlier: shown.length < earlierThan.length }
}
