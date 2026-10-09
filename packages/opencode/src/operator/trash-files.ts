export * as OperatorTrashFiles from "./trash-files"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// Trash on disk: every delete in the operator pages moves the item here, where it can be restored or
// deleted permanently. An entry is a folder under the data folder's operator/trash: entry.json, and the
// files and folders it took (a project's whole folder, an agent's file, a layer's file, ...). Kept
// free of service imports: the prompt store, which the session code imports, moves its items here.

export const Kind = Schema.Literals([
  "project",
  "agent",
  "session",
  "type",
  "layer",
  "group",
  "profile",
  "namespace",
  "skill",
  "command",
  "tool",
  "mcp",
  "memory",
  "plugin",
]).annotate({ identifier: "OperatorTrashKind" })
export type Kind = typeof Kind.Type

export const Entry = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  name: Schema.String,
  deletedAt: Schema.Finite,
  project: Schema.optional(Schema.String).annotate({ description: "The project folder it belonged to" }),
  namespace: Schema.optional(Schema.String),
  files: Schema.Array(Schema.Struct({ path: Schema.String, stored: Schema.String })).annotate({
    description: "Files and folders it took, by their original path",
  }),
  config: Schema.optional(
    Schema.Struct({
      scope: Schema.Literals(["global", "namespace", "project"]),
      namespace: Schema.optional(Schema.String).annotate({
        description: "namespace: the namespace whose config it was in",
      }),
      key: Schema.Array(Schema.String),
      value: Schema.Unknown,
    }),
  ).annotate({ description: "A config entry it removed, written back on restore" }),
  settings: Schema.optional(
    Schema.Struct({ project: Schema.optional(Schema.Unknown), agents: Schema.optional(Schema.Unknown) }),
  ).annotate({ description: "A project's prompt settings it removed" }),
  sessions: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Sessions it holds: deleted with the entry",
  }),
  archived: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Sessions it archived: unarchived on restore",
  }),
}).annotate({ identifier: "OperatorTrashEntry" })
export type Entry = typeof Entry.Type

export function root() {
  return path.join(Global.Path.data, "operator", "trash")
}

export const exists = (file: string) =>
  fs
    .lstat(file)
    .then(() => true)
    .catch(() => false)

// A rename, or a copy and delete when the trash is on another disk.
export async function move(from: string, to: string) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error
    await fs.cp(from, to, { recursive: true, preserveTimestamps: true })
    await fs.rm(from, { recursive: true, force: true })
  })
}

/** Moves `paths` into a new entry and records it. A path that does not exist is skipped. */
export async function put(
  input: Omit<Entry, "id" | "deletedAt" | "files"> & { paths?: ReadonlyArray<string> },
): Promise<Entry> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dir = path.join(root(), id)
  const { paths, ...rest } = input
  const files: Array<{ readonly path: string; readonly stored: string }> = []
  for (const [index, file] of (paths ?? []).entries()) {
    if (!(await exists(file))) continue
    const stored = path.join("files", `${index}-${path.basename(file) || "root"}`)
    await move(file, path.join(dir, stored))
    files.push({ path: file, stored })
  }
  const entry: Entry = { ...rest, id, deletedAt: Date.now(), files }
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "entry.json"), JSON.stringify(entry, null, 2))
  return entry
}

export async function list(): Promise<Entry[]> {
  const ids = await fs.readdir(root()).catch(() => [] as string[])
  const entries = await Promise.all(ids.map((id) => get(id)))
  return entries.filter((entry) => entry !== undefined).toSorted((a, b) => b.deletedAt - a.deletedAt)
}

export async function get(id: string): Promise<Entry | undefined> {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined
  return Bun.file(path.join(root(), id, "entry.json"))
    .json()
    .catch(() => undefined)
}

// The projects in Trash, so lists can leave them out.
export async function trashedProjects() {
  return new Set((await list()).filter((entry) => entry.kind === "project").map((entry) => entry.project!))
}
