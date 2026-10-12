export * as OperatorNotifications from "./notifications"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// Notes helpers post with the `notify` system action (agent_types_spec.md §4.6), shown in the Permission Inbox
// (its overview, or with the project they are about). Kept in <data>/operator/notifications.json, newest first,
// at most LIMIT; dismissing one removes it.

export const LIMIT = 500

export const Note = Schema.Struct({
  id: Schema.String,
  time: Schema.Finite,
  message: Schema.String,
  helper: Schema.String,
  namespace: Schema.String,
  project: Schema.optional(Schema.String).annotate({ description: "The project it is about, if any" }),
  run: Schema.optional(Schema.String).annotate({ description: "The helper run that posted it" }),
}).annotate({ identifier: "OperatorNotification" })
export type Note = typeof Note.Type

const file = () => path.join(Global.Path.data, "operator", "notifications.json")

async function read(): Promise<Note[]> {
  const data = await Bun.file(file())
    .json()
    .catch(() => [])
  return Array.isArray(data) ? (data as Note[]) : []
}

// One write at a time.
let queue: Promise<unknown> = Promise.resolve()
function write<T>(change: (notes: Note[]) => { notes: Note[]; result: T }): Promise<T> {
  const next = queue.then(async () => {
    const { notes, result } = change(await read())
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await Bun.write(file(), JSON.stringify(notes, null, 2))
    return result
  })
  queue = next.catch(() => undefined)
  return next
}

export const list = () => read()

export function add(input: Omit<Note, "id" | "time">) {
  const note: Note = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    ...input,
    message: input.message.slice(0, 2000),
  }
  return write((notes) => ({ notes: [note, ...notes].slice(0, LIMIT), result: note }))
}

export function dismiss(id: string) {
  return write((notes) => ({
    notes: notes.filter((item) => item.id !== id),
    result: notes.some((item) => item.id === id),
  }))
}
