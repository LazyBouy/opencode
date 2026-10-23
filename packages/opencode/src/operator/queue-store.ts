export * as OperatorQueueStore from "./queue-store"

import fs from "fs"
import path from "path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// The agents' input queues (project/agent specification §1.6): messages for an agent, each delivered to
// a session (the one it names, else the agent's main or active session). This is the store behind
// them, the session queues' SQLite lane (SPEC-0023 §6), an interface with one backend: a SQLite file the fork
// owns, `<data>/operator/queue.sqlite`, durable across restarts. A message for a session that is running a turn
// is held in its memory lane instead (messaging/lanes.ts) and comes here when the turn ends; the message log
// (messaging/log.ts) keeps every message's history in the same file. When a message is delivered stays OpenCode's
// business (operator/queue.ts), since it depends on whether its session is running.

export const Target = Schema.Literals(["session", "main", "active", "new"]).annotate({
  identifier: "OperatorQueueTarget",
  description:
    "session: the session it names; main / active: the agent's main or active session; new: a new session of the agent, made when it's delivered",
})
export type Target = typeof Target.Type

export const Priority = Schema.Literals(["low", "normal", "high", "urgent"]).annotate({
  identifier: "OperatorQueuePriority",
})
export type Priority = typeof Priority.Type

export const Status = Schema.Literals(["queued", "in memory", "delivered", "failed", "cancelled"]).annotate({
  identifier: "OperatorQueueStatus",
  description: "in memory: held for a session that is running a turn (its memory lane), until the turn ends",
})
export type Status = typeof Status.Type

export const Sender = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system", "external"]),
  agent: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String).annotate({ description: "The sender's project, when it isn't this one" }),
}).annotate({ identifier: "OperatorQueueSender" })

export const Lane = Schema.Literals(["memory", "sqlite"]).annotate({
  identifier: "OperatorQueueLane",
  description: "memory: held while its session ran a turn; sqlite: waited in the queue for its session to be idle",
})
export type Lane = typeof Lane.Type
export type Sender = typeof Sender.Type

export const Item = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  agent: Schema.String,
  target: Target,
  sessionID: Schema.optional(Schema.String).annotate({ description: "The session it names (target session)" }),
  text: Schema.String,
  priority: Priority,
  steer: Schema.Boolean.annotate({ description: "Delivered at once, even into a running session" }),
  sender: Sender,
  correlationID: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String).annotate({ description: "The message this one answers" }),
  lane: Schema.optional(Lane),
  via: Schema.optional(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The Project inbox message" }),
      manager: Schema.optional(Schema.Boolean).annotate({ description: "Given to the manager to route" }),
    }).annotate({ identifier: "OperatorQueueVia" }),
  ).annotate({ description: "The Project inbox message it was routed from" }),
  status: Status,
  createdAt: Schema.Finite,
  deliveredAt: Schema.optional(Schema.Finite),
  deliveredTo: Schema.optional(Schema.String).annotate({ description: "The session it was delivered to" }),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorQueueItem" })
export type Item = typeof Item.Type

export type NewItem = Omit<Item, "id" | "status" | "createdAt" | "deliveredAt" | "deliveredTo" | "error"> &
  Partial<Pick<Item, "id" | "status" | "createdAt" | "deliveredAt" | "deliveredTo">>

export interface Backend {
  /** The file it keeps its tables in (the message log keeps its own there too). */
  readonly file: string
  /** Adds a message (queued unless given otherwise); an id, time and status can be given, as a moved one keeps its. */
  enqueue(item: NewItem): Item
  get(id: string): Item | undefined
  /** Items in delivery order: priority first (urgent to low), then oldest first. */
  list(filter: { project?: string; agent?: string; status?: Status; limit?: number }): Item[]
  /** Agents (by project) with queued items. */
  pending(): Array<{ project: string; agent: string }>
  update(id: string, patch: Partial<Pick<Item, "status" | "deliveredAt" | "deliveredTo" | "error">>): Item | undefined
  /** A folder moved (layout-move.ts): items of projects in it point at the new folder. The rows changed. */
  movePaths(from: string, to: string): number
}

const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }
const PRIORITY = Object.fromEntries(Object.entries(RANK).map(([key, value]) => [value, key])) as Record<
  number,
  Priority
>

type Row = {
  id: string
  project: string
  agent: string
  target: string
  session_id: string | null
  text: string
  priority: number
  steer: number
  sender: string
  correlation_id: string | null
  status: string
  created_at: number
  delivered_at: number | null
  delivered_to: string | null
  error: string | null
  lane: string | null
  reply_to: string | null
  via: string | null
}

function itemOf(row: Row): Item {
  return {
    id: row.id,
    project: row.project,
    agent: row.agent,
    target: row.target as Target,
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    text: row.text,
    priority: PRIORITY[row.priority] ?? "normal",
    steer: !!row.steer,
    sender: JSON.parse(row.sender) as Sender,
    ...(row.correlation_id ? { correlationID: row.correlation_id } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    ...(row.lane ? { lane: row.lane as Lane } : {}),
    ...(row.via ? { via: JSON.parse(row.via) as NonNullable<Item["via"]> } : {}),
    status: row.status as Status,
    createdAt: row.created_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.delivered_to ? { deliveredTo: row.delivered_to } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}

let sequence = 0
const newID = () =>
  `qm_${Date.now().toString(36)}${(sequence++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`

// The SQLite backend.
export function sqlite(file: string): Backend {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`CREATE TABLE IF NOT EXISTS queue_item (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    agent TEXT NOT NULL,
    target TEXT NOT NULL,
    session_id TEXT,
    text TEXT NOT NULL,
    priority INTEGER NOT NULL,
    steer INTEGER NOT NULL,
    sender TEXT NOT NULL,
    correlation_id TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    delivered_to TEXT,
    error TEXT
  )`)
  // Columns added since (SPEC-0023): the lane a message went through, and the message it answers.
  const columns = new Set(
    (db.query("PRAGMA table_info(queue_item)").all() as Array<{ name: string }>).map((row) => row.name),
  )
  if (!columns.has("lane")) db.exec("ALTER TABLE queue_item ADD COLUMN lane TEXT")
  if (!columns.has("reply_to")) db.exec("ALTER TABLE queue_item ADD COLUMN reply_to TEXT")
  if (!columns.has("via")) db.exec("ALTER TABLE queue_item ADD COLUMN via TEXT")
  db.exec("CREATE INDEX IF NOT EXISTS queue_item_agent ON queue_item (project, agent, status)")
  db.exec("CREATE INDEX IF NOT EXISTS queue_item_status ON queue_item (status)")
  const order = "ORDER BY priority DESC, created_at ASC, id ASC"
  return {
    file,
    enqueue(item) {
      const row: Row = {
        id: item.id ?? newID(),
        project: item.project,
        agent: item.agent,
        target: item.target,
        session_id: item.sessionID ?? null,
        text: item.text,
        priority: RANK[item.priority],
        steer: item.steer ? 1 : 0,
        sender: JSON.stringify(item.sender),
        correlation_id: item.correlationID ?? null,
        status: item.status ?? "queued",
        created_at: item.createdAt ?? Date.now(),
        delivered_at: item.deliveredAt ?? null,
        delivered_to: item.deliveredTo ?? null,
        error: null,
        lane: item.lane ?? null,
        reply_to: item.replyTo ?? null,
        via: item.via ? JSON.stringify(item.via) : null,
      }
      const names = Object.keys(row)
      db.query(
        `INSERT OR REPLACE INTO queue_item (${names.join(", ")}) VALUES (${names.map((name) => `$${name}`).join(", ")})`,
      ).run(Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value])) as never)
      return itemOf(row)
    },
    get(id) {
      const row = db.query("SELECT * FROM queue_item WHERE id = ?").get(id) as Row | null
      return row ? itemOf(row) : undefined
    },
    list(filter) {
      const where = Object.entries({ project: filter.project, agent: filter.agent, status: filter.status }).filter(
        (entry): entry is [string, string] => !!entry[1],
      )
      const sql = [
        "SELECT * FROM queue_item",
        where.length ? `WHERE ${where.map(([column]) => `${column} = ?`).join(" AND ")}` : "",
        filter.status === "queued" ? order : "ORDER BY created_at DESC, id DESC",
        filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "",
      ].join(" ")
      return (db.query(sql).all(...where.map(([, value]) => value)) as Row[]).map(itemOf)
    },
    pending() {
      return db.query("SELECT DISTINCT project, agent FROM queue_item WHERE status = 'queued'").all() as Array<{
        project: string
        agent: string
      }>
    },
    update(id, patch) {
      const columns = {
        status: patch.status,
        delivered_at: patch.deliveredAt,
        delivered_to: patch.deliveredTo,
        error: patch.error,
      }
      const sets = Object.entries(columns).filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      if (sets.length)
        db.query(`UPDATE queue_item SET ${sets.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
          ...sets.map(([, value]) => value),
          id,
        )
      return this.get(id)
    },
    movePaths(from, to) {
      // By prefix, not LIKE: a folder name can hold `_` or `%`.
      const prefix = `${from}/`
      return db
        .query("UPDATE queue_item SET project = ? || substr(project, ?) WHERE project = ? OR substr(project, 1, ?) = ?")
        .run(to, from.length + 1, from, prefix.length, prefix).changes
    },
  }
}

// The store the server uses (opened on first use).
let opened: Backend | undefined
export function store(): Backend {
  return (opened ??= sqlite(path.join(Global.Path.data, "operator", "queue.sqlite")))
}

// For tests: a store of their own.
export function use(backend: Backend | undefined) {
  opened = backend
}
