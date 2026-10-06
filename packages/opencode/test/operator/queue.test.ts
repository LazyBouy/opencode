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

    // The session is running: the next message waits; a steering one goes in.
    const second = yield* queue.send("build", { text: "second" })
    const steer = yield* queue.send("build", { text: "steer", steer: true })
    expect((yield* settled(steer.id, "delivered")).deliveredTo).toBe(main)
    expect(OperatorQueueStore.store().get(second.id)?.status).toBe("queued")

    // When the turn ends, the waiting message starts the next one.
    release.resolve()
    expect((yield* settled(second.id, "delivered")).deliveredTo).toBe(main)
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
