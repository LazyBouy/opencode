import { describe, expect, test } from "bun:test"
import { OperatorHookProtocol as Protocol } from "../../../src/operator/hooks/protocol"

// SPEC-0022 §7.1, §8: empty output means no objection; one JSON object is the answer; fields the event
// doesn't use are ignored and listed; anything else is a failure. Reasons and context are cut.

describe("hook answers", () => {
  test("empty stdout is no objection", () => {
    expect(Protocol.parse("tool.before", "  \n")).toEqual({ ok: true, answer: {}, ignored: [] })
  })

  test("a JSON answer is read for its event; other fields are ignored and listed", () => {
    expect(
      Protocol.parse("tool.before", JSON.stringify({ allow: false, reason: "no", output: "x", extra: 1 })),
    ).toEqual({ ok: true, answer: { allow: false, reason: "no" }, ignored: ["output", "extra"] })
    expect(Protocol.parse("tool.after", JSON.stringify({ output: "new", context: "lint ok" }))).toEqual({
      ok: true,
      answer: { output: "new", context: "lint ok" },
      ignored: [],
    })
    expect(Protocol.parse("compaction.after", '{"continue": false}')).toEqual({
      ok: true,
      answer: { continue: false },
      ignored: [],
    })
  })

  test("output that isn't one JSON object, or a field of the wrong type, is a failure", () => {
    expect(Protocol.parse("tool.before", "allow")).toEqual({ ok: false, error: "its output isn't one JSON object" })
    expect(Protocol.parse("tool.before", "[1]")).toEqual({ ok: false, error: "its output isn't one JSON object" })
    expect(Protocol.parse("tool.before", '{"allow": "no"}')).toEqual({
      ok: false,
      error: '"allow" must be true or false',
    })
    expect(Protocol.parse("tool.before", '{"input": "rm"}')).toEqual({ ok: false, error: '"input" must be an object' })
  })

  test("reasons are cut at 1,000 characters and context at 4,000", () => {
    const parsed = Protocol.parse(
      "tool.before",
      JSON.stringify({ allow: false, reason: "r".repeat(1500), context: "c".repeat(5000) }),
    )
    if (!parsed.ok) throw new Error("expected an answer")
    expect(parsed.answer.reason).toHaveLength(1001)
    expect(parsed.answer.context).toBe("c".repeat(4000) + " (cut by the server)")
    expect(Protocol.contextBlock("ci", "red")).toBe("From hook ci:\nred")
  })
})
