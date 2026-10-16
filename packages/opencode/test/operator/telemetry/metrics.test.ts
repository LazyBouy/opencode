import { describe, expect, test } from "bun:test"
import { OperatorTelemetryMetrics as M } from "@/operator/telemetry/metrics"
import type { OperatorTelemetryQuery } from "@/operator/telemetry/query"
import type { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorTelemetryWriter } from "@/operator/telemetry/writer"
import { tmpdir } from "../../fixture/fixture"
import { harness, T0 } from "./harness"

// observability_spec.md §12, §21.1: the time step per range; series from spans inside the detailed window (exact
// percentiles) and from hourly totals past it (≈, filters totals don't keep reported); top 5 + Other; group-by; the
// click-through filter on each series; samples, tables and per-turn histograms.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// T0 on a whole hour, so steps line up in the assertions.
const START = Math.floor(T0 / HOUR) * HOUR + HOUR

const context = (now: number): OperatorTelemetryQuery.Context => ({
  now,
  known: ["/work/a", "/work/b"],
  stuckMinutes: 10,
  projectsOf: (ns) => ({ keys: ns === "acme" ? ["/work/b"] : ["/work/a"], rest: ns === "opencode" }),
})

function seeded(dir: string) {
  const h = harness(dir)
  const span = (id: string, fields: Partial<OperatorTelemetryStore.SpanWrite>) =>
    h.batch().span({ id, kind: "tool_call", name: id, status: "ok", start_ms: START, source: "part", ...fields })
  // Two turns: one ok with three model calls, one failed with one.
  span("turn:1", {
    kind: "turn",
    turn_id: "turn:1",
    session_id: "s1",
    project_key: "/work/a",
    agent: "build",
    end_ms: START + 10_000,
  })
  span("turn:2", {
    kind: "turn",
    turn_id: "turn:2",
    session_id: "s2",
    project_key: "/work/b",
    agent: "plan",
    status: "error",
    start_ms: START + 20 * MIN,
    end_ms: START + 20 * MIN + 4_000,
  })
  const call = (id: string, turn: string, start: number, fields: Partial<OperatorTelemetryStore.SpanWrite>) =>
    span(id, {
      kind: "model_call",
      turn_id: turn,
      parent_id: turn,
      session_id: turn === "turn:1" ? "s1" : "s2",
      project_key: turn === "turn:1" ? "/work/a" : "/work/b",
      agent: turn === "turn:1" ? "build" : "plan",
      provider: "openai",
      model: "gpt-5",
      start_ms: start,
      end_ms: start + 1_000,
      duration_ms: fields.duration_ms ?? 1_000,
      active_ms: fields.duration_ms ?? 1_000,
      tokens_input: 100,
      tokens_cache_read: 300,
      tokens_output: 50,
      cost: 0.01,
      ...fields,
    })
  call("call:a", "turn:1", START + 100, { duration_ms: 1_000 })
  call("call:b", "turn:1", START + 200, { duration_ms: 2_000, end_ms: START + 2_200 })
  call("call:c", "turn:1", START + 300, {
    duration_ms: 3_000,
    end_ms: START + 3_300,
    model: "claude",
    provider: "anthropic",
  })
  call("call:d", "turn:2", START + 20 * MIN + 100, { status: "error", http_status: 429 })
  // Eight tools (one of them MCP), so the top 5 leave three in Other.
  const tools = ["bash", "bash", "bash", "edit", "edit", "read", "grep", "glob", "list", "webfetch"]
  tools.forEach((tool, index) =>
    span(`tool:${index}`, {
      turn_id: "turn:1",
      parent_id: "turn:1",
      session_id: "s1",
      project_key: "/work/a",
      tool,
      start_ms: START + 1_000 + index,
      end_ms: START + 1_000 + index + 100 * (index + 1),
      ...(index === 0 ? { status: "error" as const } : {}),
    }),
  )
  span("tool:mcp", {
    turn_id: "turn:1",
    session_id: "s1",
    project_key: "/work/a",
    tool: "github_search",
    mcp_server: "github",
    start_ms: START + 1_500,
    end_ms: START + 1_600,
  })
  h.batch().sample({ time_ms: START + MIN, name: "sessions_running", dims: null, value: 2 })
  h.batch().sample({ time_ms: START + 2 * MIN, name: "sessions_running", dims: null, value: 3 })
  h.flush()
  OperatorTelemetryWriter.totals(h.store)
  return h
}

const NOW = START + HOUR
const metric = (
  h: ReturnType<typeof seeded>,
  name: M.Metric,
  filter: OperatorTelemetryQuery.Filter = { from: START, to: START + HOUR },
  extra: { groupBy?: string; now?: number; eventsDays?: number } = {},
) =>
  M.compute(h.store, {
    metric: name,
    filter,
    context: context(extra.now ?? NOW),
    eventsDays: extra.eventsDays ?? 14,
    ...(extra.groupBy ? { groupBy: extra.groupBy } : {}),
  })
const total = (series: M.Series) => series.points.reduce((sum, [, value]) => sum + (value ?? 0), 0)
const byKey = (result: M.Result) => Object.fromEntries(result.series.map((series) => [series.key, series]))

describe("telemetry metrics", () => {
  test("the step follows the range, and is at least an hour past the detailed window", () => {
    expect(M.stepOf(15 * MIN, false)).toBe(15_000)
    expect(M.stepOf(HOUR, false)).toBe(MIN)
    expect(M.stepOf(6 * HOUR, false)).toBe(5 * MIN)
    expect(M.stepOf(DAY, false)).toBe(15 * MIN)
    expect(M.stepOf(7 * DAY, false)).toBe(HOUR)
    expect(M.stepOf(30 * DAY, false)).toBe(6 * HOUR)
    expect(M.stepOf(90 * DAY, false)).toBe(DAY)
    expect(M.stepOf(HOUR, true)).toBe(HOUR)
  })

  test("a named range steps by its own length (its window ends just past now)", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    expect(metric(h, "calls", { range: "24h" }).step).toBe(15 * MIN)
    expect(metric(h, "calls", { range: "6h" }).step).toBe(5 * MIN)
  })

  test("from events: counts per step stacked by status, exact percentiles, and each series' Events filter", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    const turns = metric(h, "turns")
    expect(turns).toMatchObject({ step: MIN, source: "events", approx: false, unit: "count", kind: "turn" })
    expect(turns.series.map((series) => series.key).toSorted()).toEqual(["error", "ok"])
    const ok = byKey(turns).ok!
    expect(ok.points[0]).toEqual([START, 1])
    expect(ok.filter).toEqual({ status: "ok" })
    expect(byKey(turns).error!.points[20]).toEqual([START + 20 * MIN, 1])
    // Successful calls only: 1 s, 2 s, 3 s.
    const duration = byKey(metric(h, "call_duration"))
    expect(duration.p50!.points[0]![1]).toBe(2_000)
    expect(duration.p95!.points[0]![1]).toBe(3_000)
    // Errors and 429s as lines, each opening its own filter.
    const errors = byKey(metric(h, "call_errors"))
    expect(total(errors.errors!)).toBe(1)
    expect(total(errors.http_429!)).toBe(1)
    expect(errors.http_429!.filter).toEqual({ http: "429" })
    expect(errors.retries_exhausted!.filter).toEqual({ kind: "turn", errorType: "retries_exhausted" })
    // Tokens by type, never one mixed total; cache hit per model.
    const tokens = byKey(metric(h, "tokens"))
    expect(total(tokens.input!)).toBe(400)
    expect(total(tokens.cache_read!)).toBe(1200)
    const hit = byKey(metric(h, "cache_hit"))
    expect(hit["gpt-5"]!.points[0]![1]).toBe(75)
    expect(hit["gpt-5"]!.filter).toEqual({ model: "gpt-5" })
    // Error rate per step: the ok turn's step 0%, the failed one's 100%, steps with none empty.
    const rate = byKey(metric(h, "turn_error_rate"))
    expect(rate.errors!.points[0]![1]).toBe(0)
    expect(rate.errors!.points[20]![1]).toBe(100)
    expect(rate.errors!.points[5]![1]).toBeNull()
  })

  test("top 5 and Other, never dropping the rest; the group-by splits where the section offers it", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    const tools = metric(h, "tool_calls")
    expect(tools.series).toHaveLength(6)
    expect(tools.series[0]).toMatchObject({ key: "bash", filter: { tool: "bash" } })
    expect(byKey(tools).Other).toBeDefined()
    expect(tools.other).toHaveLength(3)
    expect(tools.series.reduce((sum, series) => sum + total(series), 0)).toBe(11)
    // Calls by model.
    const calls = byKey(metric(h, "calls", undefined, { groupBy: "model" }))
    expect(total(calls["gpt-5"]!)).toBe(3)
    expect(total(calls.claude!)).toBe(1)
    // A group-by the section doesn't offer is left out.
    expect(metric(h, "tool_errors", undefined, { groupBy: "model" }).series.map((series) => series.key)).toEqual([
      "errors",
      "denials",
    ])
  })

  test("past the detailed window: hourly totals, ≈, and the filters totals don't keep", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    const later = START + 30 * DAY
    const filter = { from: START - DAY, to: START + DAY }
    const calls = metric(h, "calls", filter, { now: later, eventsDays: 7 })
    expect(calls).toMatchObject({ source: "totals", approx: true, step: HOUR })
    expect(total(calls.series[0]!)).toBe(4)
    const cost = metric(h, "cost", filter, { now: later, eventsDays: 7 })
    expect(total(cost.series[0]!)).toBeCloseTo(0.04)
    // Percentiles from histograms are estimates within a bucket: 2 s and 3 s fall in (1 s, 2 s] and (2 s, 5 s].
    const p95 = byKey(metric(h, "call_duration", filter, { now: later, eventsDays: 7 })).p95!
    const value = p95.points.find(([, v]) => v !== null)![1]!
    expect(value).toBeGreaterThan(2_000)
    expect(value).toBeLessThanOrEqual(5_000)
    // A session filter can't apply to totals: said, not hidden.
    expect(metric(h, "calls", { ...filter, session: "s1" }, { now: later, eventsDays: 7 }).ignored).toEqual(["session"])
    // Group-by kind isn't kept in totals.
    expect(metric(h, "calls", filter, { now: later, eventsDays: 7, groupBy: "kind" }).ignored).toEqual(["groupBy"])
    // Metrics only events have.
    expect(metric(h, "calls_per_turn", filter, { now: later, eventsDays: 7 }).note).toBe("needs-events")
    expect(metric(h, "approval_table", filter, { now: later, eventsDays: 7 }).note).toBe("needs-events")
  })

  test("time to first token needs call recording; samples, the tool table and per-turn histograms", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    expect(metric(h, "ttft").note).toBe("needs-recording")
    const running = metric(h, "running")
    expect(
      byKey(running)
        .running!.points.slice(0, 3)
        .map(([, value]) => value),
    ).toEqual([null, 2, 3])
    const table = metric(h, "tool_table").table!
    expect(table[0]).toMatchObject({ tool: "bash", mcp: 0, calls: 3, errors: 1 })
    expect(table.find((row) => row.mcp === 1)).toMatchObject({ tool: "github", calls: 1 })
    const histogram = metric(h, "calls_per_turn")
    expect(histogram.buckets).toEqual(["1", "2", "4", "8", "16", "32", "64", "128+"])
    // One turn with 3 calls (bucket "4"), one with 1 (bucket "1").
    expect(histogram.series[0]!.points.map(([, value]) => value)).toEqual([1, 0, 1, 0, 0, 0, 0, 0])
  })
})
