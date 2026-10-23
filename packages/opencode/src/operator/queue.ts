export * as OperatorQueue from "./queue"

import { Context, Effect, Layer, Schedule, Schema, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { OperatorMessageLanes } from "./messaging/lanes"
import { OperatorMessageLog } from "./messaging/log"
import { OperatorMessage } from "./messaging/message"
import { OperatorMessagingSeams } from "./messaging/seams"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjectRecords } from "./project-records"
import { OperatorProjects } from "./projects"
import { OperatorQueueStore } from "./queue-store"

// The agents' input queues (project/agent specification §1.6; SPEC-0023 §6), delivered here. A message for a
// session that is running a turn goes in its memory lane (messaging/lanes.ts): a steering one is read at the
// session's next step, the others stay until the turn ends and then move to the session's SQLite lane, in their
// order. A message for a session that isn't running goes in its SQLite lane (queue-store.ts), where it waits until
// the session is idle and then starts its next turn, one message per turn. A message names its session, or goes to
// the agent's main or active session (the agent's default target when it names neither). Messages wait while the
// project is paused, and fail when the agent is not a member. Every message is in the message log
// (messaging/log.ts); at start, one the log shows held in memory goes to its SQLite lane.
//
// Delivery runs after a message is queued, when a session goes idle (after its memory lane moved), and every 30
// seconds (which also picks up what was queued before a restart). One run at a time per agent and project. Every
// tie to OpenCode's sessions is in messaging/seams.ts.

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
  replyTo: Schema.optional(Schema.String).annotate({ description: "The message this one answers" }),
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
  /** This project's messages: held in memory and queued ones in delivery order, the others newest first. */
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<OperatorQueueStore.Item>>
  /** Cancels a queued (or held) message of this project. */
  readonly cancel: (id: string) => Effect.Effect<OperatorQueueStore.Item, NotFoundError | InvalidError>
  /** Delivers what can be delivered now (tests; the service runs it on its own). */
  readonly deliver: () => Effect.Effect<void>
  /** Moves a session's memory lane to its SQLite lane (its turn ended; tests). */
  readonly endTurn: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorQueue") {}

const keyOf = (project: string, agent: string) => `${project}\n${agent}`

/**
 * What the message log shows held in memory, but no lane holds (the server stopped mid-turn), goes to its session's
 * SQLite lane, as it was. Returns how many. Run at start.
 */
export function recover() {
  const store = OperatorQueueStore.store()
  let count = 0
  for (const message of OperatorMessageLog.log().list({ status: "in memory", limit: 100_000 })) {
    if (OperatorMessageLanes.lane().get(message.id) || !message.folder || !message.agent) continue
    if (!store.get(message.id))
      store.enqueue({
        id: message.id,
        project: message.folder,
        agent: message.agent,
        target: message.to.type === "session" ? "session" : "main",
        ...(message.to.type === "session" && message.to.id ? { sessionID: message.to.id } : {}),
        text: message.body.text,
        priority: message.priority,
        steer: message.steer,
        sender: {
          kind: message.from.kind,
          ...(message.from.agent ? { agent: message.from.agent } : {}),
          ...(message.from.session ? { sessionID: message.from.session } : {}),
        },
        correlationID: message.correlationID,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        lane: "sqlite",
        createdAt: message.createdAt,
      })
    OperatorMessageLog.log().step(
      message.id,
      { kind: "recovered", detail: "the server restarted: to the SQLite lane" },
      { status: "queued", lane: "sqlite" },
    )
    count++
  }
  return count
}
// A project's unique id for the message log (its folder until it has one).
const projectIdOf = async (key: string) => (await OperatorProfileStore.readProjects())[key]?.id ?? key

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const instances = yield* InstanceStore.Service
    const seams = yield* OperatorMessagingSeams.Service

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

    // Every change of a message is a step in the log.
    const log = (
      id: string,
      kind: string,
      patch: Parameters<OperatorMessageLog.Log["step"]>[2] = {},
      detail?: string,
    ) => OperatorMessageLog.log().step(id, { kind, ...(detail ? { detail } : {}) }, patch)

    const update = (id: string, patch: Parameters<OperatorQueueStore.Backend["update"]>[1]) => {
      const item = OperatorQueueStore.store().update(id, patch)
      if (item) {
        announce(item)
        if (patch.status)
          log(
            id,
            patch.status,
            {
              status: patch.status,
              ...(patch.deliveredTo ? { sessionID: patch.deliveredTo } : {}),
              ...(patch.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}),
            },
            patch.error,
          )
      }
      return item
    }

    // Sessions a delivery of ours is still running in (its prompt returns when the turn ends).
    const running = new Map<string, object>()
    const busy = (destination: OperatorMessagingSeams.Destination) =>
      running.has(destination.id) ? Effect.succeed(true) : seams.running(destination)

    // Starts the session's turn with the message (in the session's own folder, as the app does). The
    // session counts as running until the turn ends; a steering message into a running turn ends with it.
    const start = (item: OperatorQueueStore.Item, destination: OperatorMessagingSeams.Destination) => {
      const token = {}
      if (!running.has(destination.id)) running.set(destination.id, token)
      return seams.prompt(destination, item.agent, item.text).pipe(
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
            const destination = yield* seams.destination(item, true)
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

    // A turn ended: the session's unread messages in memory go to its SQLite lane, keeping their ids, priorities and
    // times, before the delivery pass that gives it the first.
    const endTurn = (sessionID: string) =>
      Effect.sync(() => {
        for (const held of OperatorMessageLanes.lane().take(sessionID)) {
          const item = OperatorQueueStore.store().enqueue({ ...held.item, status: "queued", lane: "sqlite" })
          log(item.id, "moved", { status: "queued", lane: "sqlite" }, "the turn ended: to the SQLite lane")
          announce(item)
        }
      })

    // A session going idle may let a waiting message in.
    const bridge = yield* EffectBridge.make()
    yield* seams.onIdle((sessionID) => bridge.fork(endTurn(sessionID).pipe(Effect.andThen(kickAll), Effect.ignore)))

    // At start: what the log shows held in memory when the server stopped goes to its SQLite lane.
    yield* Effect.sync(recover).pipe(
      Effect.catchCause((cause) => Effect.logError("operator queue: recovering held messages failed", { cause })),
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
      const defaultTarget = yield* seams
        .defaultTarget(agent)
        .pipe(Effect.mapError((error) => new NotFoundError({ message: error.message })))
      const text = input.text.trim()
      if (!text) return yield* new InvalidError({ message: "The message is empty" })
      const target = input.target ?? (input.sessionID ? "session" : defaultTarget)
      if (target === "session" && !input.sessionID)
        return yield* new InvalidError({ message: "A message for a session names the session" })
      const projectKey = yield* project()
      if (!(yield* Effect.promise(() => OperatorProjectRecords.allows(projectKey, agent))))
        return yield* new InvalidError({ message: `${agent} is not a member of this project` })
      if (target === "session") {
        const found = yield* seams.session(input.sessionID!)
        if (!found) return yield* new NotFoundError({ message: `No session ${input.sessionID}` })
        if (found.directory !== projectKey && !found.directory.startsWith(`${projectKey}/`))
          return yield* new InvalidError({ message: `Session ${input.sessionID} is not in this project` })
      }
      const id = OperatorMessage.newId()
      const createdAt = Date.now()
      const base: OperatorQueueStore.NewItem = {
        id,
        project: projectKey,
        agent,
        target,
        ...(target === "session" ? { sessionID: input.sessionID } : {}),
        text,
        priority: input.priority ?? "normal",
        steer: input.steer ?? false,
        sender,
        correlationID: input.correlationID ?? id,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        createdAt,
      }
      // The lane: memory when its session is running a turn now (read from memory, never the database).
      const destination = yield* seams.destination(
        { agent, target, ...(input.sessionID ? { sessionID: input.sessionID } : {}) },
        false,
      )
      const runningNow = typeof destination !== "string" && (yield* busy(destination))
      const message: OperatorMessage.Message = {
        id,
        project: yield* Effect.promise(() => projectIdOf(projectKey)),
        folder: projectKey,
        from: OperatorMessage.fromSender(sender, yield* Effect.promise(() => projectIdOf(projectKey))),
        to: target === "session" ? { type: "session", id: input.sessionID! } : { type: "agent", id: agent },
        body: { type: "text", text },
        priority: base.priority,
        steer: base.steer,
        correlationID: base.correlationID!,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        hops: 0,
        status: "queued",
        agent,
        createdAt,
        trail: [],
      }
      if (runningNow && typeof destination !== "string") {
        // A steering message is read at the running session's next step.
        if (base.steer) {
          const item = OperatorQueueStore.store().enqueue({
            ...base,
            lane: "memory",
            status: "delivered",
            deliveredAt: Date.now(),
            deliveredTo: destination.id,
          })
          OperatorMessageLog.log().write({
            ...message,
            status: "delivered",
            lane: "memory",
            sessionID: destination.id,
            deliveredAt: item.deliveredAt,
            trail: [{ at: createdAt, kind: "delivered", detail: "steered into the running turn" }],
          })
          announce(item)
          yield* start(item, destination)
          return item
        }
        const held: OperatorQueueStore.Item = { ...base, id, createdAt, status: "in memory", lane: "memory" }
        if (
          OperatorMessageLanes.lane().put({ item: held, sessionID: destination.id, directory: destination.directory })
        ) {
          OperatorMessageLog.log().write({
            ...message,
            status: "in memory",
            lane: "memory",
            sessionID: destination.id,
            trail: [{ at: createdAt, kind: "in memory", detail: "held while the session runs its turn" }],
          })
          announce(held)
          return held
        }
      }
      const full = runningNow && typeof destination !== "string"
      const item = OperatorQueueStore.store().enqueue({ ...base, lane: "sqlite" })
      OperatorMessageLog.log().write({
        ...message,
        lane: "sqlite",
        trail: [
          ...(full
            ? [{ at: createdAt, kind: "memory lane full", detail: `${OperatorMessageLanes.CAP} held already` }]
            : []),
          { at: createdAt, kind: "queued" },
        ],
      })
      announce(item)
      yield* kick(projectKey, agent)
      return item
    })

    const list = Effect.fn("OperatorQueue.list")(function* (input: ListInput) {
      const projectKey = yield* project()
      const held =
        !input.status || input.status === "in memory"
          ? OperatorMessageLanes.lane()
              .list({ project: projectKey, ...(input.agent ? { agent: input.agent } : {}) })
              .map((entry) => entry.item)
          : []
      const stored =
        input.status === "in memory"
          ? []
          : OperatorQueueStore.store().list({
              project: projectKey,
              ...(input.agent ? { agent: input.agent } : {}),
              ...(input.status ? { status: input.status } : {}),
              limit: input.limit ?? 200,
            })
      return [...held, ...stored]
    })

    const cancel = Effect.fn("OperatorQueue.cancel")(function* (id: string) {
      const projectKey = yield* project()
      const held = OperatorMessageLanes.lane().get(id)
      if (held && held.item.project === projectKey) {
        OperatorMessageLanes.lane().remove(id)
        const item = OperatorQueueStore.store().enqueue({ ...held.item, status: "cancelled" })
        log(id, "cancelled", { status: "cancelled" })
        announce(item)
        return item
      }
      const item = OperatorQueueStore.store().get(id)
      if (!item || item.project !== projectKey) return yield* new NotFoundError({ message: `No message ${id}` })
      if (item.status !== "queued") return yield* new InvalidError({ message: `The message is ${item.status}` })
      return update(id, { status: "cancelled" }) ?? item
    })

    return Service.of({ send, list, cancel, deliver: () => kickAll, endTurn })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [InstanceStore.node, OperatorMessagingSeams.node],
})
