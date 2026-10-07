export * as OperatorPermissionLocks from "./permission-locks"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorAgentPermissions } from "./agent-permissions"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorProjects } from "./projects"

// An agent's rules its sessions may not override (fixes_spec.md §4.2). A lock names a rule of the
// agent's full list by its permission and pattern (OpenCode's defaults and config rules too); for every
// request it matches, the agent's last rule with that permission and pattern decides, whatever the
// session's rules say — even a broader session rule (a session `bash *` allow cannot beat a locked
// `bash git push*` ask). Locks are checked last on every ask (permission-live.ts), so no session rule
// list needs rewriting when they change.
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
  return { locks: entry?.locks ?? [], inherit: entry?.inherit ?? "own" }
}

export function write(project: string, agent: string, info: Info) {
  const next = queue.then(async () => {
    const store = await readStore()
    const agents = store[project] ?? {}
    if (!info.locks.length && info.inherit === "own") delete agents[agent]
    else
      agents[agent] = {
        locks: info.locks.map(({ permission, pattern }) => ({ permission, pattern })),
        inherit: info.inherit,
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

// The locked rule that decides a request's pattern, if one does.
export function deciding(locked: ReadonlyArray<Rule>, permission: string, pattern: string) {
  return locked.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorPermissionLocksInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  /** An agent's locks in this project. */
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly save: (agent: string, info: Info) => Effect.Effect<Info>
  /** The locked rules a session checks last: its agent's, and its parent's when the agent inherits them. */
  readonly sessionRules: (sessionID: string) => Effect.Effect<ReadonlyArray<Rule>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionLocks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentPermissions = yield* OperatorAgentPermissions.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    const project = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
    })

    // The rules an agent locks, in a project (read in that project's instance).
    const locked = (directory: string, agent: string, depth: number, parentID?: string): Effect.Effect<Rule[]> =>
      Effect.gen(function* () {
        const info = yield* Effect.promise(async () => read(await projectKeyOf(directory), agent))
        const rows = info.locks.length
          ? yield* agentPermissions.get(agent).pipe(
              Effect.map((editor) => editor.rows),
              Effect.orElseSucceed(() => []),
            )
          : []
        const own = lockedRules(rows, info.locks)
        if (info.inherit !== "parent" || !parentID || depth > 3) return own
        const parent = yield* sessions.get(SessionID.make(parentID)).pipe(Effect.option)
        if (parent._tag === "None") return own
        const parentAgent = parent.value.agent ?? (yield* agents.defaultAgent())
        const inherited: Rule[] = yield* locked(parent.value.directory, parentAgent, depth + 1, parent.value.parentID)
        // The parent's come first: the subagent's own locks decide where both lock the same rule.
        return [...inherited, ...own]
      }).pipe(Effect.orElseSucceed(() => []))

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorPermissionLive.locks.of = (input) =>
          locked(input.directory, input.agent, 0, input.parentID).pipe(Effect.orElseSucceed(() => []))
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
          return yield* locked(info.directory, agent, 0, info.parentID)
        }).pipe(Effect.orElseSucceed(() => [])),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorAgentPermissions.node, Session.node, Agent.node, OperatorPermissionLive.node],
})
