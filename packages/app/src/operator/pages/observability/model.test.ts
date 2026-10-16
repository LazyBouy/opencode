import { describe, expect, test } from "bun:test"
import { bar, chips, durationParts, filterOf, rangeOf, rangeQuery, reach, treeRows } from "./model"

// observability_spec.md §8.2, §8.4, §10.3: the URL is the state; durations; the turn tree.

const span = (id: string, parent: string | null, start: number, end: number | null = start + 10) => ({
  id,
  kind: "tool_call",
  parent_id: parent,
  start_ms: start,
  end_ms: end,
  attempt: null,
  attempts: null,
  attrs: null,
})

describe("observability page model", () => {
  test("the URL's filters go to the API as they are; a session filter is inSession in the page", () => {
    expect(
      filterOf({ kind: "tool_call", status: "error,denied", tab: "events", session: "ses_open", inSession: "ses_f" }),
    ).toEqual({
      kind: "tool_call",
      status: "error,denied",
      session: "ses_f",
    })
    expect(chips({ kind: "tool_call", dir: "/x", roots: "0", q: "boom" }).map((chip) => chip.key)).toEqual([
      "kind",
      "q",
    ])
  })

  test("the range: a custom one when from and to are set, else the preset (the remembered one, else 24h)", () => {
    expect(rangeOf({ from: "100", to: "200" })).toEqual({ from: 100, to: 200 })
    expect(rangeOf({ from: "300", to: "200" })).toEqual({ range: "24h" })
    expect(rangeOf({}, "7d")).toEqual({ range: "7d" })
    expect(rangeOf({ range: "bogus" })).toEqual({ range: "24h" })
    expect(rangeQuery({ from: 1, to: 2 })).toEqual({ from: "1", to: "2" })
    expect(rangeQuery({ range: "1h" })).toEqual({ range: "1h" })
    const now = 100 * 24 * 60 * 60_000
    expect(reach({ range: "90d" }, now, 30).beyond).toBe(true)
    expect(reach({ range: "7d" }, now, 30).beyond).toBe(false)
  })

  test("durations use their two biggest units", () => {
    expect(durationParts(850)).toEqual([{ unit: "ms", value: 850 }])
    expect(durationParts(12_400)).toEqual([{ unit: "s", value: 12 }])
    expect(durationParts(4_400)).toEqual([{ unit: "s", value: 4.4 }])
    expect(durationParts(124_000)).toEqual([
      { unit: "m", value: 2 },
      { unit: "s", value: 4 },
    ])
    expect(durationParts(60_000)).toEqual([{ unit: "m", value: 1 }])
    expect(durationParts(4_200_000)).toEqual([
      { unit: "h", value: 1 },
      { unit: "m", value: 10 },
    ])
  })

  test("the turn's spans in tree order, each under its parent, children by start; collapsed rows hide theirs", () => {
    const turn = { ...span("turn:1", null, 0, 1000), kind: "turn" }
    const spans = [
      span("call:2", "turn:1", 300),
      span("tool:1", "turn:1", 100),
      span("perm:1", "tool:1", 150),
      span("call:1", "turn:1", 50),
      span("orphan", "gone", 900),
    ]
    expect(treeRows(turn, spans).map((row) => [row.span.id, row.depth])).toEqual([
      ["turn:1", 0],
      ["call:1", 1],
      ["tool:1", 1],
      ["perm:1", 2],
      ["call:2", 1],
      ["orphan", 1],
    ])
    expect(treeRows(turn, spans, new Set(["tool:1"])).map((row) => row.span.id)).not.toContain("perm:1")
    expect(bar({ start_ms: 250, end_ms: 500 }, { from: 0, to: 1000 }, 2000)).toEqual({ left: 0.25, width: 0.25 })
  })
})
