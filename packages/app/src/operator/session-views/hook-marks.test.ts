import { describe, expect, test } from "bun:test"
import { hookMarks } from "./hook-marks"

const by = (hook: string) => ({ hook, level: "project", file: "/p/opencode.json", run: `hr.ses_1.${hook}` })

describe("what hooks did to a tool call", () => {
  test("a deny, from the error the model got, with or without a reason", () => {
    expect(
      hookMarks({ type: "tool", state: { status: "error", error: "Denied by hook guard: no rm -rf: ever" } }),
    ).toEqual([{ kind: "denied", hook: "guard", reason: "no rm -rf: ever" }])
    expect(hookMarks({ type: "tool", state: { status: "error", error: "Denied by hook stop." } })).toEqual([
      { kind: "denied", hook: "stop" },
    ])
    expect(hookMarks({ type: "tool", state: { status: "error", error: "File not found" } })).toEqual([])
  })

  test("changes keep their original; contexts in order; nothing for other parts", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: {
          other: 1,
          hook: {
            input: { by: [by("one"), by("two")], original: { pattern: "*.md" } },
            output: { by: [by("lint")], original: "a.md" },
            context: [
              { ...by("one"), event: "tool.before", text: "from one" },
              { ...by("lint"), event: "tool.after", text: "0 problems" },
            ],
          },
        },
      },
    }
    expect(hookMarks(part)).toEqual([
      { kind: "input", by: [by("one"), by("two")], original: '{\n  "pattern": "*.md"\n}' },
      { kind: "output", by: [by("lint")], original: "a.md" },
      { kind: "context", by: by("one"), event: "tool.before", text: "from one" },
      { kind: "context", by: by("lint"), event: "tool.after", text: "0 problems" },
    ])
    expect(hookMarks({ type: "text" })).toEqual([])
    expect(hookMarks({ type: "tool", state: { status: "completed", metadata: { hook: "nonsense" } } })).toEqual([])
  })

  test("a withheld output says so once", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: {
          hook: {
            output: { by: [by("redact")], original: "secret" },
            withheld: { ...by("redact"), reason: "Hook redact failed: it exited with 1" },
          },
        },
      },
    }
    expect(hookMarks(part)).toEqual([
      { kind: "withheld", by: by("redact"), reason: "Hook redact failed: it exited with 1" },
    ])
  })
})
