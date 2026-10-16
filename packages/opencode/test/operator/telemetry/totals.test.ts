import { describe, expect, test } from "bun:test"
import { OperatorTelemetryRetention } from "@/operator/telemetry/retention"
import { OperatorTelemetryTotals } from "@/operator/telemetry/totals"
import { OperatorTelemetryWriter } from "@/operator/telemetry/writer"
import { tmpdir } from "../../fixture/fixture"
import { assistant, harness, idle, T0, tool, user } from "./harness"

// observability_spec.md §6, §21.1: totals right after a late update, percentiles within a bucket, retention by end
// time with whole turns, kept sessions, totals outliving spans, deleted sessions leaving the totals as they were.

const HOUR = OperatorTelemetryTotals.HOUR
const DAY = OperatorTelemetryRetention.DAY
const S = "ses_main"
const sum = (rows: OperatorTelemetryTotals.Row[], key: keyof OperatorTelemetryTotals.Measures, kind?: string) =>
  rows.filter((row) => !kind || row.kind === kind).reduce((total, row) => total + Number(row[key]), 0)

function session(h: ReturnType<typeof harness>, id: string, start: number, cost: number) {
  user(h, id, `msg_${id}_u`, start)
  assistant(h, id, `msg_${id}_a`, `msg_${id}_u`, {
    created: start + 10,
    completed: start + 1000,
    finish: "stop",
    cost,
    tokens: { input: 100, output: 10 },
  })
  tool(h, id, `msg_${id}_a`, `prt_${id}`, "bash", {
    status: "completed",
    input: { command: "ls" },
    output: "",
    title: "",
    metadata: {},
    time: { start: start + 100, end: start + 600 },
  })
  h.at(start + 2000)
  idle(h, id)
}

describe("telemetry totals and retention", () => {
  test("an hour's totals come from its spans, counted once, and follow a late update", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const hour = OperatorTelemetryTotals.hourOf(T0)
    session(h, S, hour + 60_000, 0.05)
    h.flush()
    expect(OperatorTelemetryWriter.totals(h.store)).toBe(1)
    let rows = OperatorTelemetryTotals.rows(h.store, "total_hour", hour, hour + HOUR)
    expect(sum(rows, "count", "turn")).toBe(1)
    expect(sum(rows, "count", "tool_call")).toBe(1)
    // The turn holds its calls' sums: cost and tokens are counted on the calls only.
    expect(sum(rows, "cost")).toBeCloseTo(0.05)
    expect(sum(rows, "tokens_input")).toBe(100)
    // A late update (the tool's end corrected) marks the hour again.
    tool(h, S, `msg_${S}_a`, `prt_${S}`, "bash", {
      status: "completed",
      input: { command: "ls" },
      output: "",
      title: "",
      metadata: {},
      time: { start: hour + 60_100, end: hour + 64_100 },
    })
    h.flush()
    OperatorTelemetryWriter.totals(h.store)
    rows = OperatorTelemetryTotals.rows(h.store, "total_hour", hour, hour + HOUR)
    expect(sum(rows, "active_ms", "tool_call")).toBe(4000)
    expect(OperatorTelemetryWriter.totals(h.store)).toBe(0)
  })

  test("percentiles from the histogram are within one bucket of the exact value", () => {
    const values = Array.from({ length: 2000 }, (_, i) => Math.round(Math.exp(((i * 7919) % 2000) / 160)))
    const hist = Array.from({ length: OperatorTelemetryTotals.BUCKETS.length + 1 }, () => 0)
    for (const value of values) hist[OperatorTelemetryTotals.bucketOf(value)]! += 1
    const sorted = values.toSorted((a, b) => a - b)
    for (const p of [0.5, 0.9, 0.95, 0.99]) {
      const exact = sorted[Math.ceil(p * sorted.length) - 1]!
      const estimate = OperatorTelemetryTotals.percentile(hist, p)!
      expect(
        Math.abs(OperatorTelemetryTotals.bucketOf(estimate) - OperatorTelemetryTotals.bucketOf(exact)),
      ).toBeLessThanOrEqual(1)
    }
  })

  test("a session deleted for good leaves the totals as they were, even when its hour is recomputed", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const hour = OperatorTelemetryTotals.hourOf(T0)
    session(h, "ses_gone", hour + 1000, 0.1)
    session(h, "ses_kept", hour + 5000, 0.2)
    h.flush()
    OperatorTelemetryWriter.totals(h.store)
    const before = OperatorTelemetryTotals.rows(h.store, "total_hour", hour, hour + HOUR)
    h.event("session.deleted", { sessionID: "ses_gone", info: { id: "ses_gone" } })
    h.flush()
    // A later write in the same hour recomputes it.
    session(h, "ses_late", hour + 9000, 0.3)
    h.flush()
    OperatorTelemetryWriter.totals(h.store)
    const after = OperatorTelemetryTotals.rows(h.store, "total_hour", hour, hour + HOUR)
    expect(sum(after, "count", "turn")).toBe(sum(before, "count", "turn") + 1)
    expect(sum(after, "cost")).toBeCloseTo(sum(before, "cost") + 0.3)
    expect(h.store.session("ses_gone")).toBeUndefined()
  })

  test("retention purges by end time and whole turns; kept sessions stay; totals outlive spans", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const now = T0 + 40 * DAY
    // A turn that started 31 days ago and ended 29 days ago stays whole.
    user(h, "ses_long", "msg_long", now - 31 * DAY)
    tool(h, "ses_long", "msg_long", "prt_long", "bash", {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: {},
      time: { start: now - 31 * DAY, end: now - 31 * DAY + 10 },
    })
    h.at(now - 29 * DAY)
    idle(h, "ses_long")
    session(h, "ses_old", now - 35 * DAY, 0.4)
    session(h, "ses_pin", now - 36 * DAY, 0.5)
    h.batch().log({
      id: "log:1:1",
      time_ms: now - 32 * DAY,
      level: "WARN",
      message: "old",
      run: null,
      service: null,
      session_id: null,
      fields: null,
    })
    h.batch().log({
      id: "log:1:2",
      time_ms: now - DAY,
      level: "WARN",
      message: "new",
      run: null,
      service: null,
      session_id: null,
      fields: null,
    })
    h.batch().sample({ time_ms: now - 31 * DAY, name: "sessions_running", dims: null, value: 1 })
    h.flush()
    OperatorTelemetryWriter.totals(h.store)
    h.store.db.query("INSERT INTO kept_session (session_id, time_ms) VALUES (?, ?)").run("ses_pin", now)
    const totalsBefore = OperatorTelemetryTotals.rows(h.store, "total_hour", 0, now)
    const purged = OperatorTelemetryRetention.purge(h.store, { eventsDays: 30, totalsDays: 400, now, batch: 2 })
    expect(h.store.spansOfSession("ses_old")).toEqual([])
    expect(h.store.session("ses_old")).toBeUndefined()
    // The long turn ended inside the window: it and its old tool call stay.
    expect(h.store.span("turn:msg_long")).toBeDefined()
    expect(h.store.span("tool:prt_long")).toBeDefined()
    expect(h.store.spansOfSession("ses_pin").length).toBeGreaterThan(0)
    expect(h.store.logs().map((entry) => entry.message)).toEqual(["new"])
    expect(h.store.samples()).toEqual([])
    expect(purged.spans).toBeGreaterThan(0)
    // Totals stay after their spans go, and a recompute of that hour keeps them.
    OperatorTelemetryTotals.mark(h.store, [now - 35 * DAY])
    OperatorTelemetryWriter.totals(h.store)
    expect(sum(OperatorTelemetryTotals.rows(h.store, "total_hour", 0, now), "cost")).toBeCloseTo(
      sum(totalsBefore, "cost"),
    )
    // Totals older than their own setting go too.
    OperatorTelemetryRetention.purge(h.store, { eventsDays: 30, totalsDays: 30, now: now + 10 * DAY })
    expect(OperatorTelemetryTotals.rows(h.store, "total_hour", 0, now - 30 * DAY)).toEqual([])
  })

  test("retention days stay in range, and totals are never kept less than events", () => {
    expect(OperatorTelemetryRetention.days({})).toEqual({ eventsDays: 30, totalsDays: 400 })
    expect(OperatorTelemetryRetention.days({ eventsDays: 0, totalsDays: 5000 })).toEqual({
      eventsDays: 1,
      totalsDays: 1825,
    })
    expect(OperatorTelemetryRetention.days({ eventsDays: 200, totalsDays: 40 })).toEqual({
      eventsDays: 200,
      totalsDays: 200,
    })
  })
})
