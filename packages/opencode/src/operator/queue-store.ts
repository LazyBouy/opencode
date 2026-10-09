export * as OperatorQueueStore from "./queue-store"

import fs from "fs"
import path from "path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// The agents' input queues (project/agent specification §1.6): messages for an agent, each delivered to
// a session (the one it names, else the agent's main or active session). This is the store behind
// them, an interface with one backend for now: a SQLite file the fork owns,
// `<data>/operator/queue.sqlite`, durable across restarts. A broker (RabbitMQ) can be another backend
// later; when a message is delivered stays OpenCode's business (operator/queue.ts), since it depends on
// whether its session is running.

export const Target = Schema.Literals(["session", "main", "active"]).annotate({
  identifier: "OperatorQueueTarget",
  description: "session: the session it names; main / active: the agent's main or active session",
})
export type Target = typeof Target.Type

export const Priority = Schema.Literals(["low", "normal", "high", "urgent"]).annotate({
  identifier: "OperatorQueuePriority",
})
export type Priority = typeof Priority.Type

export const Status = Schema.Literals(["queued", "delivered", "failed", "cancelled"]).annotate({
  identifier: "OperatorQueueStatus",
})
export type Status = typeof Status.Type

export const Sender = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system"]),
  agent: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorQueueSender" })
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
  status: Status,
  createdAt: Schema.Finite,
  deliveredAt: Schema.optional(Schema.Finite),
  deliveredTo: Schema.optional(Schema.String).annotate({ description: "The session it was delivered to" }),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorQueueItem" })
export type Item = typeof Item.Type

export type NewItem = Omit<Item, "id" | "status" | "createdAt" | "deliveredAt" | "deliveredTo" | "error">

export interface Backend {
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
  db.exec("CREATE INDEX IF NOT EXISTS queue_item_agent ON queue_item (project, agent, status)")
  db.exec("CREATE INDEX IF NOT EXISTS queue_item_status ON queue_item (status)")
  const order = "ORDER BY priority DESC, created_at ASC, id ASC"
  return {
    enqueue(item) {
      const row: Row = {
        id: newID(),
        project: item.project,
        agent: item.agent,
        target: item.target,
        session_id: item.sessionID ?? null,
        text: item.text,
        priority: RANK[item.priority],
        steer: item.steer ? 1 : 0,
        sender: JSON.stringify(item.sender),
        correlation_id: item.correlationID ?? null,
        status: "queued",
        created_at: Date.now(),
        delivered_at: null,
        delivered_to: null,
        error: null,
      }
      db.query(
        `INSERT INTO queue_item VALUES ($id, $project, $agent, $target, $session_id, $text, $priority, $steer, $sender, $correlation_id, $status, $created_at, $delivered_at, $delivered_to, $error)`,
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
