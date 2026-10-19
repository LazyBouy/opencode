export * as OperatorTelemetryExport from "./export"

import { OperatorTelemetryQuery as Q } from "./query"
import type { OperatorTelemetryStore } from "./store"

// Export (observability_spec.md §16): the current filter, sort and range of Sessions, Events or Logs, as CSV (the
// visible columns) or JSON Lines (every stored field, one object per row), up to 100,000 rows, written a page at a time.
// CSV is RFC 4180 in UTF-8, times ISO 8601 with the viewer's offset, and a cell a spreadsheet would run as a formula
// gets a leading '. It holds only what the store holds (§4.7): no content.

export const LIMIT = 100_000
export const TABS = ["sessions", "events", "logs"] as const
export type Tab = (typeof TABS)[number]
export type Format = "csv" | "jsonl"
type Row = Record<string, unknown>
type Value = string | number | null | undefined

/** A time as ISO 8601 with an offset (minutes east of UTC, as the viewer's clock has it). */
export function isoAt(ms: number | null | undefined, offset: number) {
  if (ms === null || ms === undefined) return null
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 23)
  const sign = offset >= 0 ? "+" : "-"
  const abs = Math.abs(offset)
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

/** One CSV cell: quoted when it must be, a formula defused. Numbers stay as they are. */
export function cell(value: Value) {
  if (value === null || value === undefined) return ""
  const text = typeof value === "string" && /^[=+\-@]/.test(value) ? `'${value}` : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const line = (values: ReadonlyArray<Value>) => `${values.map(cell).join(",")}\r\n`

// The page's columns (their ids) as stored fields; tokens are always split, never one mixed total.
type Column = { fields: string[]; value?: (row: Row, offset: number) => Value[] }
const time = (field: string): Column => ({
  fields: [field],
  value: (row, offset) => [isoAt(row[field] as number, offset)],
})
const plain = (...fields: string[]): Column => ({ fields })
const TOKENS = plain("tokens_input", "tokens_cache_read", "tokens_cache_write", "tokens_output", "tokens_reasoning")

const COLUMNS: Record<Tab, Record<string, Column>> = {
  events: {
    start: time("start_ms"),
    kind: plain("kind"),
    name: plain("name"),
    status: plain("status"),
    active: plain("active_ms"),
    wait: plain("wait_ms"),
    session: plain("session_id"),
    agent: plain("agent"),
    project: plain("project_key"),
    model: plain("model"),
    tool: plain("tool"),
    http: plain("http_status"),
    attempt: plain("attempt", "attempts"),
    ttft: plain("ttft_ms"),
    tokens: TOKENS,
    cost: plain("cost"),
    error: plain("error_type", "error_message"),
    decision: plain("decision"),
  },
  sessions: {
    status: plain("status"),
    title: plain("id", "title"),
    agent: plain("agent"),
    project: plain("project_key"),
    started: time("first_ms"),
    lastActivity: time("last_ms"),
    duration: { fields: ["duration_ms"], value: (row) => [durationOf(row)] },
    active: plain("active_ms"),
    wait: plain("wait_ms"),
    turns: plain("turns"),
    modelCalls: plain("model_calls"),
    toolCalls: plain("tool_calls"),
    errors: plain("errors"),
    denials: plain("denials"),
    retries: plain("retries"),
    tokens: TOKENS,
    cacheHit: { fields: ["cache_hit"], value: (row) => [cacheHit(row)] },
    cost: plain("cost_total"),
    model: plain("model"),
    // Namespace is worked out by the page from the project records, not stored: not exported.
    subagents: plain("subagents"),
    loop: plain("loop"),
  },
  logs: {
    time: time("time_ms"),
    level: plain("level"),
    message: plain("message"),
    service: plain("service"),
    session: plain("session_id"),
    run: plain("run"),
    fields: plain("fields"),
  },
}
// What each tab exports when no columns are named.
export const DEFAULT_COLUMNS: Record<Tab, string[]> = {
  events: ["start", "kind", "name", "status", "active", "session", "agent", "tokens", "cost", "error"],
  sessions: ["status", "title", "agent", "project", "started", "lastActivity", "turns", "tokens", "cost"],
  logs: ["time", "level", "message", "service", "session", "run", "fields"],
}

const durationOf = (row: Row) =>
  typeof row.first_ms === "number" && typeof row.last_ms === "number" ? row.last_ms - row.first_ms : null
const cacheHit = (row: Row) => {
  const read = Number(row.tokens_cache_read ?? 0)
  const total = Number(row.tokens_input ?? 0) + read + Number(row.tokens_cache_write ?? 0)
  return total ? Math.round((read / total) * 1000) / 10 : null
}

/** The CSV columns for a tab: the ids asked for (unknown ones left out), in order, each id's fields once. */
export function columnsOf(tab: Tab, ids: ReadonlyArray<string> | undefined) {
  const chosen = (ids?.length ? ids : DEFAULT_COLUMNS[tab]).filter((id) => COLUMNS[tab][id])
  const seen = new Set<string>()
  return [...new Set(chosen)].flatMap((id) => {
    const column = COLUMNS[tab][id]!
    if (column.fields.every((field) => seen.has(field))) return []
    column.fields.forEach((field) => seen.add(field))
    return [column]
  })
}

export type Input = {
  tab: Tab
  filter: Q.Filter & Q.LogFilter
  context: Q.Context
  sort?: string
}

/** How many rows the export would hold. */
export function count(store: OperatorTelemetryStore.Store, input: Input) {
  const where =
    input.tab === "events"
      ? { table: "span", clause: Q.spanWhere(input.filter, input.context) }
      : input.tab === "sessions"
        ? { table: "session_row", clause: Q.sessionWhere(input.filter, input.context) }
        : { table: "log_entry", clause: Q.logWhere(input.filter, input.context.now) }
  return (
    store.db
      .query(`SELECT count(*) AS n FROM ${where.table} WHERE ${where.clause.sql}`)
      .get(...where.clause.params) as {
      n: number
    }
  ).n
}

/** The rows a page at a time, in the tab's sort, up to the limit. */
export function* rows(store: OperatorTelemetryStore.Store, input: Input, limit = LIMIT): Generator<Row[]> {
  let cursor: string | undefined
  let sent = 0
  while (sent < limit) {
    const size = Math.min(500, limit - sent)
    const options = { ...(input.sort ? { sort: input.sort } : {}), ...(cursor ? { cursor } : {}), limit: size }
    const page =
      input.tab === "events"
        ? Q.events(store, input.filter, input.context, options)
        : input.tab === "sessions"
          ? Q.sessions(store, input.filter, input.context, options)
          : Q.logs(store, input.filter, input.context, { ...(cursor ? { cursor } : {}), limit: size })
    if (!page.rows.length) return
    yield page.rows as unknown as Row[]
    sent += page.rows.length
    if (!page.nextCursor) return
    cursor = page.nextCursor
  }
}

/** The export's text, a chunk at a time: CSV's header then rows, or JSON Lines. */
export function* lines(
  store: OperatorTelemetryStore.Store,
  input: Input & { format: Format; columns?: ReadonlyArray<string>; offset: number },
  limit = LIMIT,
): Generator<string> {
  const columns = columnsOf(input.tab, input.columns)
  if (input.format === "csv") yield line(columns.flatMap((column) => column.fields))
  for (const page of rows(store, input, limit)) {
    let chunk = ""
    for (const row of page)
      chunk +=
        input.format === "jsonl"
          ? `${JSON.stringify(row)}\n`
          : line(
              columns.flatMap((column) =>
                column.value ? column.value(row, input.offset) : column.fields.map((field) => row[field] as Value),
              ),
            )
    yield chunk
  }
}

/** The file's name: opencode-<tab>-<from>-<to>.<ext>, dates in the viewer's time. */
export function filename(tab: Tab, format: Format, range: { from: number; to: number }, offset: number) {
  const day = (ms: number) => (isoAt(ms, offset) ?? "").slice(0, 16).replace(/[-:T]/g, "")
  return `opencode-${tab}-${day(range.from)}-${day(range.to)}.${format === "csv" ? "csv" : "jsonl"}`
}
