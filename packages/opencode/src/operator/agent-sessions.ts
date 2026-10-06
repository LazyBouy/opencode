export * as OperatorAgentSessions from "./agent-sessions"

import fs from "fs/promises"
import path from "path"
import { and, desc, eq, isNull, like, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorAgents } from "./agents"
import { OperatorProjects } from "./projects"

// An agent's sessions in a project (project/agent specification §1): one is its main session (kept
// here, set by you or made on first need) and one is its active session (the most recently used,
// not archived; worked out, not kept). Main sessions are in `<data>/operator/agent-sessions.json`,
// keyed by project and agent; a deleted session stops being main.

const file = () => path.join(Global.Path.data, "operator", "agent-sessions.json")
type Store = Record<string, { main?: string }>
const keyOf = (project: string, agent: string) => `${project}\n${agent}`
const read = (): Promise<Store> =>
  Bun.file(file())
    .json()
    .catch(() => ({}))
let queue: Promise<unknown> = Promise.resolve()
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

export const SessionRef = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  updated: Schema.Finite,
}).annotate({ identifier: "OperatorAgentSessionRef" })
export type SessionRef = typeof SessionRef.Type

export const State = Schema.Struct({
  agent: Schema.String,
  main: Schema.optional(SessionRef).annotate({ description: "The agent's main session in this project" }),
  active: Schema.optional(SessionRef).annotate({
    description: "The agent's most recently used session in this project (not archived, not a subagent's)",
  }),
}).annotate({ identifier: "OperatorAgentSessionState" })
export type State = typeof State.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorAgentSessionsNotFound", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The agent's main and active sessions in this project. */
  readonly state: (agent: string) => Effect.Effect<State, NotFoundError>
  /** Makes a session the agent's main session (none: no main session). */
  readonly setMain: (agent: string, sessionID: string | undefined) => Effect.Effect<State, NotFoundError>
  /** The agent's main session, made (in its home folder) and kept when it has none. */
  readonly ensureMain: (agent: string) => Effect.Effect<{ session: SessionRef; created: boolean }, NotFoundError>
  /** The agent new sessions start with (config `default_agent`, else OpenCode's). */
  readonly defaultAgent: () => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorAgentSessions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const operatorAgents = yield* OperatorAgents.Service
    const instances = yield* InstanceStore.Service

    // A deleted session stops being anyone's main session.
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: { sessionID?: string } } | undefined
      const deleted = payload?.type === "session.deleted" ? payload.properties?.sessionID : undefined
      if (!deleted) return
      void change((store) => {
        for (const [key, value] of Object.entries(store)) if (value.main === deleted) delete store[key]
      }).catch(() => undefined)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    const project = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
    })
    const known = Effect.fnUntraced(function* (name: string) {
      const agent = yield* agents.get(name).pipe(Effect.orElseSucceed(() => undefined))
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      return agent
    })
    const refOf = (row: { id: string; title: string; directory: string; time_updated: number }): SessionRef => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      updated: row.time_updated,
    })
    // A session of the project (its folder or one inside it).
    const inProject = (root: string) =>
      or(eq(SessionTable.directory, root), like(SessionTable.directory, `${root.replace(/[\\%_]/g, "\\$&")}/%`))
    const select = {
      id: SessionTable.id,
      title: SessionTable.title,
      directory: SessionTable.directory,
      time_updated: SessionTable.time_updated,
      time_archived: SessionTable.time_archived,
    }

    const state = Effect.fn("OperatorAgentSessions.state")(function* (name: string) {
      yield* known(name)
      const root = yield* project()
      const kept = (yield* Effect.promise(read))[keyOf(root, name)]?.main
      const main = kept
        ? yield* db
            .select(select)
            .from(SessionTable)
            .where(eq(SessionTable.id, kept as typeof SessionTable.$inferSelect.id))
            .get()
            .pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const active = yield* db
        .select(select)
        .from(SessionTable)
        .where(
          and(
            inProject(root),
            eq(SessionTable.agent, name),
            isNull(SessionTable.parent_id),
            isNull(SessionTable.time_archived),
          ),
        )
        .orderBy(desc(SessionTable.time_updated))
        .limit(1)
        .get()
        .pipe(Effect.orElseSucceed(() => undefined))
      return {
        agent: name,
        ...(main && !main.time_archived ? { main: refOf(main) } : {}),
        ...(active ? { active: refOf(active) } : {}),
      }
    })

    const setMain = Effect.fn("OperatorAgentSessions.setMain")(function* (name: string, sessionID: string | undefined) {
      yield* known(name)
      const root = yield* project()
      if (sessionID) {
        const found = yield* sessions
          .get(SessionID.make(sessionID))
          .pipe(Effect.mapError(() => new NotFoundError({ message: `No session ${sessionID}` })))
        if (found.directory !== root && !found.directory.startsWith(`${root}/`))
          return yield* new NotFoundError({ message: `Session ${sessionID} is not in this project` })
      }
      yield* Effect.promise(() =>
        change((store) => {
          if (sessionID) store[keyOf(root, name)] = { main: sessionID }
          else delete store[keyOf(root, name)]
        }),
      )
      return yield* state(name)
    })

    const ensureMain = Effect.fn("OperatorAgentSessions.ensureMain")(function* (name: string) {
      const current = yield* state(name)
      if (current.main) return { session: current.main, created: false }
      const root = yield* project()
      // In the agent's home folder when it has one, as a session started as the agent is.
      const home = (yield* operatorAgents.list()).find((item) => item.name === name)?.home
      const folder = home ? path.resolve(root, home) : root
      const made = yield* instances.provide(
        { directory: folder },
        sessions.create({ agent: name, title: `${name} · main session` }),
      )
      yield* Effect.promise(() =>
        change((store) => {
          store[keyOf(root, name)] = { main: made.id }
        }),
      )
      return {
        session: { id: made.id, title: made.title, directory: made.directory, updated: made.time.updated },
        created: true,
      }
    })

    return Service.of({ state, setMain, ensureMain, defaultAgent: () => agents.defaultAgent() })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Session.node, Agent.node, OperatorAgents.node, InstanceStore.node],
})
