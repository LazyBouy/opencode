export * as OperatorQueue from "./queue"

import { Context, Effect, Layer, Schedule, Schema, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { OperatorAgentSessions } from "./agent-sessions"
import { OperatorProjectRecords } from "./project-records"
import { OperatorProjects } from "./projects"
import { OperatorQueueStore } from "./queue-store"

// The agents' input queues (project/agent specification §1.6), delivered here. A message waits until
// its session is idle and then starts the session's next turn, one message per turn; a steering
// message goes in at once, and a running session reads it at its next step. A message names its
// session, or goes to the agent's main or active session (the agent's default target when it names
// neither). Messages wait while the project is paused, and fail when the agent is not a member.
//
// Delivery runs after a message is queued, when a session goes idle, and every 30 seconds (which
// also picks up what was queued before a restart). One run at a time per agent and project.

export const SendInput = Schema.Struct({
  text: Schema.String.annotate({ description: "The message" }),
  target: Schema.optional(OperatorQueueStore.Target).annotate({
    description:
      "session: the session it names; main / active: the agent's main or active session. Default: session when a session is named, else the agent's default target",
  }),
  sessionID: Schema.optional(Schema.String),
  priority: Schema.optional(OperatorQueueStore.Priority).annotate({ description: "Default: normal" }),
  steer: Schema.optional(Schema.Boolean).annotate({
    description: "Deliver at once, even into a running session (read at its next step). Default: wait until idle",
  }),
  correlationID: Schema.optional(Schema.String),
})
export type SendInput = typeof SendInput.Type

export const ListInput = Schema.Struct({
  agent: Schema.optional(Schema.String),
  status: Schema.optional(OperatorQueueStore.Status),
  limit: Schema.optional(Schema.Finite),
})
export type ListInput = typeof ListInput.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorQueueNotFound", {
  message: Schema.String,
}) {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorQueueInvalid", {
  message: Schema.String,
}) {}

export const UPDATED = "operator.queue.updated"

export interface Interface {
  /** Queues a message for an agent of this project. */
  readonly send: (
    agent: string,
    input: SendInput,
    sender?: OperatorQueueStore.Sender,
  ) => Effect.Effect<OperatorQueueStore.Item, NotFoundError | InvalidError>
  /** This project's messages: queued ones in delivery order, the others newest first. */
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<OperatorQueueStore.Item>>
  /** Cancels a queued message of this project. */
  readonly cancel: (id: string) => Effect.Effect<OperatorQueueStore.Item, NotFoundError | InvalidError>
  /** Delivers what can be delivered now (tests; the service runs it on its own). */
  readonly deliver: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorQueue") {}

const keyOf = (project: string, agent: string) => `${project}\n${agent}`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const instances = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const prompts = yield* SessionPrompt.Service
    const agentSessions = yield* OperatorAgentSessions.Service

    const project = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
    })

    const announce = (item: OperatorQueueStore.Item) =>
      GlobalBus.emit("event", {
        directory: item.project,
        payload: {
          type: UPDATED,
          properties: { id: item.id, project: item.project, agent: item.agent, status: item.status },
        },
      })

    const update = (id: string, patch: Parameters<OperatorQueueStore.Backend["update"]>[1]) => {
      const item = OperatorQueueStore.store().update(id, patch)
      if (item) announce(item)
      return item
    }

    // Sessions a delivery of ours is still running in (its prompt returns when the turn ends).
    const running = new Map<string, object>()

    type Destination = { id: string; directory: string }
    // Where a message goes, in its project's instance.
    const destinationOf = Effect.fnUntraced(function* (item: OperatorQueueStore.Item) {
      if (item.target === "session") {
        const found = yield* sessions
          .get(SessionID.make(item.sessionID ?? ""))
          .pipe(Effect.orElseSucceed(() => undefined))
        if (!found) return `No session ${item.sessionID}`
        return { id: found.id, directory: found.directory } satisfies Destination
      }
      if (item.target === "active") {
        const state = yield* agentSessions.state(item.agent).pipe(Effect.orElseSucceed(() => undefined))
        if (state?.active) return { id: state.active.id, directory: state.active.directory } satisfies Destination
      }
      return yield* agentSessions.ensureMain(item.agent).pipe(
        Effect.map(({ session }): Destination | string => ({ id: session.id, directory: session.directory })),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
    })

    const busy = Effect.fnUntraced(function* (destination: Destination) {
      if (running.has(destination.id)) return true
      const current = yield* instances.provide(
        { directory: destination.directory },
        status.get(SessionID.make(destination.id)),
      )
      return current.type !== "idle"
    })

    // Starts the session's turn with the message (in the session's own folder, as the app does). The
    // session counts as running until the turn ends; a steering message into a running turn ends with it.
    const start = (item: OperatorQueueStore.Item, destination: Destination) => {
      const token = {}
      if (!running.has(destination.id)) running.set(destination.id, token)
      return instances
        .provide(
          { directory: destination.directory },
          prompts.prompt({
            sessionID: SessionID.make(destination.id),
            agent: item.agent,
            parts: [{ type: "text", text: item.text }],
          }),
        )
        .pipe(
          Effect.catchCause((cause) => Effect.logError("operator queue: the session's turn failed", { cause })),
          Effect.ensuring(
            Effect.suspend(() => {
              if (running.get(destination.id) === token) running.delete(destination.id)
              return kick(item.project, item.agent)
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
    }

    const fail = (item: OperatorQueueStore.Item, error: string) => update(item.id, { status: "failed", error })

    // Delivers an agent's queued messages, in order (priority, then oldest first).
    const run = (projectKey: string, agent: string) =>
      instances.provide(
        { directory: projectKey },
        Effect.gen(function* () {
          const store = OperatorQueueStore.store()
          const items = store.list({ project: projectKey, agent, status: "queued" })
          if (!items.length) return
          const record = yield* Effect.promise(() => OperatorProjectRecords.get(projectKey))
          if (record.status === "paused") return
          if (record.members.length && !record.members.includes(agent)) {
            for (const item of items) fail(item, `${agent} is not a member of this project`)
            return
          }
          // A session that is running, or was just given a message, takes no more until it is idle.
          const waiting = new Set<string>()
          for (const item of items) {
            const destination = yield* destinationOf(item)
            if (typeof destination === "string") {
              fail(item, destination)
              continue
            }
            if (!item.steer && (waiting.has(destination.id) || (yield* busy(destination)))) {
              waiting.add(destination.id)
              continue
            }
            // Marked first, so a restart never delivers it twice.
            update(item.id, { status: "delivered", deliveredAt: Date.now(), deliveredTo: destination.id })
            yield* start(item, destination)
            waiting.add(destination.id)
          }
        }),
      )

    // One run at a time per agent and project; a request during a run makes it run again after.
    const active = new Set<string>()
    const again = new Set<string>()
    const kick = (projectKey: string, agent: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const key = keyOf(projectKey, agent)
        if (active.has(key)) {
          again.add(key)
          return Effect.void
        }
        active.add(key)
        return run(projectKey, agent).pipe(
          Effect.catchCause((cause) => Effect.logError("operator queue: delivery failed", { cause })),
          Effect.ensuring(
            Effect.suspend(() => {
              active.delete(key)
              return again.delete(key) ? kick(projectKey, agent) : Effect.void
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      })

    const kickAll = Effect.suspend(() =>
      Effect.forEach(OperatorQueueStore.store().pending(), (entry) => kick(entry.project, entry.agent), {
        discard: true,
      }),
    )

    // A session going idle may let a waiting message in.
    const bridge = yield* EffectBridge.make()
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: { status?: { type?: string } } } | undefined
      const idle =
        payload?.type === "session.idle" ||
        (payload?.type === "session.status" && payload.properties?.status?.type === "idle")
      if (idle) bridge.fork(kickAll.pipe(Effect.ignore))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )
    yield* kickAll.pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.delay("1 second"),
      Effect.forkIn(scope),
    )

    const send = Effect.fn("OperatorQueue.send")(function* (
      agent: string,
      input: SendInput,
      sender: OperatorQueueStore.Sender = { kind: "user" },
    ) {
      const state = yield* agentSessions
        .state(agent)
        .pipe(Effect.mapError((error) => new NotFoundError({ message: error.message })))
      const text = input.text.trim()
      if (!text) return yield* new InvalidError({ message: "The message is empty" })
      const target = input.target ?? (input.sessionID ? "session" : state.target)
      if (target === "session" && !input.sessionID)
        return yield* new InvalidError({ message: "A message for a session names the session" })
      const projectKey = yield* project()
      if (!(yield* Effect.promise(() => OperatorProjectRecords.allows(projectKey, agent))))
        return yield* new InvalidError({ message: `${agent} is not a member of this project` })
      if (target === "session") {
        const found = yield* sessions
          .get(SessionID.make(input.sessionID!))
          .pipe(Effect.mapError(() => new NotFoundError({ message: `No session ${input.sessionID}` })))
        if (found.directory !== projectKey && !found.directory.startsWith(`${projectKey}/`))
          return yield* new InvalidError({ message: `Session ${input.sessionID} is not in this project` })
      }
      const item = OperatorQueueStore.store().enqueue({
        project: projectKey,
        agent,
        target,
        ...(target === "session" ? { sessionID: input.sessionID } : {}),
        text,
        priority: input.priority ?? "normal",
        steer: input.steer ?? false,
        sender,
        ...(input.correlationID ? { correlationID: input.correlationID } : {}),
      })
      announce(item)
      yield* kick(projectKey, agent)
      return item
    })

    const list = Effect.fn("OperatorQueue.list")(function* (input: ListInput) {
      const projectKey = yield* project()
      return OperatorQueueStore.store().list({
        project: projectKey,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.status ? { status: input.status } : {}),
        limit: input.limit ?? 200,
      })
    })

    const cancel = Effect.fn("OperatorQueue.cancel")(function* (id: string) {
      const projectKey = yield* project()
      const item = OperatorQueueStore.store().get(id)
      if (!item || item.project !== projectKey) return yield* new NotFoundError({ message: `No message ${id}` })
      if (item.status !== "queued") return yield* new InvalidError({ message: `The message is ${item.status}` })
      return update(id, { status: "cancelled" }) ?? item
    })

    return Service.of({ send, list, cancel, deliver: () => kickAll })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [InstanceStore.node, Session.node, SessionStatus.node, SessionPrompt.node, OperatorAgentSessions.node],
})
