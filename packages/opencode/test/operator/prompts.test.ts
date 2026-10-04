import { describe, expect, test } from "bun:test"
import { OperatorPromptText } from "@/operator/prompt-text"

const model = { providerID: "test", api: { id: "test-model" } }
const on = { environment: true, skills: true, mcp: true }
const DEFAULT_BASE = OperatorPromptText.BUILTINS.find((item) => item.id === "base.default")!.text

const assembled = [
  DEFAULT_BASE,
  "You are powered by the model named test-model. The exact model ID is test/test-model",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /work",
  "</env>",
  "Instructions from: /work/AGENTS.md",
  "Use Bun.",
  "<mcp_instructions>",
  '  <server name="docs">',
  "    Search first.",
  "  </server>",
  "</mcp_instructions>",
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <name>release</name>",
  "  </skill>",
  "</available_skills>",
].join("\n")

describe("prompt rewriting", () => {
  test("a model family's override replaces its base prompt, and the all-models override is the fallback", () => {
    const family = new Map([["base.default", { scope: "project" as const, text: "You are a test assistant." }]])
    expect(OperatorPromptText.rewriteSystem(assembled, { model, overrides: family, toggles: on })).toStartWith(
      "You are a test assistant.\nYou are powered by",
    )
    const all = new Map([["base", { scope: "global" as const, text: "Be helpful." }]])
    expect(OperatorPromptText.rewriteSystem(assembled, { model, overrides: all, toggles: on })).toStartWith(
      "Be helpful.\n",
    )
  })

  test("switched-off sections are removed and everything else is kept", () => {
    const result = OperatorPromptText.rewriteSystem(assembled, {
      model,
      overrides: new Map(),
      toggles: { environment: false, skills: false, mcp: false },
    })
    expect(result).not.toContain("<env>")
    expect(result).not.toContain("You are powered by")
    expect(result).not.toContain("available_skills")
    expect(result).not.toContain("mcp_instructions")
    expect(result).toContain("Instructions from: /work/AGENTS.md\nUse Bun.")
    expect(result).toStartWith(DEFAULT_BASE.trim())
  })

  test("an empty base override removes the base prompt", () => {
    const off = new Map([["base.default", { scope: "project" as const, text: "" }]])
    expect(OperatorPromptText.rewriteSystem(assembled, { model, overrides: off, toggles: on })).toStartWith(
      "You are powered by",
    )
  })

  test("reminders are replaced, keep text added after them, and can be turned off", () => {
    const plan = OperatorPromptText.BUILTINS.find((item) => item.id === "reminder.build-switch")!.text
    const overrides = new Map([["reminder.build-switch", { scope: "global" as const, text: "Now build it." }]])
    expect(OperatorPromptText.rewriteReminder(`${plan}\n\nA plan file exists at /p.md`, overrides)).toBe(
      "Now build it.\n\nA plan file exists at /p.md",
    )
    expect(OperatorPromptText.rewriteReminder("unrelated text", overrides)).toBe("unrelated text")
    const off = new Map([["reminder.build-switch", { scope: "global" as const, text: "" }]])
    expect(OperatorPromptText.rewriteReminder(plan, off)).toBe("")
  })

  test("the plan-mode reminder keeps its plan file line in an override", () => {
    const template = OperatorPromptText.BUILTINS.find((item) => item.id === "reminder.plan-mode")!.text
    const sent = template.replace("${planInfo}", () => "No plan file exists yet. Create it at /p.md.")
    const overrides = new Map([
      ["reminder.plan-mode", { scope: "project" as const, text: "Plan only.\n${planInfo}\nThen stop." }],
    ])
    expect(OperatorPromptText.rewriteReminder(sent, overrides)).toBe(
      "Plan only.\nNo plan file exists yet. Create it at /p.md.\nThen stop.",
    )
    expect(OperatorPromptText.rewriteReminder(sent, new Map())).toBe(sent)
    expect(OperatorPromptText.matchTemplate("a ${x} b", "a 1 2 b c")).toEqual({ values: { x: "1 2" }, length: 7 })
  })

  test("switches default to on", () => {
    expect(OperatorPromptText.toggles({})).toEqual(on)
    expect(OperatorPromptText.toggles({ prompts: { skills: false } })).toEqual({ ...on, skills: false })
  })
})
