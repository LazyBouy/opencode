import { describe, expect, test } from "bun:test"
import { rulesFromConfig, rulesToConfig } from "./rules"

describe("permission rules", () => {
  test("reads plain actions and pattern maps in order", () => {
    expect(rulesFromConfig({ edit: "ask", bash: { "*": "deny", "git status": "allow" }, bad: 3 })).toEqual([
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "git status", action: "allow" },
    ])
    expect(rulesFromConfig(undefined)).toEqual([])
  })

  test("writes a lone * rule as a plain action and the rest as pattern maps", () => {
    expect(
      rulesToConfig([
        { permission: "edit", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "bash", pattern: " git status ", action: "allow" },
        { permission: " ", pattern: "*", action: "allow" },
        { permission: "read", pattern: "", action: "allow" },
      ]),
    ).toEqual({ edit: "ask", bash: { "*": "deny", "git status": "allow" }, read: "allow" })
  })

  test("round-trips", () => {
    const config = { edit: { "*": "deny", "docs/**": "allow" }, webfetch: "ask" } as const
    expect(rulesToConfig(rulesFromConfig(config))).toEqual(config)
  })
})
