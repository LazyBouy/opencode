import fs from "fs/promises"
import { expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { OperatorQueueStore } from "@/operator/queue-store"
import { OperatorTelemetry } from "@/operator/telemetry/telemetry"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { testEffect } from "../../lib/effect"
import { configure, replacements, root, send, session } from "../../merge/harness"

// observability_spec.md §5, §21.1: the recorder on a real server, fed by the events a session emits.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorTelemetry.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

// Flushes until `check` holds (the session goes idle after its reply, and the flush that sees it ends the turn).
const until = <A>(check: () => A | undefined) =>
  Effect.gen(function* () {
    const telemetry = yield* OperatorTelemetry.Service
    yield* telemetry.flush()
    const value = check()
    if (value === undefined) return yield* Effect.fail("not yet")
    return value
  }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }), Effect.orDie)

const bytes = (file: string) =>
  Effect.promise(async () =>
    (await Promise.all([file, `${file}-wal`].map((name) => fs.readFile(name, "latin1").catch(() => "")))).join(""),
  )

unix("a session's turn and model call are recorded live, with its totals; its prompt is not", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure()
    yield* llm.text("ok")
    const created = yield* session()
    yield* send(created.id, "hello SECRET-LIVE-5512", "build")
    const store = OperatorTelemetryStore.store()
    const row = yield* until(() => {
      const found = store.session(created.id)
      return found?.status === "idle" ? found : undefined
    })
    expect(row).toMatchObject({ turns: 1, agent: "build", agent_type: "usual", root_id: created.id })
    expect(row.model_calls).toBeGreaterThanOrEqual(1)
    expect(row.project_key).toBeTruthy()
    const spans = store.spansOfSession(created.id)
    const turn = spans.find((span) => span.kind === "turn")!
    expect(turn).toMatchObject({ status: "ok", agent: "build", session_id: created.id, root_session_id: created.id })
    const calls = spans.filter((span) => span.kind === "model_call")
    expect(calls.every((call) => call.turn_id === turn.id)).toBe(true)
    expect(calls.at(-1)!.status).toBe("ok")
    // The title shows when the session has one.
    expect(row.title).toBe(created.title)
    expect(yield* bytes(store.file)).not.toContain("SECRET-LIVE-5512")
  }),
)

unix("a queued message is a span from queued to delivered; the sampler counts the queue", () =>
  Effect.gen(function* () {
    yield* configure()
    const telemetry = yield* OperatorTelemetry.Service
    const queue = OperatorQueueStore.store()
    const item = queue.enqueue({
      project: "/work/queued",
      agent: "build",
      target: "main",
      text: "SECRET-QUEUED-3321",
      priority: "high",
      steer: false,
      sender: { kind: "user" },
    })
    const announce = () =>
      telemetry.ingest.handle({ payload: { type: "operator.queue.updated", properties: { id: item.id } } })
    announce()
    yield* telemetry.sample()
    yield* telemetry.flush()
    const store = OperatorTelemetryStore.store()
    expect(store.span(`queue:${item.id}`)).toMatchObject({
      kind: "queue_item",
      status: "running",
      agent: "build",
      project_key: "/work/queued",
      start_ms: item.createdAt,
    })
    const depth = store.samples("queue_depth").filter((sample) => JSON.parse(sample.dims!).project === "/work/queued")
    expect(depth.at(-1)!.value).toBe(1)
    queue.update(item.id, { status: "delivered", deliveredAt: item.createdAt + 5000, deliveredTo: "ses_target" })
    announce()
    yield* telemetry.flush()
    expect(store.span(`queue:${item.id}`)).toMatchObject({
      status: "ok",
      end_ms: item.createdAt + 5000,
      wait_ms: 5000,
      session_id: "ses_target",
    })
    expect(yield* bytes(store.file)).not.toContain("SECRET-QUEUED-3321")
  }),
)
