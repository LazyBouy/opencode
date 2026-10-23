export * as OperatorMessageLog from "./log"

import fs from "fs/promises"
import path from "path"
import { Database } from "bun:sqlite"
import { Global } from "@opencode-ai/core/global"
import { OperatorQueueStore } from "../queue-store"
import { OperatorMessage } from "./message"

// The message log (SPEC-0023 §6.4): every message and what happened to it, in the queue's SQLite file
// (`queue.sqlite`, one file), keyed by the source project's unique id so a move never rewrites it. It's written in
// batches, one transaction each, off the sender's path; a read writes what's waiting first. At server start, a
// message it shows as `in memory` (held for a running session when the server stopped) goes back to its
// session's SQLite lane (queue.ts).

type Message = OperatorMessage.Message
type Patch = Partial<Pick<Message, "status" | "sessionID" | "lane" | "deliveredAt" | "agent" | "routedBy" | "routedTo">>

/** A filter of the log. `from`: a sender's kind (user, agent, system, external) or an agent's name. */
export type Filter = {
  project?: string
  inbox?: string
  /** Routed copies of this inbox message. */
  via?: string
  status?: OperatorMessage.Status
  correlationID?: string
  from?: string
  limit?: number
}

export interface Log {
  /** A new message, or one written again whole. */
  write(message: Message): void
  /** A step of a message's history, with what changed. */
  step(id: string, step: { kind: string; detail?: string }, patch?: Patch): void
  get(id: string): Message | undefined
  list(filter: Filter): Message[]
  /** Per Project inbox: messages waiting for the manager, and dead letters. */
  counts(): Record<string, { waiting: number; deadLetters: number }>
  /** Takes a message and its history out of the log (it went to Trash). */
  remove(id: string): void
  /** Writes what's waiting now (tests; reads do it themselves). */
  flush(): void
}

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const
const PRIORITY = ["low", "normal", "high", "urgent"] as const

type Row = {
  id: string
  project: string
  folder: string | null
  sender: string
  recipient: string
  body: string
  priority: number
  steer: number
  correlation_id: string
  reply_to: string | null
  hops: number
  status: string
  agent: string | null
  session_id: string | null
  lane: string | null
  created_at: number
  delivered_at: number | null
  updated_at: number
  inbox: string | null
  via: string | null
  routed_by: string | null
  routed_to: string | null
}

export function sqlite(file: string): Log {
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    folder TEXT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    priority INTEGER NOT NULL,
    steer INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    reply_to TEXT,
    hops INTEGER NOT NULL,
    status TEXT NOT NULL,
    agent TEXT,
    session_id TEXT,
    lane TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    updated_at INTEGER NOT NULL
  )`)
  // Columns added later (the Project inbox, phase 3).
  const columns = new Set((db.query("PRAGMA table_info(message)").all() as Array<{ name: string }>).map((c) => c.name))
  for (const column of ["inbox", "via", "routed_by", "routed_to"])
    if (!columns.has(column)) db.exec(`ALTER TABLE message ADD COLUMN ${column} TEXT`)
  db.exec("CREATE INDEX IF NOT EXISTS message_project ON message (project, status, created_at)")
  db.exec("CREATE INDEX IF NOT EXISTS message_inbox ON message (inbox, status, created_at)")
  db.exec("CREATE INDEX IF NOT EXISTS message_status ON message (status)")
  db.exec("CREATE INDEX IF NOT EXISTS message_correlation ON message (correlation_id)")
  db.exec(`CREATE TABLE IF NOT EXISTS message_step (
    message_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
  )`)
  db.exec("CREATE INDEX IF NOT EXISTS message_step_id ON message_step (message_id, at)")

  const insert =
    db.query(`INSERT OR REPLACE INTO message (id, project, folder, sender, recipient, body, priority, steer,
    correlation_id, reply_to, hops, status, agent, session_id, lane, created_at, delivered_at, updated_at, inbox, via,
    routed_by, routed_to)
    VALUES ($id, $project, $folder, $sender, $recipient, $body, $priority, $steer, $correlation_id, $reply_to, $hops,
    $status, $agent, $session_id, $lane, $created_at, $delivered_at, $updated_at, $inbox, $via, $routed_by, $routed_to)`)
  const addStep = db.query("INSERT INTO message_step (message_id, at, kind, detail) VALUES (?, ?, ?, ?)")

  // What waits for the next batch, in order.
  const waiting: Array<() => void> = []
  let scheduled = false
  const flush = () => {
    scheduled = false
    if (!waiting.length) return
    const work = waiting.splice(0)
    db.transaction(() => {
      for (const run of work) run()
    })()
  }
  const later = (run: () => void) => {
    waiting.push(run)
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      try {
        flush()
      } catch {
        // the log never stops a message; the next batch tries again with what came after
      }
    }, 0)
  }

  const messageOf = (row: Row): Message => ({
    id: row.id,
    project: row.project,
    ...(row.folder ? { folder: row.folder } : {}),
    from: JSON.parse(row.sender),
    to: JSON.parse(row.recipient),
    body: JSON.parse(row.body),
    priority: PRIORITY[row.priority] ?? "normal",
    steer: !!row.steer,
    correlationID: row.correlation_id,
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    hops: row.hops,
    status: row.status as OperatorMessage.Status,
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    ...(row.lane ? { lane: row.lane as OperatorQueueStore.Lane } : {}),
    createdAt: row.created_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.inbox ? { inbox: row.inbox } : {}),
    ...(row.via ? { via: row.via } : {}),
    ...(row.routed_by ? { routedBy: row.routed_by } : {}),
    ...(row.routed_to ? { routedTo: JSON.parse(row.routed_to) } : {}),
    trail: (
      db
        .query("SELECT at, kind, detail FROM message_step WHERE message_id = ? ORDER BY at, rowid")
        .all(row.id) as Array<{
        at: number
        kind: string
        detail: string | null
      }>
    ).map((step) => ({ at: step.at, kind: step.kind, ...(step.detail ? { detail: step.detail } : {}) })),
  })

  return {
    write(message) {
      const at = Date.now()
      later(() => {
        insert.run({
          $id: message.id,
          $project: message.project,
          $folder: message.folder ?? null,
          $sender: JSON.stringify(message.from),
          $recipient: JSON.stringify(message.to),
          $body: JSON.stringify(message.body),
          $priority: RANK[message.priority],
          $steer: message.steer ? 1 : 0,
          $correlation_id: message.correlationID,
          $reply_to: message.replyTo ?? null,
          $hops: message.hops,
          $status: message.status,
          $agent: message.agent ?? null,
          $session_id: message.sessionID ?? null,
          $lane: message.lane ?? null,
          $created_at: message.createdAt,
          $delivered_at: message.deliveredAt ?? null,
          $updated_at: at,
          $inbox: message.inbox ?? null,
          $via: message.via ?? null,
          $routed_by: message.routedBy ?? null,
          $routed_to: message.routedTo ? JSON.stringify(message.routedTo) : null,
        } as never)
        for (const step of message.trail) addStep.run(message.id, step.at, step.kind, step.detail ?? null)
      })
    },
    step(id, step, patch = {}) {
      const at = Date.now()
      later(() => {
        addStep.run(id, at, step.kind, step.detail ?? null)
        const columns = {
          status: patch.status,
          session_id: patch.sessionID,
          lane: patch.lane,
          delivered_at: patch.deliveredAt,
          agent: patch.agent,
          routed_by: patch.routedBy,
          routed_to: patch.routedTo ? JSON.stringify(patch.routedTo) : undefined,
        }
        const sets = Object.entries(columns).filter(
          (entry): entry is [string, string | number] => entry[1] !== undefined,
        )
        db.query(
          `UPDATE message SET ${[...sets.map(([column]) => `${column} = ?`), "updated_at = ?"].join(", ")} WHERE id = ?`,
        ).run(...sets.map(([, value]) => value), at, id)
      })
    },
    get(id) {
      flush()
      const row = db.query("SELECT * FROM message WHERE id = ?").get(id) as Row | null
      return row ? messageOf(row) : undefined
    },
    list(filter) {
      flush()
      const where = Object.entries({
        project: filter.project,
        inbox: filter.inbox,
        via: filter.via,
        status: filter.status,
        correlation_id: filter.correlationID,
      })
        .filter((entry): entry is [string, string] => !!entry[1])
        .map(([column, value]) => [`${column} = ?`, value] as const)
      // A sender's kind, or an agent's name.
      const from = filter.from
        ? (["user", "agent", "system", "external"] as const).includes(filter.from as never)
          ? (["json_extract(sender, '$.kind') = ?", filter.from] as const)
          : (["json_extract(sender, '$.agent') = ?", filter.from] as const)
        : undefined
      const conditions = from ? [...where, from] : where
      const sql = [
        "SELECT * FROM message",
        conditions.length ? `WHERE ${conditions.map(([condition]) => condition).join(" AND ")}` : "",
        "ORDER BY created_at DESC, id DESC",
        `LIMIT ${Math.max(1, Math.floor(filter.limit ?? 200))}`,
      ].join(" ")
      return (db.query(sql).all(...conditions.map(([, value]) => value)) as Row[]).map(messageOf)
    },
    counts() {
      flush()
      const rows = db
        .query(
          `SELECT inbox, SUM(status = 'with manager') AS waiting, SUM(status = 'dead letter') AS dead
           FROM message WHERE inbox IS NOT NULL AND status IN ('with manager', 'dead letter') GROUP BY inbox`,
        )
        .all() as Array<{ inbox: string; waiting: number; dead: number }>
      return Object.fromEntries(rows.map((row) => [row.inbox, { waiting: row.waiting, deadLetters: row.dead }]))
    },
    remove(id) {
      flush()
      db.transaction(() => {
        db.query("DELETE FROM message_step WHERE message_id = ?").run(id)
        db.query("DELETE FROM message WHERE id = ?").run(id)
      })()
    },
    flush,
  }
}

// The log the server uses: in the queue's file (tests that give the queue a store of their own get a log there).
const opened = new Map<string, Log>()
export function log(): Log {
  const file = OperatorQueueStore.store().file
  let found = opened.get(file)
  if (!found) opened.set(file, (found = sqlite(file)))
  return found
}

/** Where a message deleted from a Project inbox waits in Trash: one JSON file each (inbox.ts writes them). */
export const trashFolder = () => path.join(Global.Path.data, "operator", "messages-deleted")

/** A message back from Trash (trash.ts, after its file is back): into the log again, as it was. */
export async function restoreFile(file: string) {
  const message = JSON.parse(await fs.readFile(file, "utf8")) as Message
  log().write(message)
  log().flush()
  await fs.rm(file, { force: true })
}
