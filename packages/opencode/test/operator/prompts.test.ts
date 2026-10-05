import { describe, expect, test } from "bun:test"
import { OperatorPromptText } from "@/operator/prompt-text"

describe("prompt texts", () => {
  test("reminders are replaced, keep text added after them, and can be turned off", () => {
    const plan = OperatorPromptText.BUILTINS.find((item) => item.id === "reminder.build-switch")!.text
    const overrides = new Map([["reminder.build-switch", "Now build it."]])
    expect(OperatorPromptText.rewriteReminder(`${plan}\n\nA plan file exists at /p.md`, overrides)).toBe(
      "Now build it.\n\nA plan file exists at /p.md",
    )
    expect(OperatorPromptText.rewriteReminder("unrelated text", overrides)).toBe("unrelated text")
    const off = new Map([["reminder.build-switch", ""]])
    expect(OperatorPromptText.rewriteReminder(plan, off)).toBe("")
  })

  test("the plan-mode reminder keeps its plan file line in an override", () => {
    const template = OperatorPromptText.BUILTINS.find((item) => item.id === "reminder.plan-mode")!.text
    const sent = template.replace("${planInfo}", () => "No plan file exists yet. Create it at /p.md.")
    const overrides = new Map([["reminder.plan-mode", "Plan only.\n${planInfo}\nThen stop."]])
    expect(OperatorPromptText.rewriteReminder(sent, overrides)).toBe(
      "Plan only.\nNo plan file exists yet. Create it at /p.md.\nThen stop.",
    )
    expect(OperatorPromptText.rewriteReminder(sent, new Map())).toBe(sent)
    expect(OperatorPromptText.matchTemplate("a ${x} b", "a 1 2 b c")).toEqual({ values: { x: "1 2" }, length: 7 })
  })
})
