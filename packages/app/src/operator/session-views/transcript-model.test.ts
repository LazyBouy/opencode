import { describe, expect, test } from "bun:test"
import type { OperatorCallSummary, OperatorInputItem, OperatorTurn } from "@opencode-ai/sdk/v2/client"
import { cacheOf, listOf, selectionOf, splitByTurn, statusOf } from "./transcript-model"

const item = (fields: Partial<OperatorInputItem> & Pick<OperatorInputItem, "id" | "kind">): OperatorInputItem =>
  ({ chars: 4, tokens: 1, method: "estimate", cache: "new", flags: [], ...fields }) as OperatorInputItem

describe("transcript model", () => {
  test("a call's items: system and tools, the earlier turns it sends again, and its own turn", () => {
    const items = [
      item({ id: "system", kind: "system", tokens: 100 }),
      item({ id: "tools", kind: "tools", tokens: 200 }),
      item({ id: "m1.1", kind: "user", message: 1, turn: 1, preview: "Hi", since: 1, cache: "read" }),
      item({ id: "m2.1", kind: "user", message: 2, turn: 2, preview: "hi", since: 2, cache: "read" }),
      item({ id: "m3.1", kind: "user", message: 3, turn: 3, preview: "hi", since: 6, cache: "read" }),
      item({
        id: "m4.1",
        kind: "assistant",
        message: 4,
        turn: 3,
        preview: "Hello!",
        since: 7,
        tokens: 40,
        cache: "partial",
      }),
      item({ id: "m5.1", kind: "user", message: 5, turn: 4, preview: "tell me about yourself" }),
      item({ id: "parameters", kind: "parameters", tokens: 0 }),
    ]
    const split = splitByTurn(items, 4)
    expect(split.entries.map((entry) => entry.item?.id ?? `turn ${entry.earlier!.turn}`)).toEqual([
      "system",
      "tools",
      "turn 1",
      "turn 2",
      "turn 3",
      "m5.1",
      "parameters",
    ])
    expect(split.earlier.map((group) => [group.turn, group.text, group.tokens, group.since, group.answered])).toEqual([
      [1, "Hi", 1, 1, false],
      [2, "hi", 1, 2, false],
      [3, "hi", 41, 6, true],
    ])
    // A call outside any turn, or in turn 1, sends nothing again.
    expect(splitByTurn(items, undefined).earlier).toEqual([])
    expect(splitByTurn(items, 1).earlier).toEqual([])
    expect(cacheOf(split.earlier[0]!.items)).toBe("read")
    expect(cacheOf(split.earlier[2]!.items)).toBe("partial")
  })

  test("the list groups the attempts of one step; side calls and single steps stand alone", () => {
    const call = (index: number, fields: Partial<OperatorCallSummary>) =>
      ({
        callID: `call_${index}`,
        index,
        kind: "agent",
        attempt: 1,
        attempts: 1,
        failed: false,
        ...fields,
      }) as OperatorCallSummary
    const calls = [
      call(1, { step: 1, failed: true, httpStatus: 429, attempts: 3 }),
      // A title call between two attempts does not split the step.
      call(4, { kind: "title" }),
      call(2, { step: 1, attempt: 2, attempts: 3, failed: true, error: { status: 429 } }),
      call(3, { step: 1, attempt: 3, attempts: 3 }),
      call(5, { step: 2 }),
    ]
    const turn = {
      index: 4,
      text: "x",
      calls: calls.map((entry) => entry.callID),
      unrecorded: 0,
      status: "ok",
    } as unknown as OperatorTurn
    const [listed] = listOf([turn], new Map(calls.map((entry) => [entry.callID, entry])), () => true)
    expect(listed!.steps.map((step) => step.calls.map((entry) => entry.index))).toEqual([[1, 2, 3], [4], [5]])
    expect(calls.map(statusOf)).toEqual([429, "ok", 429, "ok", "ok"])
    expect(statusOf(call(6, { receiving: true }))).toBe("receiving")
    expect(statusOf(call(7, { failed: true }))).toBe("failed")
    // Filtered out calls leave the list.
    const [filtered] = listOf(
      [turn],
      new Map(calls.map((entry) => [entry.callID, entry])),
      (entry) => entry.kind === "title",
    )
    expect(filtered!.calls.map((entry) => entry.index)).toEqual([4])
  })

  test("the selection: all turns, a turn, a call, and by default the latest turn", () => {
    const turns = [{ index: 1 }, { index: 2 }, { index: 0 }] as OperatorTurn[]
    expect(selectionOf(undefined, turns)).toEqual({ kind: "turn", turn: 2 })
    expect(selectionOf("all", turns)).toEqual({ kind: "all" })
    expect(selectionOf("turn:1", turns)).toEqual({ kind: "turn", turn: 1 })
    expect(selectionOf("call:call_9", turns)).toEqual({ kind: "call", callID: "call_9" })
  })
})
