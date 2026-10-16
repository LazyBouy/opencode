import { describe, expect, test } from "bun:test"
import { OperatorTelemetryQuery as Q } from "@/operator/telemetry/query"
import type { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { tmpdir } from "../../fixture/fixture"
import { harness, T0 } from "./harness"

// observability_spec.md §7.2–§7.3, §21.1: every filter parameter; cursors never skip rows that share a sort value;
// facets ignore their own filter; the live tail.

const NOW = T0 + 60 * 60 * 1000

function seeded(dir: string) {
  const h = harness(dir)
  const span = (id: string, fields: Partial<OperatorTelemetryStore.SpanWrite>) =>
    h
      .batch()
      .span({
        id,
        kind: "tool_call",
        name: `execute_tool ${fields.tool ?? "bash"}`,
        status: "ok",
        start_ms: T0,
        source: "part",
        ...fields,
      })
  span("a", {
    session_id: "s1",
    project_key: "/work/a",
    agent: "build",
    tool: "bash",
    status: "error",
    error_type: "tool_error",
    error_message: "boom",
    active_ms: 100,
  })
  span("b", {
    session_id: "s1",
    project_key: "/work/a",
    agent: "build",
    tool: "edit",
    active_ms: 5_000,
    start_ms: T0 + 10,
  })
  span("c", {
    session_id: "s2",
    project_key: "/work/b",
    agent: "plan",
    tool: "bash",
    status: "denied",
    error_type: "user_denied",
    start_ms: T0 + 20,
  })
  span("d", {
    kind: "model_call",
    name: "chat gpt-5",
    session_id: "s2",
    project_key: "/work/b",
    agent: "plan",
    model: "gpt-5",
    provider: "openai",
    http_status: 429,
    cost: 0.5,
    tokens_input: 900,
    tokens_output: 200,
    start_ms: T0 + 30,
  })
  span("e", {
    kind: "model_call",
    name: "chat claude",
    session_id: "s3",
    project_key: "/elsewhere",
    agent: "build",
    model: "claude",
    provider: "anthropic",
    http_status: 503,
    cost: 0.01,
    start_ms: T0 + 40,
  })
  span("t", {
    kind: "turn",
    name: "invoke_agent build",
    session_id: "s1",
    project_key: "/work/a",
    agent: "build",
    loop: "same-call",
    start_ms: T0 + 50,
  })
  // Five rows with the same start: a page edge among them must not skip one.
  for (const n of [1, 2, 3, 4, 5]) span(`tie${n}`, { session_id: "s4", project_key: "/work/a", start_ms: T0 + 1000 })
  h.flush()
  const context: Q.Context = {
    now: NOW,
    known: ["/work/a", "/work/b"],
    stuckMinutes: 10,
    projectsOf: (ns) => ({ keys: ns === "acme" ? ["/work/b"] : ["/work/a"], rest: ns === "opencode" }),
  }
  return { h, context }
}

const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((row) => row.id).toSorted()

describe("telemetry queries", () => {
  test("every filter parameter narrows the events", async () => {
    await using tmp = await tmpdir()
    const { h, context } = seeded(tmp.path)
    const events = (filter: Q.Filter) =>
      ids(Q.events(h.store, { range: "24h", ...filter }, context, { limit: 1000 }).rows)
    expect(events({ kind: "model_call" })).toEqual(["d", "e"])
    expect(events({ status: "error,denied" })).toEqual(["a", "c"])
    expect(events({ tool: "bash", agent: "build" })).toEqual(["a"])
    expect(events({ model: "gpt-5" })).toEqual(["d"])
    expect(events({ provider: "anthropic" })).toEqual(["e"])
    expect(events({ errorType: "user_denied" })).toEqual(["c"])
    expect(events({ dir: "/work/b" })).toEqual(["c", "d"])
    expect(events({ ns: "acme" })).toEqual(["c", "d"])
    // OpenCode's namespace holds the projects in no namespace.
    expect(events({ ns: "opencode", kind: "model_call" })).toEqual(["e"])
    expect(events({ session: "s1" })).toEqual(["a", "b", "t"])
    expect(events({ minCost: 0.1 })).toEqual(["d"])
    expect(events({ maxCost: 0.1, kind: "model_call" })).toEqual(["e"])
    expect(events({ minDuration: 1000 })).toEqual(["b"])
    expect(events({ maxDuration: 1000 })).toEqual(["a"])
    expect(events({ minTokens: 1000 })).toEqual(["d"])
    expect(events({ loop: "1" })).toEqual(["t"])
    expect(events({ http: "429" })).toEqual(["d"])
    expect(events({ http: "5xx" })).toEqual(["e"])
    expect(events({ q: "boom" })).toEqual(["a"])
    expect(events({ q: "gpt" })).toEqual(["d"])
    // Outside the range: none.
    expect(Q.events(h.store, { from: T0 + 2000, to: T0 + 3000 }, context).rows).toEqual([])
  })

  test("cursors page through rows sharing a sort value without skipping one", async () => {
    await using tmp = await tmpdir()
    const { h, context } = seeded(tmp.path)
    const seen: string[] = []
    let cursor: string | undefined
    for (let step = 0; step < 10; step++) {
      const page = Q.events(h.store, { session: "s4" }, context, { limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.rows.map((row) => row.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen.toSorted()).toEqual(["tie1", "tie2", "tie3", "tie4", "tie5"])
    expect(new Set(seen).size).toBe(5)
    // By cost, ascending: nulls first, then by value.
    const byCost = Q.events(h.store, { kind: "model_call" }, context, { sort: "cost:asc" }).rows.map((row) => row.id)
    expect(byCost).toEqual(["e", "d"])
  })

  test("facets count a field's values under the filter, leaving its own filter out", async () => {
    await using tmp = await tmpdir()
    const { h, context } = seeded(tmp.path)
    const statuses = Q.facet(h.store, { status: "error", dir: "/work/a" }, context, {
      scope: "events",
      field: "status",
    })
    expect(statuses).toEqual([
      { value: "ok", count: 7 },
      { value: "error", count: 1 },
    ])
    const projects = Q.facet(h.store, { kind: "model_call", dir: "/work/a" }, context, {
      scope: "events",
      field: "dir",
    })
    expect(projects).toEqual([
      { value: "/elsewhere", count: 1 },
      { value: "/work/b", count: 1 },
    ])
  })

  test("the live tail gives rows written after a seq, oldest first, updates included", async () => {
    await using tmp = await tmpdir()
    const { h, context } = seeded(tmp.path)
    const seq = h.store.lastSeq()
    h.batch().span({ id: "b", kind: "tool_call", session_id: "s1", status: "error" })
    h.batch().span({ id: "new", kind: "retry", session_id: "s1", status: "ok", start_ms: T0 + 60, source: "status" })
    h.flush()
    const tail = Q.events(h.store, {}, context, { after: seq })
    expect(ids(tail.rows)).toEqual(["b", "new"])
    expect(tail.rows.find((row) => row.id === "b")!.status).toBe("error")
    expect(tail.rows.map((row) => row.seq)).toEqual(tail.rows.map((row) => row.seq).toSorted((a, b) => a - b))
    expect(tail.seq).toBe(tail.rows.at(-1)!.seq)
    expect(Q.events(h.store, {}, context, { after: tail.seq }).rows).toEqual([])
  })

  test("sessions: activity in the range, top sessions by default, sorted, counted, stuck", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const turn = (session: string, start: number, status: OperatorTelemetryStore.Status, cost = 0) =>
      h
        .batch()
        .span({
          id: `turn:${session}`,
          kind: "turn",
          session_id: session,
          status,
          start_ms: start,
          ...(status === "running" ? {} : { end_ms: start + 100 }),
          source: "message",
        })
    turn("p", T0, "ok")
    turn("child", T0 + 10, "ok")
    turn("busy", T0 + 20, "running")
    h.contexts.set("child", { parentID: "p" })
    h.contexts.set("p", { title: "Parent" })
    h.flush()
    const context: Q.Context = {
      now: T0 + 30 * 60_000,
      known: [],
      stuckMinutes: 10,
      projectsOf: () => ({ keys: [], rest: false }),
    }
    const rows = (filter: Q.Filter, sort?: string) =>
      Q.sessions(h.store, { range: "24h", ...filter }, context, sort ? { sort } : {})
    expect(ids(rows({}).rows)).toEqual(["busy", "p"])
    expect(rows({}).total).toBe(2)
    expect(ids(rows({ roots: "0" }).rows)).toEqual(["busy", "child", "p"])
    expect(rows({}, "started:asc").rows.map((row) => row.id)).toEqual(["p", "busy"])
    expect(ids(rows({ sessionStatus: "running" }).rows)).toEqual(["busy"])
    // Running with nothing new for 10 minutes: stuck.
    expect(ids(rows({ stuck: "1" }).rows)).toEqual(["busy"])
    expect(ids(rows({ q: "Parent" }).rows)).toEqual(["p"])
    expect(ids(rows({ session: "p" }).rows)).toEqual(["child", "p"])
  })

  test("a session's turns: numbered, the latest 20, paging back before a time", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    for (let n = 1; n <= 25; n++)
      h.batch().span({
        id: `turn:${n}`,
        kind: "turn",
        session_id: "s",
        status: "ok",
        start_ms: T0 + n * 1000,
        end_ms: T0 + n * 1000 + 10,
        source: "message",
      })
    h.flush()
    const latest = Q.turns(h.store, "s", {})
    expect(latest.turns.map((item) => item.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6))
    expect(latest.earlier).toBe(true)
    const back = Q.turns(h.store, "s", { before: T0 + 6000 })
    expect(back.turns.map((item) => item.number)).toEqual([1, 2, 3, 4, 5])
    expect(back.earlier).toBe(false)
    expect(Q.turns(h.store, "s", { all: true }).turns).toHaveLength(25)
  })
})
