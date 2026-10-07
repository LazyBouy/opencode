export * as OperatorSessionPermissions from "./session-permissions"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorAgentPermissions } from "./agent-permissions"
import { OperatorPermissionHook } from "./permission-hook"
import { OperatorPermissionLocks } from "./permission-locks"
import { OperatorPermissionRules } from "./permission-rules"

// A session's own permission rules (session.permission, upstream's field): OpenCode applies them after
// the agent's list, in the tool filter and in every ask. With none, the session is like its agent;
// later edits to the agent still reach it. The fork keeps where each session rule came from (set by
// you, Always allow, Allow for session, added by `task`, a client's tool switch, and when) in
// `<data>/operator/session-permissions.json`, keyed by session, and drops a session's record when the
// session is deleted.

export type Origin = "user" | "always" | "allow" | "task" | "client"
type Rule = PermissionV1.Rule
export type Recorded = Rule & { origin: Origin; time?: number }

const file = () => path.join(Global.Path.data, "operator", "session-permissions.json")
type Store = Record<string, Recorded[]>
const read = (): Promise<Store> =>
  Bun.file(file())
    .json()
    .catch(() => ({}))
let queue: Promise<unknown> = Promise.resolve()
// Changes to the store happen one at a time.
function change(work: (store: Store) => void) {
  const next = queue.then(async () => {
    const store = await read()
    work(store)
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await Bun.write(file(), JSON.stringify(store, null, 2) + "\n")
  })
  queue = next.catch(() => undefined)
  return next
}

const same = (a: Rule, b: Rule) => a.permission === b.permission && a.pattern === b.pattern && a.action === b.action
const sameKey = (a: { permission: string; pattern: string }, b: { permission: string; pattern: string }) =>
  a.permission === b.permission && a.pattern === b.pattern

export async function recorded(sessionID: string): Promise<Recorded[]> {
  return (await read())[sessionID] ?? []
}

// Rules just added to a session by `origin` (Always allow, a client's tool switch, task).
export function record(sessionID: string, rules: ReadonlyArray<Rule>, origin: Origin, time = Date.now()) {
  return change((store) => {
    store[sessionID] = [...(store[sessionID] ?? []), ...rules.map((rule) => ({ ...rule, origin, time }))]
  })
}

// The session's whole list was replaced: rules that were recorded keep their origin; new ones are
// set by `origin`.
export function replace(sessionID: string, rules: ReadonlyArray<Rule>, origin: Origin, time = Date.now()) {
  return change((store) => {
    const pool = [...(store[sessionID] ?? [])]
    const next = rules.map((rule) => {
      const found = pool.findIndex((item) => same(item, rule))
      return found >= 0 ? pool.splice(found, 1)[0]! : { ...rule, origin, time }
    })
    if (next.length) store[sessionID] = next
    else delete store[sessionID]
  })
}

export function forget(sessionID: string) {
  return change((store) => {
    delete store[sessionID]
  })
}

export const Info = Schema.Struct({
  sessionID: Schema.String,
  agent: Schema.String,
  parent: Schema.Boolean.annotate({ description: "A subagent session (started by task)" }),
  rows: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "The agent's full list, then the session's own rules, in evaluation order, with origins",
  }),
  editable: Schema.Struct({ start: Schema.Finite, end: Schema.Finite }).annotate({
    description: "The session's own rules: rows[start] up to (not including) rows[end]",
  }),
  written: Schema.Array(PermissionV1.Rule).annotate({ description: "The session's own rules" }),
  forms: Schema.Record(Schema.String, OperatorPermissionRules.PatternForm),
  known: Schema.Array(Schema.String),
  locked: Schema.Array(PermissionV1.Rule).annotate({
    description:
      "The agent's rules the session may not override (with its parent's, for a subagent that inherits them)",
  }),
  allLocked: Schema.Boolean.annotate({ description: "Every rule of the agent's list is locked: nothing to change" }),
}).annotate({ identifier: "OperatorSessionPermissions" })
export type Info = typeof Info.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorSessionPermissionsNotFound", {
  message: Schema.String,
}) {}
export class LockedError extends Schema.TaggedErrorClass<LockedError>()("OperatorSessionPermissionsLocked", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<Info, NotFoundError>
  /** Replaces the session's own rules (Reset to agent: none). */
  readonly save: (sessionID: string, rules: ReadonlyArray<Rule>) => Effect.Effect<Info, NotFoundError | LockedError>
  /** Adds rules after the session's own (Allow for session), with where they came from. */
  readonly add: (sessionID: string, rules: ReadonlyArray<Rule>, origin: Origin) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorSessionPermissions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const rules = yield* OperatorPermissionRules.Service
    const agentPermissions = yield* OperatorAgentPermissions.Service
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const locks = yield* OperatorPermissionLocks.Service

    // A session deleted for good takes its record with it.
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: { sessionID?: string } } | undefined
      if (payload?.type !== "session.deleted" || !payload.properties?.sessionID) return
      void forget(payload.properties.sessionID).catch(() => undefined)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    // "Always" answers are kept with the session (appended to its rules) and a client's tool switches
    // are recorded, each with where it came from (permission/index.ts and session/prompt.ts call these).
    const always = (input: { sessionID: string; rules: ReadonlyArray<Rule> }) =>
      Effect.gen(function* () {
        // A rule the agent locks is not kept: the lock decides anyway.
        const locked = yield* locks.sessionRules(input.sessionID)
        const kept = input.rules.filter((rule) => !locked.some((lock) => sameKey(lock, rule)))
        if (!kept.length) return
        const id = SessionID.make(input.sessionID)
        const current = yield* sessions.get(id)
        yield* sessions.setPermission({ sessionID: id, permission: [...(current.permission ?? []), ...kept] })
        yield* Effect.promise(() => record(input.sessionID, kept, "always"))
      }).pipe(Effect.catchCause(() => Effect.void))
    const switched = (input: { sessionID: string; rules: ReadonlyArray<Rule> }) =>
      Effect.promise(() => record(input.sessionID, input.rules, "client")).pipe(Effect.catchCause(() => Effect.void))
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorPermissionHook.handlers.always = always
        OperatorPermissionHook.handlers.switched = switched
      }),
      () =>
        Effect.sync(() => {
          if (OperatorPermissionHook.handlers.always === always) OperatorPermissionHook.handlers.always = undefined
          if (OperatorPermissionHook.handlers.switched === switched)
            OperatorPermissionHook.handlers.switched = undefined
        }),
    )

    const session = (sessionID: string) =>
      sessions
        .get(SessionID.make(sessionID))
        .pipe(Effect.mapError(() => new NotFoundError({ message: `No session ${sessionID}` })))

    const get = Effect.fn("OperatorSessionPermissions.get")(function* (sessionID: string) {
      const info = yield* session(sessionID)
      // A session's agent, else the agent new sessions start with.
      const agent = info.agent ?? (yield* agents.defaultAgent())
      const labelled = yield* rules.agent(agent)
      const editor = yield* agentPermissions
        .get(agent)
        .pipe(Effect.mapError(() => new NotFoundError({ message: `No agent named "${agent}"` })))
      const cfg = yield* config.get()
      const own = [...(info.permission ?? [])]
      const sessionRows = OperatorPermissionRules.sessionRows({
        rules: own,
        start: labelled.rows.length,
        parent: !!info.parentID,
        primaryTools: cfg.experimental?.primary_tools ?? [],
        recorded: yield* Effect.promise(() => recorded(sessionID)),
      })
      const locked = yield* locks.sessionRules(sessionID)
      const keys = (yield* locks.get(agent)).locks
      return {
        sessionID,
        agent,
        parent: !!info.parentID,
        rows: [...labelled.rows, ...sessionRows],
        editable: { start: labelled.rows.length, end: labelled.rows.length + sessionRows.length },
        written: own,
        forms: editor.forms,
        known: editor.known,
        locked,
        allLocked: labelled.rows.length > 0 && labelled.rows.every((row) => keys.some((lock) => sameKey(lock, row))),
      }
    })

    const save = Effect.fn("OperatorSessionPermissions.save")(function* (sessionID: string, next: ReadonlyArray<Rule>) {
      yield* session(sessionID)
      const list = next.map((rule) => ({
        permission: rule.permission.trim(),
        pattern: rule.pattern.trim() || "*",
        action: rule.action,
      }))
      // A session rule may not change a rule the agent locks.
      const locked = yield* locks.sessionRules(sessionID)
      const clash = list.find((rule) => locked.some((lock) => sameKey(lock, rule) && lock.action !== rule.action))
      if (clash)
        return yield* new LockedError({
          message: `The agent locks ${clash.permission} ${clash.pattern}: sessions may not override it.`,
        })
      yield* Effect.promise(() => replace(sessionID, list, "user"))
      // Approvals kept in memory for the session stop applying: its rules are what you saved.
      OperatorPermissionHook.reset(sessionID)
      // Saved with the session; OpenCode publishes the session's update, and applies the rules from the
      // session's next step.
      yield* sessions.setPermission({ sessionID: SessionID.make(sessionID), permission: list })
      return yield* get(sessionID)
    })

    const add = Effect.fn("OperatorSessionPermissions.add")(function* (
      sessionID: string,
      next: ReadonlyArray<Rule>,
      origin: Origin,
    ) {
      const info = yield* session(sessionID)
      yield* sessions.setPermission({
        sessionID: SessionID.make(sessionID),
        permission: [...(info.permission ?? []), ...next],
      })
      yield* Effect.promise(() => record(sessionID, next, origin))
    })

    return Service.of({ get, save, add })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    OperatorPermissionRules.node,
    OperatorAgentPermissions.node,
    Config.node,
    Agent.node,
    OperatorPermissionLocks.node,
  ],
})
