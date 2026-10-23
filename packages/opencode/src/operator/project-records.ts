export * as OperatorProjectRecords from "./project-records"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { OperatorFileCache } from "./file-cache"
import { OperatorProfileStore } from "./profile-store"
import { OperatorInboxRules } from "./messaging/rules"

// A project's record (project/agent specification §2): its description, status, optional manager
// agent, members (its project-roles: the agents that may participate) and groups of members. Its goal
// is its linked Project Purpose layer (the project settings' `purpose`), so it is not stored here.
// Kept in `<config>/namespaces/project-records.json`, keyed by project, beside the project settings
// (projects.json), which keep only their own fields.

export const Status = Schema.Literals(["draft", "active", "paused", "completed", "archived"]).annotate({
  identifier: "OperatorProjectStatus",
  description: "draft: being set up; active; paused: queued messages wait; completed; archived",
})
export type Status = typeof Status.Type

export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  members: Schema.Array(Schema.String).annotate({ description: "Agent names" }),
}).annotate({ identifier: "OperatorProjectGroup" })
export type Group = typeof Group.Type

export const Record = Schema.Struct({
  key: Schema.String,
  description: Schema.String,
  status: Status,
  manager: Schema.optional(Schema.String).annotate({ description: "The project manager agent (a member)" }),
  members: Schema.Array(Schema.String).annotate({
    description: "The agents that may participate (project-roles); none: every agent may",
  }),
  groups: Schema.Array(Group),
  updatedAt: Schema.optional(Schema.Finite),
}).annotate({ identifier: "OperatorProjectRecord" })
export type Record = typeof Record.Type

export const Patch = Schema.Struct({
  description: Schema.optional(Schema.String),
  status: Schema.optional(Status),
  manager: Schema.optional(Schema.String).annotate({ description: "An empty string: no manager" }),
  members: Schema.optional(Schema.Array(Schema.String)),
  groups: Schema.optional(Schema.Array(Group)),
}).annotate({ identifier: "OperatorProjectRecordPatch" })
export type Patch = typeof Patch.Type

type Stored = Omit<Record, "key"> & { inbox?: OperatorInboxRules.Inbox }
const file = () => path.join(OperatorProfileStore.root(), "project-records.json")

const empty = (key: string): Record => ({ key, description: "", status: "active", members: [], groups: [] })

function clean(key: string, value: unknown): Record {
  const data = (value && typeof value === "object" ? value : {}) as globalThis.Record<string, unknown>
  const strings = (list: unknown) =>
    Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === "string"))] : []
  const statuses: ReadonlyArray<Status> = ["draft", "active", "paused", "completed", "archived"]
  return {
    key,
    description: typeof data.description === "string" ? data.description : "",
    status: statuses.includes(data.status as Status) ? (data.status as Status) : "active",
    ...(typeof data.manager === "string" && data.manager ? { manager: data.manager } : {}),
    members: strings(data.members),
    groups: Array.isArray(data.groups)
      ? data.groups.flatMap((group) =>
          group && typeof group === "object" && typeof (group as Group).id === "string"
            ? [
                {
                  id: (group as Group).id,
                  name: String((group as Group).name ?? (group as Group).id),
                  members: strings((group as Group).members),
                },
              ]
            : [],
        )
      : [],
    ...(typeof data.updatedAt === "number" ? { updatedAt: data.updatedAt } : {}),
  }
}

async function readAll(): Promise<globalThis.Record<string, Stored>> {
  return Bun.file(file())
    .json()
    .catch(() => ({}))
}
// Readers go through the file cache (a record is read for every queued message, ping and model request with ping);
// a write changes the file's stamp, so the next read sees it. Writers read the file themselves.
async function readCached(): Promise<Readonly<globalThis.Record<string, Stored>>> {
  const value = await OperatorFileCache.json(file())
  return value && typeof value === "object" ? (value as globalThis.Record<string, Stored>) : {}
}

let queue: Promise<unknown> = Promise.resolve()
// Writes happen one at a time.
function change<T>(work: (all: globalThis.Record<string, Stored>) => T) {
  const next = queue.then(async () => {
    const all = await readAll()
    const result = work(all)
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await Bun.write(file(), JSON.stringify(all, null, 2) + "\n")
    return result
  })
  queue = next.catch(() => undefined)
  return next
}

export async function list(): Promise<Record[]> {
  return Object.entries(await readCached()).map(([key, value]) => clean(key, value))
}

export async function get(key: string): Promise<Record> {
  const found = (await readCached())[key]
  return found ? clean(key, found) : empty(key)
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorProjectRecordInvalid", {
  message: Schema.String,
}) {}

// Checks a record: the manager and every group member are members (when there are members).
export function check(record: Record): string | undefined {
  if (!record.members.length) return
  const members = new Set(record.members)
  if (record.manager && !members.has(record.manager)) return `The manager ${record.manager} is not a member`
  for (const group of record.groups)
    for (const member of group.members)
      if (!members.has(member)) return `${member} in the group ${group.name} is not a member`
  const ids = record.groups.map((group) => group.id)
  if (new Set(ids).size !== ids.length) return "Two groups have the same id"
}

export async function update(key: string, patch: Patch): Promise<Record | InvalidError> {
  const current = await get(key)
  const next: Record = {
    ...current,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.members !== undefined ? { members: [...new Set(patch.members)] } : {}),
    ...(patch.groups !== undefined
      ? { groups: patch.groups.map((group) => ({ ...group, members: [...group.members] })) }
      : {}),
  }
  if (patch.manager === "") delete (next as { manager?: string }).manager
  else if (patch.manager !== undefined) (next as { manager?: string }).manager = patch.manager
  const problem = check(next)
  if (problem) return new InvalidError({ message: problem })
  const saved = { ...next, updatedAt: Date.now() }
  await change((all) => {
    const { key: _, ...stored } = saved
    // The Project inbox's rules and settings stay (inboxOf).
    const inbox = (all[key] as { inbox?: unknown } | undefined)?.inbox
    all[key] = { ...stored, ...(inbox ? { inbox } : {}) } as Stored
  })
  return saved
}

/**
 * A project's Project inbox: its ordered rules and its unmatched setting (SPEC-0023 §8.2), kept in its record's
 * entry, so they're copied and moved with it. A project that never saved them has a new inbox's.
 */
export async function inboxOf(key: string): Promise<OperatorInboxRules.Inbox> {
  const stored = ((await readCached())[key] as { inbox?: Partial<OperatorInboxRules.Inbox> } | undefined)?.inbox
  const fresh = OperatorInboxRules.fresh()
  if (!stored || typeof stored !== "object") return fresh
  return {
    rules: Array.isArray(stored.rules) ? stored.rules : fresh.rules,
    unmatched: stored.unmatched === "broadcast" ? "broadcast" : "dead-letter",
  }
}

/** Saves a project's inbox (what isn't given stays). */
export async function setInbox(key: string, patch: Partial<OperatorInboxRules.Inbox>) {
  const next = { ...(await inboxOf(key)), ...patch }
  const { key: _, ...base } = empty(key)
  await change((all) => {
    all[key] = { ...(all[key] ?? base), inbox: next }
  })
  return next
}

// A copy of a project gets its record (Copy project); a project moved to Trash keeps it for restore.
export async function copy(from: string, to: string) {
  const found = (await readAll())[from]
  if (!found) return
  await change((all) => {
    all[to] = { ...found, updatedAt: Date.now() }
  })
}

// Whether an agent may participate in the project: every agent when it has no members.
export async function allows(key: string, agent: string) {
  const record = await get(key)
  return !record.members.length || record.members.includes(agent)
}
