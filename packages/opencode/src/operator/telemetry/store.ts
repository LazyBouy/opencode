export * as OperatorTelemetryStore from "./store"

import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Database } from "bun:sqlite"
import { Global } from "@opencode-ai/core/global"

// The telemetry store (observability_spec.md §4): one SQLite file per server, `<data>/operator/telemetry.sqlite`, in
// WAL mode, opened like the queue (queue-store.ts). Spans are units of work (a turn, a model call, a tool call, a
// permission wait, ...), keyed by an id derived from their source (§4.5), so the same input processed twice updates a
// row instead of adding one. A write names only the columns it knows: the others keep their value (merge-upserts).
// `seq` grows on every insert or update, server-wide, for the live tail. Nothing here holds content (§4.7): no
// prompts, outputs, tool arguments or results, only short error messages and salted hashes.

export const SCHEMA_VERSION = 2

export const KINDS = [
  "turn",
  "model_call",
  "tool_call",
  "permission_wait",
  "subagent",
  "compaction",
  "retry",
  "helper_run",
  "queue_item",
  "alert",
] as const
export type Kind = (typeof KINDS)[number]

export const STATUSES = ["running", "ok", "error", "denied", "cancelled", "interrupted"] as const
export type Status = (typeof STATUSES)[number]

export type Span = {
  id: string
  seq: number
  kind: Kind
  name: string
  parent_id: string | null
  turn_id: string | null
  session_id: string | null
  root_session_id: string | null
  project_key: string | null
  directory: string | null
  agent: string | null
  agent_type: string | null
  model: string | null
  provider: string | null
  tool: string | null
  mcp_server: string | null
  status: Status
  error_type: string | null
  error_message: string | null
  http_status: number | null
  finish_reason: string | null
  start_ms: number
  end_ms: number | null
  duration_ms: number | null
  active_ms: number | null
  wait_ms: number | null
  ttft_ms: number | null
  attempt: number | null
  attempts: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  cost: number | null
  cost_billed: number | null
  context_tokens: number | null
  context_limit: number | null
  decision: string | null
  decision_source: string | null
  decided_by: string | null
  permission: string | null
  pattern: string | null
  args_hash: string | null
  result_hash: string | null
  loop: string | null
  call_id: string | null
  message_id: string | null
  part_id: string | null
  request_id: string | null
  source: string
  attrs: string | null
}

/** A write: the id, the kind, and the columns it knows. */
export type SpanWrite = { id: string; kind: Kind } & Partial<Omit<Span, "id" | "kind" | "seq">>

const SPAN_COLUMNS = [
  "kind",
  "name",
  "parent_id",
  "turn_id",
  "session_id",
  "root_session_id",
  "project_key",
  "directory",
  "agent",
  "agent_type",
  "model",
  "provider",
  "tool",
  "mcp_server",
  "status",
  "error_type",
  "error_message",
  "http_status",
  "finish_reason",
  "start_ms",
  "end_ms",
  "duration_ms",
  "active_ms",
  "wait_ms",
  "ttft_ms",
  "attempt",
  "attempts",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost",
  "cost_billed",
  "context_tokens",
  "context_limit",
  "decision",
  "decision_source",
  "decided_by",
  "permission",
  "pattern",
  "args_hash",
  "result_hash",
  "loop",
  "call_id",
  "message_id",
  "part_id",
  "request_id",
  "source",
  "attrs",
] as const satisfies ReadonlyArray<keyof Span>

/** One session's summary (§4.4), recomputed from its spans whenever they change. */
export type SessionRow = {
  id: string
  seq: number
  title: string | null
  agent: string | null
  agent_type: string | null
  project_key: string | null
  directory: string | null
  parent_id: string | null
  root_id: string | null
  status: string
  first_ms: number | null
  last_ms: number | null
  turns: number
  model_calls: number
  tool_calls: number
  errors: number
  denials: number
  retries: number
  wait_ms: number
  active_ms: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  cost: number
  cost_total: number
  cost_billed: number | null
  loop: string | null
  trashed: number
  turn_start_ms: number | null
  current: string | null
  subagents: number
  model: string | null
}

const SESSION_COLUMNS = [
  "id",
  "seq",
  "title",
  "agent",
  "agent_type",
  "project_key",
  "directory",
  "parent_id",
  "root_id",
  "status",
  "first_ms",
  "last_ms",
  "turns",
  "model_calls",
  "tool_calls",
  "errors",
  "denials",
  "retries",
  "wait_ms",
  "active_ms",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost",
  "cost_total",
  "cost_billed",
  "loop",
  "trashed",
  "turn_start_ms",
  "current",
  "subagents",
  "model",
] as const satisfies ReadonlyArray<keyof SessionRow>

export type LogEntry = {
  id: string
  seq: number
  time_ms: number
  level: string
  message: string
  run: string | null
  service: string | null
  session_id: string | null
  fields: string | null
}

export type Sample = { time_ms: number; name: string; dims: string | null; value: number }
export type McpStatus = { time_ms: number; directory: string; server: string; status: string; error: string | null }

// Schema version 1. A write names only some columns (the rest keep their value), and SQLite checks NOT NULL on the
// insert half of an upsert, so only `kind` is required; spans are created with their name, status, start and source.
// Later versions add their tables in MIGRATIONS (saved views, alerts, hourly totals come with their
// phases); a store is brought up to SCHEMA_VERSION when opened.
const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS span (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      parent_id TEXT, turn_id TEXT, session_id TEXT, root_session_id TEXT,
      project_key TEXT, directory TEXT, agent TEXT, agent_type TEXT, model TEXT, provider TEXT,
      tool TEXT, mcp_server TEXT,
      status TEXT,
      error_type TEXT, error_message TEXT, http_status INTEGER, finish_reason TEXT,
      start_ms INTEGER, end_ms INTEGER,
      duration_ms INTEGER, active_ms INTEGER, wait_ms INTEGER, ttft_ms INTEGER,
      attempt INTEGER, attempts INTEGER,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      cost REAL, cost_billed REAL, context_tokens INTEGER, context_limit INTEGER,
      decision TEXT, decision_source TEXT, decided_by TEXT, permission TEXT, pattern TEXT,
      args_hash TEXT, result_hash TEXT, loop TEXT,
      call_id TEXT, message_id TEXT, part_id TEXT, request_id TEXT,
      source TEXT,
      attrs TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS span_start ON span (start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_seq ON span (seq)`,
    `CREATE INDEX IF NOT EXISTS span_session ON span (session_id, start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_root ON span (root_session_id)`,
    `CREATE INDEX IF NOT EXISTS span_turn ON span (turn_id)`,
    `CREATE INDEX IF NOT EXISTS span_parent ON span (parent_id)`,
    `CREATE INDEX IF NOT EXISTS span_kind ON span (kind, start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_project ON span (project_key, start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_status ON span (status, start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_agent ON span (agent, start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_model ON span (model, start_ms)`,
    `CREATE INDEX IF NOT EXISTS span_tool ON span (tool, start_ms)`,
    `CREATE TABLE IF NOT EXISTS session_row (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      title TEXT, agent TEXT, agent_type TEXT, project_key TEXT, directory TEXT, parent_id TEXT, root_id TEXT,
      status TEXT NOT NULL,
      first_ms INTEGER, last_ms INTEGER,
      turns INTEGER NOT NULL, model_calls INTEGER NOT NULL, tool_calls INTEGER NOT NULL,
      errors INTEGER NOT NULL, denials INTEGER NOT NULL, retries INTEGER NOT NULL,
      wait_ms INTEGER NOT NULL, active_ms INTEGER NOT NULL,
      tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL, tokens_reasoning INTEGER NOT NULL,
      tokens_cache_read INTEGER NOT NULL, tokens_cache_write INTEGER NOT NULL,
      cost REAL NOT NULL, cost_total REAL NOT NULL, cost_billed REAL,
      loop TEXT, trashed INTEGER NOT NULL, turn_start_ms INTEGER, current TEXT,
      subagents INTEGER NOT NULL, model TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS session_row_last ON session_row (last_ms)`,
    `CREATE INDEX IF NOT EXISTS session_row_parent ON session_row (parent_id)`,
    `CREATE INDEX IF NOT EXISTS session_row_project ON session_row (project_key, last_ms)`,
    `CREATE TABLE IF NOT EXISTS log_entry (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      time_ms INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      run TEXT, service TEXT, session_id TEXT, fields TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS log_entry_time ON log_entry (time_ms)`,
    `CREATE INDEX IF NOT EXISTS log_entry_seq ON log_entry (seq)`,
    `CREATE INDEX IF NOT EXISTS log_entry_session ON log_entry (session_id)`,
    `CREATE TABLE IF NOT EXISTS mcp_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_ms INTEGER NOT NULL, directory TEXT NOT NULL, server TEXT NOT NULL, status TEXT NOT NULL, error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS mcp_status_time ON mcp_status (time_ms)`,
    `CREATE TABLE IF NOT EXISTS sample (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_ms INTEGER NOT NULL, name TEXT NOT NULL, dims TEXT, value REAL NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS sample_name ON sample (name, time_ms)`,
    `CREATE TABLE IF NOT EXISTS kept_session (session_id TEXT PRIMARY KEY, time_ms INTEGER NOT NULL)`,
  ],
  // Version 2: hourly totals (§6.2), what spans that went left in them, and the hours to recompute.
  [
    ...(["total_hour", "total_frozen"] as const).flatMap((table) => [
      `CREATE TABLE IF NOT EXISTS ${table} (
        hour_ms INTEGER NOT NULL,
        kind TEXT, project_key TEXT, agent TEXT, agent_type TEXT, model TEXT, provider TEXT,
        tool TEXT, mcp_server TEXT, status TEXT, error_type TEXT,
        count INTEGER NOT NULL, duration_ms INTEGER NOT NULL, active_ms INTEGER NOT NULL, wait_ms INTEGER NOT NULL,
        tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL, tokens_reasoning INTEGER NOT NULL,
        tokens_cache_read INTEGER NOT NULL, tokens_cache_write INTEGER NOT NULL,
        cost REAL NOT NULL, cost_side REAL NOT NULL, cost_billed REAL NOT NULL,
        http_429 INTEGER NOT NULL, retries INTEGER NOT NULL, loops INTEGER NOT NULL,
        hist_active TEXT NOT NULL, hist_ttft TEXT NOT NULL, hist_wait TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${table}_hour ON ${table} (hour_ms)`,
    ]),
    `CREATE TABLE IF NOT EXISTS dirty_hour (hour_ms INTEGER PRIMARY KEY)`,
  ],
]

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ")

export class Store {
  readonly db: Database
  readonly file: string
  private seq: number
  private readonly upsertSpanStmt
  private readonly upsertSessionStmt

  constructor(file: string) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file, { create: true })
    // Purging frees pages as it goes (§6.1); set before the first table, or converted once below.
    this.db.exec("PRAGMA auto_vacuum = INCREMENTAL")
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.migrate()
    this.seq = Number(this.meta("seq") ?? 0)
    // A column the write leaves out keeps its value: COALESCE(new, old).
    this.upsertSpanStmt = this.db.prepare(
      `INSERT INTO span (id, seq, ${SPAN_COLUMNS.join(", ")}) VALUES (${placeholders(SPAN_COLUMNS.length + 2)})
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, ${SPAN_COLUMNS.map(
         (column) => `${column} = COALESCE(excluded.${column}, span.${column})`,
       ).join(", ")}`,
    )
    this.upsertSessionStmt = this.db.prepare(
      `INSERT OR REPLACE INTO session_row (${SESSION_COLUMNS.join(", ")}) VALUES (${placeholders(SESSION_COLUMNS.length)})`,
    )
  }

  private migrate() {
    this.db.exec(MIGRATIONS[0]![0]!)
    const version = Number(this.meta("schema_version") ?? 0)
    if (version > SCHEMA_VERSION) return
    this.db.transaction(() => {
      MIGRATIONS.slice(version).forEach((steps) => steps.forEach((step) => this.db.exec(step)))
      this.setMeta("schema_version", String(SCHEMA_VERSION))
    })()
    if (!this.meta("secret")) this.setMeta("secret", crypto.randomBytes(32).toString("hex"))
    const vacuum = this.db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null
    if (vacuum?.auto_vacuum !== 2) this.db.exec("VACUUM")
  }

  meta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
    return row?.value
  }

  setMeta(key: string, value: string) {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
  }

  /** The highest `seq` written. */
  lastSeq() {
    return this.seq
  }

  nextSeq() {
    this.seq += 1
    return this.seq
  }

  /** Runs `work` in one transaction, then keeps the `seq` reached. */
  transaction<T>(work: () => T): T {
    const result = this.db.transaction(() => {
      const value = work()
      this.setMeta("seq", String(this.seq))
      return value
    })()
    return result
  }

  upsertSpan(write: SpanWrite) {
    const values = SPAN_COLUMNS.map((column) => {
      const value = (write as Record<string, unknown>)[column]
      return value === undefined ? null : (value as string | number | null)
    })
    this.upsertSpanStmt.run(write.id, this.nextSeq(), ...values)
  }

  deleteSpan(id: string) {
    this.db.query("DELETE FROM span WHERE id = ?").run(id)
  }

  span(id: string): Span | undefined {
    return (this.db.query("SELECT * FROM span WHERE id = ?").get(id) as Span | null) ?? undefined
  }

  spansOfTurn(turnID: string): Span[] {
    return this.db
      .query("SELECT * FROM span WHERE turn_id = ? AND id != ? ORDER BY start_ms, id")
      .all(turnID, turnID) as Span[]
  }

  children(parentID: string): Span[] {
    return this.db.query("SELECT * FROM span WHERE parent_id = ? ORDER BY start_ms, id").all(parentID) as Span[]
  }

  spansOfSession(sessionID: string): Span[] {
    return this.db.query("SELECT * FROM span WHERE session_id = ? ORDER BY start_ms, id").all(sessionID) as Span[]
  }

  /** Spans still running that started before `before` (a server restart). */
  running(before: number): Span[] {
    return this.db.query("SELECT * FROM span WHERE status = 'running' AND start_ms < ?").all(before) as Span[]
  }

  upsertSession(row: Omit<SessionRow, "seq">) {
    const full: SessionRow = { ...row, seq: this.nextSeq() }
    this.upsertSessionStmt.run(...SESSION_COLUMNS.map((column) => full[column] as string | number | null))
  }

  session(id: string): SessionRow | undefined {
    return (this.db.query("SELECT * FROM session_row WHERE id = ?").get(id) as SessionRow | null) ?? undefined
  }

  childSessions(parentID: string): SessionRow[] {
    return this.db.query("SELECT * FROM session_row WHERE parent_id = ?").all(parentID) as SessionRow[]
  }

  /** A session deleted for good (§5.10): its spans, summary and keep go; its log lines lose the link. */
  deleteSession(sessionID: string) {
    this.db.query("DELETE FROM span WHERE session_id = ?").run(sessionID)
    this.db.query("DELETE FROM session_row WHERE id = ?").run(sessionID)
    this.db.query("DELETE FROM kept_session WHERE session_id = ?").run(sessionID)
    this.db.query("UPDATE log_entry SET session_id = NULL WHERE session_id = ?").run(sessionID)
  }

  insertLog(entry: Omit<LogEntry, "seq">) {
    this.db
      .query(
        `INSERT INTO log_entry (id, seq, time_ms, level, message, run, service, session_id, fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        entry.id,
        this.nextSeq(),
        entry.time_ms,
        entry.level,
        entry.message,
        entry.run,
        entry.service,
        entry.session_id,
        entry.fields,
      )
  }

  logs(): LogEntry[] {
    return this.db.query("SELECT * FROM log_entry ORDER BY time_ms, id").all() as LogEntry[]
  }

  insertSample(sample: Sample) {
    this.db
      .query("INSERT INTO sample (time_ms, name, dims, value) VALUES (?, ?, ?, ?)")
      .run(sample.time_ms, sample.name, sample.dims, sample.value)
  }

  samples(name?: string): Sample[] {
    return (
      name
        ? this.db.query("SELECT time_ms, name, dims, value FROM sample WHERE name = ? ORDER BY time_ms, id").all(name)
        : this.db.query("SELECT time_ms, name, dims, value FROM sample ORDER BY time_ms, id").all()
    ) as Sample[]
  }

  insertMcpStatus(row: McpStatus) {
    this.db
      .query("INSERT INTO mcp_status (time_ms, directory, server, status, error) VALUES (?, ?, ?, ?, ?)")
      .run(row.time_ms, row.directory, row.server, row.status, row.error)
  }

  mcpStatuses(): McpStatus[] {
    return this.db
      .query("SELECT time_ms, directory, server, status, error FROM mcp_status ORDER BY time_ms, id")
      .all() as McpStatus[]
  }

  close() {
    this.db.close()
  }
}

export function file() {
  return path.join(Global.Path.data, "operator", "telemetry.sqlite")
}

let opened: Store | undefined
/** The server's store, opened on first use. */
export function store(): Store {
  if (opened && opened.file === file()) return opened
  opened?.close()
  opened = new Store(file())
  return opened
}

/** Closes the store (tests, and Clear telemetry). */
export function close() {
  opened?.close()
  opened = undefined
}
