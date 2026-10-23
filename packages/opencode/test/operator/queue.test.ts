import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { InstanceState } from "@/effect/instance-state"
import { OperatorProjectRecords } from "@/operator/project-records"
import { OperatorProjects } from "@/operator/projects"
import { OperatorQueue } from "@/operator/queue"
import { OperatorQueueStore } from "@/operator/queue-store"
import { OperatorMessageLanes } from "@/operator/messaging/lanes"
import { OperatorMessageLog } from "@/operator/messaging/log"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorAgentSessions.node, OperatorQueue.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

// Delivery runs in the background: waits until the message has the status.
const settled = (id: string, status: OperatorQueueStore.Status) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt++) {
      const item = OperatorQueueStore.store().get(id)
      if (item?.status === status) return item
      yield* Effect.sleep("20 millis")
    }
    throw new Error(`${id} is ${OperatorQueueStore.store().get(id)?.status}, not ${status}`)
  })

const texts = (
  messages: ReadonlyArray<{ info: { role: string }; parts: ReadonlyArray<{ type: string; text?: string }> }>,
) =>
  messages
    .filter((message) => message.info.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])))

unix("a message waits until its session is idle; a steering message goes in at once", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(directory, ".queue.sqlite")))
    const queue = yield* OperatorQueue.Service
    const sessions = yield* Session.Service

    const release = Promise.withResolvers<void>()
    yield* llm.hold("first reply", release.promise)
    yield* llm.text("steer reply")
    yield* llm.text("second reply")

    // No session named: the agent's main session, made for it.
    const first = yield* queue.send("build", { text: "first" })
    expect(first.target).toBe("main")
    const delivered = yield* settled(first.id, "delivered")
    const main = delivered.deliveredTo!
    expect((yield* sessions.get(main as never)).title).toBe("build · main session")

    // The session is running: the next message is held in its memory lane until the turn ends; a steering one goes
    // in at its next step (SPEC-0023 §6.2).
    const second = yield* queue.send("build", { text: "second" })
    expect(second).toMatchObject({ status: "in memory", lane: "memory" })
    expect(OperatorQueueStore.store().get(second.id)).toBeUndefined()
    expect((yield* queue.list({ agent: "build" })).find((item) => item.id === second.id)?.status).toBe("in memory")
    const steer = yield* queue.send("build", { text: "steer", steer: true })
    expect(steer).toMatchObject({ status: "delivered", lane: "memory", deliveredTo: main })

    // When the turn ends, the held message moves to the SQLite lane and starts the next turn.
    release.resolve()
    expect((yield* settled(second.id, "delivered")).deliveredTo).toBe(main)
    expect(OperatorQueueStore.store().get(second.id)?.lane).toBe("sqlite")
    const logged = OperatorMessageLog.log().get(second.id)!
    expect(logged).toMatchObject({ status: "delivered", from: { kind: "user" }, to: { type: "agent", id: "build" } })
    expect(logged.trail.map((step) => step.kind)).toEqual(["in memory", "moved", "delivered"])
    for (
      let attempt = 0;
      attempt < 250 && texts(yield* sessions.messages({ sessionID: main as never })).length < 3;
      attempt++
    )
      yield* Effect.sleep("20 millis")
    expect(texts(yield* sessions.messages({ sessionID: main as never }))).toEqual(["first", "steer", "second"])
  }),
)

unix("messages wait while the project is paused, go in priority order, and fail for agents that are not members", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(directory, ".queue.sqlite")))
    const queue = yield* OperatorQueue.Service
    const agentSessions = yield* OperatorAgentSessions.Service

    // Checked when queued.
    expect((yield* queue.send("nobody", { text: "hi" }).pipe(Effect.flip))._tag).toBe("OperatorQueueNotFound")
    expect((yield* queue.send("build", { text: "  " }).pipe(Effect.flip))._tag).toBe("OperatorQueueInvalid")
    expect((yield* queue.send("build", { text: "hi", target: "session" }).pipe(Effect.flip))._tag).toBe(
      "OperatorQueueInvalid",
    )
    expect((yield* queue.send("build", { text: "hi", sessionID: "ses_missing" }).pipe(Effect.flip))._tag).toBe(
      "OperatorQueueNotFound",
    )

    const ctx = yield* InstanceState.context
    const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
    yield* Effect.promise(() => OperatorProjectRecords.update(project, { status: "paused" }))

    // The agent's default target.
    yield* agentSessions.setTarget("build", "active")
    const low = yield* queue.send("build", { text: "low", priority: "low" })
    expect(low.target).toBe("active")
    expect(low.project).toBe(project)
    const urgent = yield* queue.send("build", { text: "urgent", priority: "urgent" })
    const normal = yield* queue.send("build", { text: "normal" })
    yield* queue.deliver()
    yield* Effect.sleep("100 millis")
    expect((yield* queue.list({ agent: "build", status: "queued" })).map((item) => item.id)).toEqual([
      urgent.id,
      normal.id,
      low.id,
    ])

    // Cancel: queued messages only.
    expect((yield* queue.cancel(normal.id)).status).toBe("cancelled")
    expect((yield* queue.cancel(normal.id).pipe(Effect.flip))._tag).toBe("OperatorQueueInvalid")
    expect((yield* queue.cancel("qm_missing").pipe(Effect.flip))._tag).toBe("OperatorQueueNotFound")

    // Not a member: refused when queued, and what was queued fails.
    yield* Effect.promise(() => OperatorProjectRecords.update(project, { status: "active", members: ["plan"] }))
    expect((yield* queue.send("build", { text: "hi" }).pipe(Effect.flip)).message).toContain("not a member")
    yield* queue.deliver()
    expect((yield* settled(urgent.id, "failed")).error).toContain("not a member")
    expect((yield* settled(low.id, "failed")).status).toBe("failed")
  }),
)

unix("held messages move to the SQLite lane in their order when the turn ends; past 200 they go there at once", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(directory, ".queue.sqlite")))
    OperatorMessageLanes.use(OperatorMessageLanes.inProcess(3))
    const queue = yield* OperatorQueue.Service

    const release = Promise.withResolvers<void>()
    yield* llm.hold("busy", release.promise)
    const first = yield* queue.send("build", { text: "first" })
    const main = (yield* settled(first.id, "delivered")).deliveredTo!

    // Running: held, in priority order then oldest first; the fourth finds the lane full (a cap of 3 here).
    const low = yield* queue.send("build", { text: "low", priority: "low" })
    const high = yield* queue.send("build", { text: "high", priority: "high" })
    const normal = yield* queue.send("build", { text: "normal" })
    const overflow = yield* queue.send("build", { text: "overflow" })
    expect([low, high, normal].map((item) => item.status)).toEqual(["in memory", "in memory", "in memory"])
    expect(overflow).toMatchObject({ status: "queued", lane: "sqlite" })
    expect(
      OperatorMessageLog.log()
        .get(overflow.id)
        ?.trail.map((step) => step.kind),
    ).toEqual(["memory lane full", "queued"])
    expect((yield* queue.list({ agent: "build", status: "in memory" })).map((item) => item.text)).toEqual([
      "high",
      "normal",
      "low",
    ])

    // The turn ends (the session isn't released, so nothing is delivered yet): the lane is empty, the SQLite lane
    // holds them with their times, and delivery order is unchanged.
    yield* queue.endTurn(main)
    expect(yield* Effect.promise(() => OperatorMessageLanes.lane().list({}))).toEqual([])
    expect((yield* queue.list({ agent: "build", status: "queued" })).map((item) => item.text)).toEqual([
      "high",
      "normal",
      "overflow",
      "low",
    ])
    expect(OperatorQueueStore.store().get(low.id)).toMatchObject({ createdAt: low.createdAt, lane: "sqlite" })
    release.resolve()
    yield* settled(high.id, "delivered")
    OperatorMessageLanes.use(undefined)
  }),
)

unix("after a crash mid-turn, the messages the log shows held in memory are in the SQLite lane at start", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    const file = path.join(directory, ".queue.sqlite")
    OperatorQueueStore.use(OperatorQueueStore.sqlite(file))
    const ctx = yield* InstanceState.context
    const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
    // What a server that stopped mid-turn left: a message in the log, held in memory, and no queue item.
    OperatorMessageLog.log().write({
      id: "msg_crashed1",
      project,
      folder: project,
      from: { kind: "user" },
      to: { type: "agent", id: "build" },
      body: { type: "text", text: "held when it stopped" },
      priority: "high",
      steer: false,
      correlationID: "msg_crashed1",
      hops: 0,
      status: "in memory",
      agent: "build",
      lane: "memory",
      createdAt: Date.now() - 60_000,
      trail: [{ at: Date.now() - 60_000, kind: "in memory" }],
    })
    OperatorMessageLog.log().flush()
    expect(OperatorQueueStore.store().get("msg_crashed1")).toBeUndefined()
    // What the queue service does at start.
    expect(yield* Effect.promise(() => OperatorQueue.recover())).toBe(1)
    expect(yield* Effect.promise(() => OperatorQueue.recover())).toBe(0)
    const recovered = OperatorQueueStore.store().get("msg_crashed1")
    expect(recovered).toMatchObject({ lane: "sqlite", priority: "high", text: "held when it stopped" })
    expect(
      OperatorMessageLog.log()
        .get("msg_crashed1")
        ?.trail.map((step) => step.kind),
    ).toEqual(["in memory", "recovered"])
  }),
)
