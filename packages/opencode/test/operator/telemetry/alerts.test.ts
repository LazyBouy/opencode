import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { OperatorTelemetryAlertRules } from "@/operator/telemetry/alert-rules"
import { OperatorTelemetryAlerting } from "@/operator/telemetry/alerting"
import { OperatorTelemetryAlerts as A } from "@/operator/telemetry/alerts"
import { OperatorTelemetry } from "@/operator/telemetry/telemetry"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import type { OperatorTelemetryQuery } from "@/operator/telemetry/query"
import { tmpdir } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { replacements, root } from "../../merge/harness"
import { harness, T0 } from "./harness"

// observability_spec.md §14, §21.1: each metric over its window and scope; a rule's states (For, resolving after two
// clear evaluations, not enough data, muted, couldn't evaluate, off); the built-in rules; and the service: an alert
// event per firing period, mirrored as an `alert` span, acknowledged with who and when, muted, a user rule deleted to
// Trash and restored, built-ins reset but never deleted.

const MIN = 60_000
const NOW = T0 + 60 * MIN

const context = (activeFolders: string[] = []): A.Context => ({
  now: NOW,
  known: ["/work/a", "/work/b"],
  stuckMinutes: 10,
  projectsOf: (ns): ReturnType<OperatorTelemetryQuery.Context["projectsOf"]> => ({
    keys: ns === "acme" ? ["/work/b"] : ["/work/a"],
    rest: false,
  }),
  activeFolders: new Set(activeFolders),
})

function seeded(dir: string) {
  const h = harness(dir)
  const span = (id: string, fields: Partial<OperatorTelemetryStore.SpanWrite>) =>
    h
      .batch()
      .span({ id, kind: "model_call", name: id, status: "ok", start_ms: NOW - 5 * MIN, source: "part", ...fields })
  // Ten model calls in the last 15 minutes, three failed; two on /work/b, one of them failed with a 429.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8])
    span(`call:${n}`, {
      project_key: "/work/a",
      model: "gpt-5",
      end_ms: NOW - 4 * MIN,
      ...(n <= 2 ? { status: "error" } : {}),
    })
  span("call:9", { project_key: "/work/b", model: "claude", end_ms: NOW - 4 * MIN })
  span("call:10", { project_key: "/work/b", model: "claude", end_ms: NOW - 4 * MIN, status: "error", http_status: 429 })
  // An old failure, outside the window.
  span("call:old", {
    project_key: "/work/a",
    model: "gpt-5",
    start_ms: NOW - 50 * MIN,
    end_ms: NOW - 49 * MIN,
    status: "error",
  })
  span("cost:1", { kind: "helper_run", project_key: "/work/a", cost: 1.5, end_ms: NOW - 4 * MIN })
  // A wait open for 12 minutes, and a turn of 30 s.
  span("perm:1", { kind: "permission_wait", project_key: "/work/a", status: "running", start_ms: NOW - 12 * MIN })
  span("turn:1", {
    kind: "turn",
    turn_id: "turn:1",
    project_key: "/work/a",
    start_ms: NOW - 10 * MIN,
    end_ms: NOW - 10 * MIN + 30_000,
  })
  // An MCP server failing for 8 minutes in a folder in use, another in a folder not in use.
  h.batch().mcpStatus({
    time_ms: NOW - 20 * MIN,
    directory: "/work/a",
    server: "github",
    status: "connected",
    error: null,
  })
  h.batch().mcpStatus({ time_ms: NOW - 8 * MIN, directory: "/work/a", server: "github", status: "failed", error: "x" })
  h.batch().mcpStatus({ time_ms: NOW - 30 * MIN, directory: "/idle", server: "jira", status: "failed", error: "x" })
  h.batch().sample({
    time_ms: NOW - MIN,
    name: "queue_oldest_ms",
    dims: JSON.stringify({ project: "/work/b" }),
    value: 7 * MIN,
  })
  h.flush()
  return h
}

const rule = (input: Partial<A.Rule> = {}): A.Rule => ({
  id: "rule-1",
  name: "Test",
  metric: "call_error_rate",
  op: ">",
  threshold: 20,
  window: "15",
  consecutive: 1,
  scope: {},
  severity: "warning",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...input,
})

describe("alert metrics", () => {
  test("each metric over its window and scope", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    const measure = (input: Partial<A.Rule>, active: string[] = []) => A.measure(h.store, rule(input), context(active))
    // 3 of 10 calls in the window failed; the old failure is outside it.
    expect(measure({})).toEqual({ value: 30, count: 10 })
    expect(measure({ scope: { model: "claude" } })).toEqual({ value: 50, count: 2 })
    expect(measure({ scope: { ns: "acme" } })).toEqual({ value: 50, count: 2 })
    expect(measure({ window: "60" }).count).toBe(11)
    expect(measure({ metric: "rate_limits" }).value).toBe(1)
    expect(measure({ metric: "cost" }).value).toBeCloseTo(1.5)
    expect(measure({ metric: "oldest_approval" }).value).toBeCloseTo(12)
    expect(measure({ metric: "oldest_approval", scope: { dir: "/work/b" } }).value).toBe(0)
    expect(measure({ metric: "turn_active_p95" })).toEqual({ value: 30, count: 1 })
    expect(measure({ metric: "oldest_queued" }).value).toBeCloseTo(7)
    expect(measure({ metric: "oldest_queued", scope: { dir: "/work/a" } }).value).toBe(0)
    // Only folders in use count: /idle's server is unknown now.
    expect(measure({ metric: "mcp_down" }, ["/work/a"]).value).toBeCloseTo(8)
    expect(measure({ metric: "mcp_down" }, []).value).toBe(0)
  })

  test("View events opens the metric's matching filter with the rule's scope", () => {
    expect(A.linkOf({ metric: "call_error_rate", scope: { model: "gpt-5", dir: "" } })).toEqual({
      kind: "model_call",
      status: "error",
      model: "gpt-5",
    })
  })
})

describe("alert states", () => {
  const step = (state: A.State, input: Partial<A.Rule>, value: number | null, count: number | null = null, now = NOW) =>
    A.advance(state, rule(input), { value, count }, now)

  test("fires after For evaluations in a row, resolves after two clear ones, and keeps the worst value", () => {
    let state = A.INITIAL
    let next = step(state, { consecutive: 2 }, 30)
    expect(next.open).toBeUndefined()
    state = next.next
    next = step(state, { consecutive: 2 }, 35)
    expect(next.open).toBe(35)
    state = { ...next.next, event_id: "e1" }
    expect(state.state).toBe("firing")
    next = step(state, { consecutive: 2 }, 50)
    expect(next.worst).toBe(50)
    state = next.next
    // One clear evaluation: still firing (no flapping).
    next = step(state, { consecutive: 2 }, 10)
    expect(next.close).toBeUndefined()
    expect(next.next.state).toBe("firing")
    next = step(next.next, { consecutive: 2 }, 10)
    expect(next.close).toBe(true)
    expect(next.next).toMatchObject({ state: "ok", event_id: null })
    expect(A.worse(">", 50, 40)).toBe(50)
    expect(A.worse("<", 50, 40)).toBe(40)
  })

  test("not enough data, muted, couldn't evaluate and off never open an alert", () => {
    const few = step(A.INITIAL, { minCount: 10 }, 90, 3)
    expect(few.open).toBeUndefined()
    expect(few.next.state).toBe("insufficient")
    const muted = step(A.INITIAL, { mute: { until: NOW + MIN } }, 90)
    expect(muted.open).toBeUndefined()
    expect(muted.next.state).toBe("muted")
    // A mute that has run out no longer holds.
    expect(step(A.INITIAL, { mute: { until: NOW - 1 } }, 90).open).toBe(90)
    const broken = A.advance(A.INITIAL, rule(), { error: "no such table" }, NOW)
    expect(broken.open).toBeUndefined()
    expect(broken.next).toMatchObject({ state: "error", error: "no such table" })
    const off = A.advance(
      { ...A.INITIAL, event_id: "e1", state: "firing" },
      rule({ enabled: false }),
      { value: 90, count: 1 },
      NOW,
    )
    expect(off.close).toBe(true)
    expect(off.next.state).toBe("disabled")
  })

  test("the built-in rules; Daily cost stays off until there is a budget", () => {
    const keys = A.builtins(undefined).map((item) => item.builtin)
    expect(keys).toEqual([
      "approval_waiting",
      "calls_failing",
      "rate_limited",
      "retries_exhausted",
      "mcp_down",
      "possible_loop",
      "tools_failing",
      "daily_cost",
    ])
    expect(A.builtins(undefined).find((item) => item.builtin === "daily_cost")).toMatchObject({ enabled: false })
    expect(A.builtins(25).find((item) => item.builtin === "daily_cost")).toMatchObject({ enabled: true, threshold: 25 })
    expect(A.builtins(undefined).find((item) => item.builtin === "calls_failing")).toMatchObject({
      metric: "call_error_rate",
      op: ">",
      threshold: 20,
      window: "15",
      minCount: 10,
    })
  })
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorTelemetry.node, OperatorTelemetryAlerting.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

it.live("the service: an alert per firing period, acknowledged, muted, deleted to Trash and restored", () =>
  Effect.gen(function* () {
    const alerting = yield* OperatorTelemetryAlerting.Service
    const telemetry = yield* OperatorTelemetry.Service
    const store = OperatorTelemetryStore.store()
    const now = Date.now()
    for (const n of [1, 2, 3, 4])
      store.upsertSpan({
        id: `svc-call:${n}`,
        kind: "model_call",
        name: "chat x",
        status: n <= 2 ? "error" : "ok",
        start_ms: now - 3 * MIN,
        end_ms: now - 2 * MIN,
        model: "svc-model",
        source: "part",
      })
    const created = yield* alerting.create({
      name: "  Svc calls failing ",
      metric: "call_error_rate",
      op: ">",
      threshold: 40,
      window: "15",
      minCount: 2,
      consecutive: 1,
      scope: { model: "svc-model", agent: " " },
      severity: "critical",
      enabled: true,
    })
    expect(created.rule).toMatchObject({ name: "Svc calls failing", scope: { model: "svc-model" } })
    const id = created.rule.id
    yield* alerting.evaluate(now)
    const firing = yield* alerting.events({ firing: true })
    const event = firing.find((item) => item.rule_id === id)!
    expect(event).toMatchObject({ value: 50, threshold: 40, end_ms: null, ack_by: null, muted: false })
    expect(event.link).toEqual({ kind: "model_call", status: "error", model: "svc-model" })
    expect((yield* alerting.rules()).find((item) => item.rule.id === id)!.state.state).toBe("firing")
    // The event is a span of kind alert, written with the next flush.
    yield* telemetry.flush()
    expect(store.span(`alert:${event.id}`)).toMatchObject({ kind: "alert", status: "running", error_type: "critical" })
    // Acknowledged: who and when; still firing.
    const acked = yield* alerting.acknowledge(event.id)
    expect(acked.ack_by).toBeTruthy()
    expect(acked.ack_ms).toBeGreaterThan(0)
    // Muted: its alerts say so.
    yield* alerting.mute(id, "1h")
    expect((yield* alerting.events({ firing: true })).find((item) => item.id === event.id)!.muted).toBe(true)
    yield* alerting.mute(id, "off")
    // Two clear evaluations resolve it.
    store.upsertSpan({ id: "svc-call:1", kind: "model_call", status: "ok" })
    store.upsertSpan({ id: "svc-call:2", kind: "model_call", status: "ok" })
    yield* alerting.evaluate(now + MIN)
    yield* alerting.evaluate(now + 2 * MIN)
    const resolved = (yield* alerting.events({ from: 0, to: now + 10 * MIN })).find((item) => item.id === event.id)!
    expect(resolved.end_ms).toBe(now + 2 * MIN)
    yield* telemetry.flush()
    expect(store.span(`alert:${event.id}`)).toMatchObject({ status: "ok", end_ms: now + 2 * MIN })
    // Deleted: its file goes to Trash; restored: it is back.
    yield* alerting.remove(id)
    expect((yield* alerting.rules()).some((item) => item.rule.id === id)).toBe(false)
    const entry = (yield* Effect.promise(() => OperatorTrashFiles.list())).find((item) => item.kind === "alert-rule")!
    expect(entry.name).toBe("Svc calls failing")
    const file = entry.files[0]!
    yield* Effect.promise(() =>
      fs.rename(
        path.join(OperatorTrashFiles.root(), entry.id, file.stored),
        path.join(OperatorTelemetryAlertRules.dir(), `${id}.json`),
      ),
    )
    expect((yield* alerting.rules()).some((item) => item.rule.id === id)).toBe(true)
  }),
)

it.live("built-in rules are edited and reset, never deleted", () =>
  Effect.gen(function* () {
    const alerting = yield* OperatorTelemetryAlerting.Service
    const builtin = (yield* alerting.rules()).find((item) => item.rule.builtin === "rate_limited")!
    expect(builtin.rule).toMatchObject({ id: "builtin-rate_limited", threshold: 5, enabled: true })
    const { id, builtin: _builtin, mute: _mute, createdAt: _created, updatedAt: _updated, ...input } = builtin.rule
    const edited = yield* alerting.update(id, { ...input, threshold: 9 })
    expect(edited.rule).toMatchObject({ id, builtin: "rate_limited", threshold: 9 })
    const refused = yield* alerting.remove(id).pipe(Effect.flip)
    expect(refused.message).toContain("can't be deleted")
    const reset = yield* alerting.reset(id)
    expect(reset.rule.threshold).toBe(5)
    const missing = yield* alerting.update("rule-none", input).pipe(Effect.flip)
    expect(missing.missing).toBe(true)
    const invalid = yield* alerting.create({ ...input, name: "x", consecutive: 11 }).pipe(Effect.flip)
    expect(invalid.message).toContain("1 to 10")
  }),
)
