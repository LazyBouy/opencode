import { describe, expect, test } from "bun:test"
import { accessOf, compareNames, lastTools, type RuleRow } from "./tool-prompt-model"

const rule = (index: number, pattern: string, action: RuleRow["action"], permission = "read"): RuleRow => ({
  index,
  permission,
  pattern,
  action,
})

describe("what a tool's rules allow", () => {
  test("OpenCode's read defaults: allowed, asks for .env files, allows the example", () => {
    expect(
      accessOf([
        rule(1, "*", "allow", "*"),
        rule(2, "*", "allow"),
        rule(3, "*.env", "ask"),
        rule(4, "*.env.*", "ask"),
        rule(5, "*.env.example", "allow"),
      ]),
    ).toEqual({
      every: "allow",
      exceptions: [
        { action: "ask", patterns: ["*.env", "*.env.*"] },
        { action: "allow", patterns: ["*.env.example"] },
      ],
    })
  })

  test("a later * rule overrides the earlier ones", () => {
    expect(accessOf([rule(1, "*.env", "ask"), rule(2, "*", "allow")])).toEqual({ every: "allow", exceptions: [] })
  })

  test("no * rule: OpenCode asks", () => {
    expect(accessOf([rule(1, "~/*", "allow")])).toEqual({
      every: "ask",
      exceptions: [{ action: "allow", patterns: ["~/*"] }],
    })
  })

  test("an exception with the same action as every call says nothing", () => {
    expect(accessOf([rule(1, "*", "allow"), rule(2, "src/*", "allow")])).toEqual({ every: "allow", exceptions: [] })
  })
})

describe("the tools of a recorded request", () => {
  const entry = { name: "read", description: "Reads", input_schema: { type: "object" } }
  test("Anthropic and OpenAI responses", () => {
    expect(lastTools(JSON.stringify([entry])).map((item) => item.name)).toEqual(["read"])
  })
  test("OpenAI chat", () => {
    const chat = { type: "function", function: { name: "bash", description: "Runs", parameters: {} } }
    const found = lastTools(JSON.stringify([chat]))
    expect(found.map((item) => item.name)).toEqual(["bash"])
    expect(found[0]!.chars).toBe(JSON.stringify(chat).length)
  })
  test("Google", () => {
    const google = { functionDeclarations: [{ name: "glob" }, { name: "grep" }] }
    expect(lastTools(JSON.stringify([google])).map((item) => item.name)).toEqual(["glob", "grep"])
  })
  test("not a list, or not JSON", () => {
    expect(lastTools("{}")).toEqual([])
    expect(lastTools("nope")).toEqual([])
    expect(lastTools(undefined)).toEqual([])
  })
  test("compared with the list that would be sent", () => {
    expect(compareNames(["read", "task"], ["read", "webfetch"])).toEqual({
      onlyWould: ["task"],
      onlyLast: ["webfetch"],
    })
  })
})
