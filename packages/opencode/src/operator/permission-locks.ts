export * as OperatorPermissionLocks from "./permission-locks"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorProjects } from "./projects"

// An agent's rules its sessions may not override (fixes_spec.md §4.2). A lock names a rule of the
// agent's full list by its permission and pattern (OpenCode's defaults and config rules too); for every
// request it matches, the agent's last rule with that permission and pattern decides, whatever the
// session's rules say — even a broader session rule (a session `bash *` allow cannot beat a locked
// `bash git push*` ask). Locks are checked last on every ask (permission-live.ts), so no session rule
// list needs rewriting when they change. permission-model.ts says how a lock binds: for an input a locked
// line matches, only the lines of the agent level and above decide.
//
// A subagent (mode subagent or all) checks its own locks, or with `inherit: "parent"` its own and
// those of the agent of the session that started it.
//
// Kept per project and agent in `<data>/operator/agent-permission-locks.json`.

export const Lock = Schema.Struct({ permission: Schema.String, pattern: Schema.String }).annotate({
  identifier: "OperatorPermissionLock",
})
export type Lock = typeof Lock.Type

export const Inherit = Schema.Literals(["own", "parent"]).annotate({
  description: "A subagent's locks: its own (default), or its own and its parent session's agent's",
})
export type Inherit = typeof Inherit.Type

export const Info = Schema.Struct({
  locks: Schema.Array(Lock),
  inherit: Inherit,
  deleted: Schema.optional(Schema.Array(Lock)).annotate({
    description: "Inherited lines (the namespace's, the project's, OpenCode's outside its namespace) the agent deletes",
  }),
}).annotate({ identifier: "OperatorPermissionLocks" })
export type Info = typeof Info.Type

type Rule = PermissionV1.Rule
type Store = Record<string, Record<string, Partial<Info>>>

const file = () => path.join(Global.Path.data, "operator", "agent-permission-locks.json")
const readStore = (): Promise<Store> =>
  Bun.file(file())
    .json()
    .catch(() => ({}))
let queue: Promise<unknown> = Promise.resolve()

export async function read(project: string, agent: string): Promise<Info> {
  const entry = (await readStore())[project]?.[agent]
  return { locks: entry?.locks ?? [], inherit: entry?.inherit ?? "own", deleted: entry?.deleted ?? [] }
}

export function write(project: string, agent: string, info: Info) {
  const next = queue.then(async () => {
    const store = await readStore()
    const agents = store[project] ?? {}
    const deleted = (info.deleted ?? []).map(({ permission, pattern }) => ({ permission, pattern }))
    if (!info.locks.length && info.inherit === "own" && !deleted.length) delete agents[agent]
    else
      agents[agent] = {
        locks: info.locks.map(({ permission, pattern }) => ({ permission, pattern })),
        inherit: info.inherit,
        ...(deleted.length ? { deleted } : {}),
      }
    if (Object.keys(agents).length) store[project] = agents
    else delete store[project]
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await Bun.write(file(), JSON.stringify(store, null, 2) + "\n")
  })
  queue = next.catch(() => undefined)
  return next
}

const projectKeyOf = async (directory: string) => (await OperatorProjects.projectOf(directory))?.key ?? directory
const sameKey = (a: { permission: string; pattern: string }, b: { permission: string; pattern: string }) =>
  a.permission === b.permission && a.pattern === b.pattern

// The locked rules: for each lock, the agent's last rule with that permission and pattern.
export function lockedRules(rows: ReadonlyArray<Rule>, locks: ReadonlyArray<Lock>): Rule[] {
  return locks.flatMap((lock) => {
    const rule = rows.findLast((row) => sameKey(row, lock))
    return rule ? [{ permission: rule.permission, pattern: rule.pattern, action: rule.action }] : []
  })
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorPermissionLocksInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  /** An agent's locks in this project. */
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly save: (agent: string, info: Info) => Effect.Effect<Info>
  /** The locked lines that bind a session: every level's locks, its parent's when its agent inherits them. */
  readonly sessionRules: (sessionID: string) => Effect.Effect<ReadonlyArray<Rule>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionLocks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const live = yield* OperatorPermissionLive.Service

    const project = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
    })

    // What an agent locks in a project: its lock keys (the agent level marks its lines with them), and,
    // when it inherits them, the locked rules of the agent of the session that started it (and so on up).
    const locked = (
      directory: string,
      agent: string,
      depth: number,
      parentID?: string,
    ): Effect.Effect<{ keys: ReadonlyArray<Lock>; deleted: ReadonlyArray<Lock>; inherited: ReadonlyArray<Rule> }> =>
      Effect.gen(function* () {
        const info = yield* Effect.promise(async () => read(await projectKeyOf(directory), agent))
        const own = { keys: info.locks, deleted: info.deleted ?? [] }
        if (info.inherit !== "parent" || !parentID || depth > 3) return { ...own, inherited: [] }
        const parent = yield* sessions.get(SessionID.make(parentID)).pipe(Effect.option)
        if (parent._tag === "None") return { ...own, inherited: [] }
        const parentAgent = parent.value.agent ?? (yield* agents.defaultAgent())
        const above = yield* locked(parent.value.directory, parentAgent, depth + 1, parent.value.parentID)
        // The parent agent's lines in force (its locks resolve against them).
        const rows: ReadonlyArray<Rule> = above.keys.length
          ? yield* live.lines({ agent: parentAgent }).pipe(
              Effect.map((built) => built.lines),
              Effect.catchCause(() => Effect.succeed([])),
            )
          : []
        return { ...own, inherited: [...above.inherited, ...lockedRules(rows, above.keys)] }
      }).pipe(Effect.orElseSucceed(() => ({ keys: [], deleted: [], inherited: [] })))

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorPermissionLive.locks.of = (input) => locked(input.directory, input.agent, 0, input.parentID)
      }),
      () => Effect.sync(() => (OperatorPermissionLive.locks.of = undefined)),
    )

    return Service.of({
      get: (agent) => project().pipe(Effect.flatMap((key) => Effect.promise(() => read(key, agent)))),
      save: (agent, info) =>
        project().pipe(
          Effect.flatMap((key) => Effect.promise(() => write(key, agent, info).then(() => read(key, agent)))),
        ),
      sessionRules: (sessionID) =>
        Effect.gen(function* () {
          const info = yield* sessions.get(SessionID.make(sessionID))
          const agent = info.agent ?? (yield* agents.defaultAgent())
          const built = yield* live.lines({ agent, session: info })
          return built.lines
            .filter((line) => line.lockedAt !== undefined)
            .map(({ permission, pattern, action }) => ({ permission, pattern, action }))
        }).pipe(Effect.orElseSucceed(() => [])),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, OperatorPermissionLive.node],
})
