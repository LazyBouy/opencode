import { describe, expect, test } from "bun:test"
import { OperatorTelemetryDashboard as D } from "@/operator/telemetry/dashboard"
import { OperatorTelemetryMetrics as M } from "@/operator/telemetry/metrics"
import type { OperatorTelemetryQuery } from "@/operator/telemetry/query"
import type { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorTelemetryWriter } from "@/operator/telemetry/writer"
import { tmpdir } from "../../fixture/fixture"
import { harness } from "./harness"

// dashboard_spec.md §5, §6, §8, §13.1: each attention item appears when its condition holds (and not otherwise), in
// scope, with its worst case; an alert covering an item shows once; all clear; tiles agree with Observability's
// metrics, use active time of successful turns, leave denials out of errors; comparisons; cost counted when each call
// happened; breakdowns with an Other row and helpers; totals past the detailed window; telemetry off.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Math.floor(Date.now() / HOUR) * HOUR + 30 * MIN

const context = (now = NOW): OperatorTelemetryQuery.Context => ({
  now,
  known: ["/work/a", "/work/b"],
  stuckMinutes: 10,
  projectsOf: (ns) => ({ keys: ns === "acme" ? ["/work/b"] : ["/work/a"], rest: false }),
})

type Write = Partial<OperatorTelemetryStore.SpanWrite>
function setup(dir: string) {
  const h = harness(dir)
  // The writer works out running sessions' last activity at the harness's time.
  h.at(NOW)
  const span = (id: string, fields: Write) =>
    h.batch().span({ id, kind: "tool_call", name: id, status: "ok", start_ms: NOW - HOUR, source: "part", ...fields })
  const turn = (session: string, n: number, fields: Write = {}) =>
    span(`turn:${session}:${n}`, {
      kind: "turn",
      turn_id: `turn:${session}:${n}`,
      session_id: session,
      project_key: "/work/a",
      agent: "build",
      end_ms: (fields.start_ms ?? NOW - HOUR) + 10_000,
      ...fields,
    })
  return { h, span, turn, flush: () => (h.flush(), OperatorTelemetryWriter.totals(h.store)) }
}

const base = {
  scope: {},
  context: context(),
  enabled: true,
  stuckMinutes: 10,
  queueMinutes: 10,
  dailyBudget: undefined,
  dropped: 0,
  alerts: [],
  activeFolders: new Set<string>(),
}

describe("needs attention", () => {
  test("all clear: no items, with the running count", async () => {
    await using tmp = await tmpdir()
    const { turn, flush, h } = setup(tmp.path)
    turn("ses_run", 0, { status: "running", end_ms: null, start_ms: NOW - MIN })
    flush()
    expect(D.attention(h.store, base)).toMatchObject({
      items: [],
      running: 1,
      telemetry: { enabled: true, dropped: 0 },
    })
  })

  test("running now: running or waiting sessions in scope, the longest-running turn first; none when off", async () => {
    await using tmp = await tmpdir()
    const { turn, flush, h } = setup(tmp.path)
    turn("ses_new", 0, { status: "running", end_ms: null, start_ms: NOW - MIN })
    turn("ses_old", 0, { status: "running", end_ms: null, start_ms: NOW - 20 * MIN })
    turn("ses_b", 0, { status: "running", end_ms: null, start_ms: NOW - 5 * MIN, project_key: "/work/b" })
    turn("ses_done", 0, { start_ms: NOW - 2 * MIN })
    flush()
    const ids = (found: ReturnType<typeof D.attention>) => found.runningNow.rows.map((row) => row.id)
    const all = D.attention(h.store, base)
    expect(all.runningNow.total).toBe(3)
    expect(ids(all)).toEqual(["ses_old", "ses_b", "ses_new"])
    const one = D.attention(h.store, { ...base, scope: { dir: "/work/a" } })
    expect([one.runningNow.total, ids(one)]).toEqual([2, ["ses_old", "ses_new"]])
    expect(D.attention(h.store, { ...base, enabled: false }).runningNow).toEqual({ rows: [], total: 0 })
  })

  test("each item when its condition holds, in scope, with its worst case and link", async () => {
    await using tmp = await tmpdir()
    const { span, turn, flush, h } = setup(tmp.path)
    // Two approvals waiting on /work/a, the oldest 35 min (critical); one on /work/b.
    span("perm:1", {
      kind: "permission_wait",
      session_id: "ses_a",
      project_key: "/work/a",
      status: "running",
      start_ms: NOW - 35 * MIN,
      request_id: "per_1",
    })
    span("perm:2", {
      kind: "permission_wait",
      session_id: "ses_a",
      project_key: "/work/a",
      status: "running",
      start_ms: NOW - 2 * MIN,
      request_id: "per_2",
    })
    span("perm:3", {
      kind: "permission_wait",
      session_id: "ses_b",
      project_key: "/work/b",
      status: "running",
      start_ms: NOW - MIN,
      request_id: "per_3",
    })
    // A session whose latest turn failed; a stuck one; a loop; 429s.
    turn("ses_err", 0, { status: "error", start_ms: NOW - 2 * HOUR })
    // Stuck: running, and nothing written for it since 25 minutes ago.
    h.at(NOW - 25 * MIN)
    turn("ses_stuck", 0, { status: "running", end_ms: null, start_ms: NOW - 40 * MIN })
    flush()
    h.at(NOW)
    turn("ses_loop", 0, { loop: "same-call", start_ms: NOW - 3 * HOUR })
    for (const n of [1, 2, 3])
      span(`call:429:${n}`, {
        kind: "model_call",
        session_id: "ses_loop",
        project_key: "/work/a",
        provider: "anthropic",
        http_status: 429,
        start_ms: NOW - 5 * MIN,
      })
    span("call:cost", {
      kind: "model_call",
      session_id: "ses_loop",
      project_key: "/work/a",
      cost: 12.5,
      start_ms: NOW - MIN,
    })
    h.batch().mcpStatus({
      time_ms: NOW - 20 * MIN,
      directory: "/work/a",
      server: "github",
      status: "needs_auth",
      error: null,
    })
    h.batch().sample({
      time_ms: NOW - MIN,
      name: "queue_oldest_ms",
      dims: JSON.stringify({ project: "/work/a" }),
      value: 18 * MIN,
    })
    h.batch().sample({
      time_ms: NOW - MIN,
      name: "queue_depth",
      dims: JSON.stringify({ project: "/work/a" }),
      value: 4,
    })
    flush()
    const found = D.attention(h.store, {
      ...base,
      scope: { dir: "/work/a" },
      dailyBudget: 10,
      dropped: 3,
      activeFolders: new Set(["/work/a"]),
    })
    const byKind = Object.fromEntries(found.items.map((item) => [item.kind, item]))
    expect(found.items.map((item) => item.kind)).toEqual([
      "approvals",
      "errors",
      "stuck",
      "loops",
      "rate_limited",
      "mcp",
      "queue",
      "budget",
      "telemetry",
    ])
    expect(byKind.approvals).toMatchObject({
      count: 2,
      severity: "critical",
      worst: { ageMs: 35 * MIN },
      link: { page: "inbox" },
    })
    expect(byKind.errors!.link).toEqual({ page: "observability", params: { session: "ses_err" } })
    expect(byKind.stuck!.worst.ageMs).toBe(25 * MIN)
    expect(byKind.loops!.link.params).toEqual({ tab: "events", kind: "turn", loop: "1", range: "24h" })
    expect(byKind.rate_limited).toMatchObject({ count: 3, worst: { label: "anthropic" } })
    expect(byKind.mcp).toMatchObject({ severity: "critical", worst: { label: "github", status: "needs_auth" } })
    expect(byKind.mcp!.link).toEqual({
      page: "capabilities",
      params: { dir: "/work/a", tab: "mcp", kind: "mcp", item: "github" },
    })
    expect(byKind.queue).toMatchObject({ count: 4, worst: { ageMs: 18 * MIN } })
    expect(byKind.budget!.worst).toMatchObject({ amount: 12.5, limit: 10 })
    expect(byKind.telemetry).toMatchObject({ count: 3, worst: { status: "dropped" } })
    // The other project: only its own approval, which links to that request.
    const other = D.attention(h.store, { ...base, scope: { dir: "/work/b" } })
    expect(other.items.map((item) => item.kind)).toEqual(["approvals"])
    expect(other.items[0]!.link).toEqual({ page: "inbox", params: { ask: "per_3" } })
  })

  test("an alert covering an item shows once, as the item; others count under alerts; telemetry off", async () => {
    await using tmp = await tmpdir()
    const { span, flush, h } = setup(tmp.path)
    span("perm:1", {
      kind: "permission_wait",
      session_id: "ses_a",
      project_key: "/work/a",
      status: "running",
      start_ms: NOW - 15 * MIN,
    })
    flush()
    const alert = (fields: Partial<D.FiringAlert>): D.FiringAlert => ({
      id: "a",
      name: "Approval waiting long",
      severity: "warning",
      metric: "oldest_approval",
      scope: {},
      ack_ms: null,
      muted: false,
      start_ms: NOW - 5 * MIN,
      ...fields,
    })
    const found = D.attention(h.store, {
      ...base,
      alerts: [
        alert({}),
        alert({ id: "b", name: "Model calls failing", metric: "call_error_rate", severity: "critical" }),
        alert({ id: "c", name: "Acked", metric: "denials", ack_ms: NOW }),
      ],
    })
    expect(found.items.map((item) => [item.kind, item.alert])).toEqual([
      ["approvals", true],
      ["alerts", false],
    ])
    expect(found.items[1]).toMatchObject({
      count: 1,
      severity: "critical",
      worst: { label: "Model calls failing", critical: 1 },
    })
    const off = D.attention(h.store, { ...base, enabled: false })
    expect(off.items.map((item) => item.kind)).toEqual(["telemetry"])
    expect(off.items[0]!.worst.status).toBe("off")
  })
})

describe("tiles", () => {
  test("values agree with Metrics; turn time is successful turns' active time; denials aren't errors", async () => {
    await using tmp = await tmpdir()
    const { turn, span, flush, h } = setup(tmp.path)
    // 12 turns today: 9 ok (active 10 s, 20 s, …), 2 errors, 1 denied (a long one, not counted in turn time).
    for (let n = 0; n < 9; n++)
      turn("ses_1", n, { start_ms: NOW - 20 * HOUR + n * HOUR, end_ms: NOW - 20 * HOUR + n * HOUR + (n + 1) * 10_000 })
    turn("ses_1", 9, { status: "error", start_ms: NOW - 5 * HOUR })
    turn("ses_1", 10, { status: "error", start_ms: NOW - 4 * HOUR })
    turn("ses_1", 11, { status: "denied", start_ms: NOW - 3 * HOUR, end_ms: NOW - 3 * HOUR + 600_000 })
    span("call:1", {
      kind: "model_call",
      session_id: "ses_1",
      project_key: "/work/a",
      cost: 2,
      tokens_input: 100,
      context_tokens: 50_000,
      provider: "anthropic",
      model: "claude",
      start_ms: NOW - 2 * HOUR,
    })
    // A model without a known window: left out of Context used.
    span("call:2", {
      kind: "model_call",
      session_id: "ses_1",
      project_key: "/work/a",
      context_tokens: 90_000,
      provider: "custom",
      model: "local",
      start_ms: NOW - 2 * HOUR,
    })
    flush()
    const tiles = D.tiles(h.store, {
      filter: { range: "24h" },
      scope: {},
      context: context(),
      eventsDays: 30,
      dailyBudget: undefined,
      limitOf: (provider) => (provider === "anthropic" ? 200_000 : undefined),
    })
    expect(tiles.step).toBe(HOUR)
    expect(tiles.tiles.turns.value).toBe(12)
    expect(tiles.tiles.turns.series).toHaveLength(24)
    // (2 errors) ÷ 12 finished; the denied turn is in the hint, not the value.
    expect(tiles.tiles.turnErrors.value).toBeCloseTo((2 / 12) * 100)
    expect(tiles.tiles.turnErrors.hint).toMatchObject({ failed: 2, denied: 1 })
    // p95 of the nine successful turns' active time: 90 s (the denied 600 s one is left out).
    expect(tiles.tiles.turnTime.value).toBe(90_000)
    expect(tiles.tiles.turnTime.hint.ttftP95).toBeNull()
    expect(tiles.tiles.cost.value).toBe(2)
    expect(tiles.tiles.cost.hint.tokens).toBe(100)
    expect(tiles.tiles.rateLimits.hint.contextP95).toBe(25)
    // The same as the Metrics tab's turns over the same range.
    const metric = M.compute(h.store, { metric: "turns", filter: { range: "24h" }, context: context(), eventsDays: 30 })
    const counted = metric.series.reduce(
      (sum, series) => sum + series.points.reduce((acc, point) => acc + (point[1] ?? 0), 0),
      0,
    )
    expect(counted).toBe(12)
    // No earlier turns: no comparison for rates.
    expect(tiles.tiles.turnErrors.change).toEqual({ kind: "insufficient" })
  })

  test("comparisons: relative, percentage points, about the same, too little earlier data", () => {
    expect(D.changeOf("relative", 112, 100)).toEqual({ kind: "relative", value: expect.closeTo(12) })
    expect(D.changeOf("relative", 100.5, 100)).toEqual({ kind: "same" })
    expect(D.changeOf("relative", 5, 0)).toEqual({ kind: "insufficient" })
    expect(D.changeOf("relative", 0, 0)).toEqual({ kind: "same" })
    expect(D.changeOf("points", 3.1, 3.9, 50)).toEqual({ kind: "points", value: expect.closeTo(-0.8) })
    expect(D.changeOf("points", 3.1, 3.15, 50)).toEqual({ kind: "same" })
    expect(D.changeOf("points", 3.1, 3.9, 9)).toEqual({ kind: "insufficient" })
  })

  test("cost counts when each call happened, not when its session started; the budget today", async () => {
    await using tmp = await tmpdir()
    const { turn, span, flush, h } = setup(tmp.path)
    turn("ses_old", 0, { start_ms: NOW - 10 * DAY })
    span("call:old", {
      kind: "model_call",
      session_id: "ses_old",
      project_key: "/work/a",
      cost: 1,
      start_ms: NOW - 10 * DAY,
    })
    span("call:today", {
      kind: "model_call",
      session_id: "ses_old",
      project_key: "/work/a",
      cost: 5,
      start_ms: NOW - 20 * MIN,
    })
    flush()
    const day = D.tiles(h.store, {
      filter: { range: "24h" },
      scope: {},
      context: context(),
      eventsDays: 30,
      dailyBudget: 20,
    })
    expect(day.tiles.cost.value).toBe(5)
    expect(day.budget).toEqual({ today: expect.any(Number), limit: 20 })
    const month = D.tiles(h.store, {
      filter: { range: "14d" },
      scope: {},
      context: context(),
      eventsDays: 30,
      dailyBudget: undefined,
    })
    expect(month.tiles.cost.value).toBe(6)
    expect(month.step).toBe(12 * HOUR)
  })

  test("past the detailed window: hourly totals, ≈ on percentiles", async () => {
    await using tmp = await tmpdir()
    const { turn, flush, h } = setup(tmp.path)
    for (let n = 0; n < 12; n++) turn("ses_1", n, { start_ms: NOW - 20 * DAY + n * HOUR })
    flush()
    const tiles = D.tiles(h.store, {
      filter: { range: "30d" },
      scope: {},
      context: context(),
      eventsDays: 7,
      dailyBudget: undefined,
    })
    expect(tiles.source).toBe("totals")
    expect(tiles.tiles.turns.value).toBe(12)
    expect(tiles.tiles.turnTime.approx).toBe(true)
    expect(tiles.tiles.turns.hint.sessions).toBeNull()
  })
})

describe("breakdowns", () => {
  test("the top rows and an Other row with correct sums; helpers included", async () => {
    await using tmp = await tmpdir()
    const { turn, span, flush, h } = setup(tmp.path)
    const agents = ["build", "plan", "review", "explore"]
    agents.forEach((agent, at) => {
      for (let n = 0; n <= at; n++)
        turn(`ses_${agent}`, n, { agent, start_ms: NOW - HOUR + n, status: n === 0 ? "error" : "ok" })
    })
    span("helper:1", {
      kind: "helper_run",
      agent: "judge",
      agent_type: "helper",
      cost: 0.3,
      project_key: "/work/a",
      start_ms: NOW - HOUR,
    })
    for (const [n, tool] of ["bash", "bash", "read"].entries())
      span(`tool:${n}`, {
        tool,
        session_id: "ses_build",
        project_key: "/work/a",
        start_ms: NOW - HOUR,
        status: n === 0 ? "error" : "ok",
      })
    span("tool:mcp", {
      tool: "search",
      mcp_server: "github",
      session_id: "ses_build",
      project_key: "/work/a",
      start_ms: NOW - HOUR,
    })
    flush()
    const byAgent = D.breakdown(h.store, { by: "agent", limit: 2, filter: { range: "24h" }, context: context() })
    expect(byAgent.rows.map((row) => [row.key, row.turns])).toEqual([
      ["explore", 4],
      ["review", 3],
    ])
    expect(byAgent.other).toMatchObject({
      keys: expect.arrayContaining(["plan", "build", "judge"]),
      turns: 3,
      errors: 2,
    })
    const all = D.breakdown(h.store, { by: "agent", limit: 10, filter: { range: "24h" }, context: context() })
    expect(all.rows.find((row) => row.key === "judge")).toMatchObject({ type: "helper", cost: 0.3 })
    expect(all.rows.find((row) => row.key === "explore")!.errorRate).toBeCloseTo(25)
    const tools = D.breakdown(h.store, { by: "tool", limit: 8, filter: { range: "24h" }, context: context() })
    expect(tools.rows[0]).toMatchObject({ key: "bash", calls: 2, errors: 1, errorRate: 50 })
    expect(tools.rows.find((row) => row.server === "github")).toMatchObject({ key: "search", label: "search" })
  })
})
