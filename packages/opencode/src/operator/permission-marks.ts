export * as OperatorPermissionMarks from "./permission-marks"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "./file-cache"

// What a namespace or project level marks on its lines (tool_prompt_from_permission.md §3.2): the
// inherited lines it deletes, and the lines (its own or inherited) it locks ("Can be overridden below:
// no"). The lines themselves are the level's config file's `permission`. Kept by the fork:
//   <config>/namespaces/<namespace>/permissions.json    { deleted, locks }
//   <config>/namespaces/project-permissions.json        { [project]: { deleted, locks } }
// No service imports: permission-live.ts reads them for every decision.

export const Key = Schema.Struct({ permission: Schema.String, pattern: Schema.String }).annotate({
  identifier: "OperatorPermissionKey",
})
export type Key = typeof Key.Type

export const Marks = Schema.Struct({
  deleted: Schema.Array(Key).annotate({ description: "Inherited lines this level deletes" }),
  locks: Schema.Array(Key).annotate({ description: "Lines this level locks: they bind every level below" }),
}).annotate({ identifier: "OperatorPermissionMarks" })
export type Marks = typeof Marks.Type

export const EMPTY: Marks = { deleted: [], locks: [] }

const root = () => path.join(Global.Path.config, "namespaces")
export const namespaceFile = (namespace: string) => path.join(root(), namespace, "permissions.json")
export const projectFile = () => path.join(root(), "project-permissions.json")

const keys = (value: unknown): Key[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        item && typeof item.permission === "string" && typeof item.pattern === "string"
          ? [{ permission: item.permission, pattern: item.pattern }]
          : [],
      )
    : []
const marksOf = (value: unknown): Marks => {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return { deleted: keys(record.deleted), locks: keys(record.locks) }
}
const readJson = (file: string): Promise<unknown> =>
  fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
const empty = (marks: Marks) => !marks.deleted.length && !marks.locks.length
const clean = (marks: Marks): Marks => ({
  deleted: marks.deleted.map(({ permission, pattern }) => ({ permission, pattern })),
  locks: marks.locks.map(({ permission, pattern }) => ({ permission, pattern })),
})

let queue: Promise<unknown> = Promise.resolve()
const serial = <A>(work: () => Promise<A>) => {
  const next = queue.then(work)
  queue = next.catch(() => undefined)
  return next
}
const writeJson = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n")
}

// Read on every permission ask: through the file cache. Writers read the file themselves.
export async function namespaceMarks(namespace: string): Promise<Marks> {
  return marksOf(await OperatorFileCache.json(namespaceFile(namespace)))
}

export function writeNamespace(namespace: string, marks: Marks) {
  return serial(async () => {
    if (empty(marks)) await fs.rm(namespaceFile(namespace), { force: true })
    else await writeJson(namespaceFile(namespace), clean(marks))
  })
}

export async function projectMarks(project: string): Promise<Marks> {
  const store = await OperatorFileCache.json(projectFile())
  return marksOf(store && typeof store === "object" ? (store as Record<string, unknown>)[project] : undefined)
}

export function writeProject(project: string, marks: Marks) {
  return serial(async () => {
    const store = ((await readJson(projectFile())) ?? {}) as Record<string, unknown>
    if (empty(marks)) delete store[project]
    else store[project] = clean(marks)
    await writeJson(projectFile(), store)
  })
}
