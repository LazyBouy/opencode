import { describe, expect, test } from "bun:test"
import { lineDiff, pieces, runs, subagentOf } from "./content"

describe("a message as sent, laid out for reading", () => {
  test("Anthropic: text, thinking, a tool call and its result", () => {
    expect(
      pieces({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Look first." },
          { type: "text", text: "Reading it." },
          { type: "tool_use", id: "toolu_1", name: "read", input: { filePath: "a.ts" } },
        ],
      }),
    ).toEqual([
      { kind: "reasoning", text: "Look first." },
      { kind: "text", text: "Reading it." },
      { kind: "tool-call", name: "read", id: "toolu_1", args: '{"filePath":"a.ts"}' },
    ])
    expect(pieces({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] })).toEqual(
      [{ kind: "tool-result", id: "toolu_1", text: "ok" }],
    )
  })

  test("OpenAI chat: tool calls on the assistant message, results as role tool, reasoning fields", () => {
    expect(
      pieces({
        role: "assistant",
        content: "",
        reasoning_content: "Think.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      }),
    ).toEqual([
      { kind: "reasoning", text: "Think." },
      { kind: "tool-call", name: "bash", id: "call_1", args: '{"command":"ls"}' },
    ])
    expect(pieces({ role: "tool", tool_call_id: "call_2", content: "task_id: ses_abc123 (for resuming)" })).toEqual([
      { kind: "tool-result", id: "call_2", text: "task_id: ses_abc123 (for resuming)", subagent: "ses_abc123" },
    ])
  })

  test("OpenAI responses items and Google parts", () => {
    expect(pieces({ type: "function_call", call_id: "c1", name: "glob", arguments: "{}" })).toEqual([
      { kind: "tool-call", name: "glob", id: "c1", args: "{}" },
    ])
    expect(pieces({ type: "reasoning", summary: [], encrypted_content: "xyz" })).toEqual([
      { kind: "reasoning", text: "", encrypted: true },
    ])
    expect(
      pieces({ role: "model", parts: [{ text: "Hi" }, { functionCall: { name: "grep", args: { pattern: "x" } } }] }),
    ).toEqual([
      { kind: "text", text: "Hi" },
      { kind: "tool-call", name: "grep", args: '{"pattern":"x"}' },
    ])
  })

  test("attachments are placeholders", () => {
    expect(
      pieces({ role: "user", content: [{ type: "image", source: { media_type: "image/png", data: "AAAA" } }] }),
    ).toEqual([{ kind: "attachment", type: "image", mime: "image/png", size: 3 }])
  })
})

describe("folding and diffs", () => {
  test("messages sent before fold into runs", () => {
    expect(runs([{ index: 1, seenIn: 1 }, { index: 2, seenIn: 2 }, { index: 3 }, { index: 4, seenIn: 3 }])).toEqual([
      { seen: { from: 1, to: 2, call: 2 } },
      { message: { index: 3 } },
      { seen: { from: 4, to: 4, call: 3 } },
    ])
  })
  test("a changed text shows the lines that went and came", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { change: "removed", text: "b" },
      { change: "added", text: "B" },
    ])
  })
  test("the subagent session in task's result", () => {
    expect(subagentOf("done\ntask_id: ses_9Zx (to resume)")).toBe("ses_9Zx")
    expect(subagentOf("no session")).toBeUndefined()
  })
})
