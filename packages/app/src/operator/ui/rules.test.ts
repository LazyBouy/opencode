import { describe, expect, test } from "bun:test"
import { hintOf, orderCheck, type Rule, rulesFromConfig, rulesToConfig } from "./rules"

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

  test("a repeated permission and pattern keeps the later rule, after the rules in between", () => {
    const config = rulesToConfig([
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*.env", action: "deny" },
      { permission: "read", pattern: "*", action: "ask" },
    ])
    expect(config).toEqual({ read: { "*.env": "deny", "*": "ask" } })
    expect(Object.keys(config.read as object)).toEqual(["*.env", "*"])
  })
})

const rule = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action })

describe("saving rules in order", () => {
  test("a pair written twice is caught", () => {
    expect(
      orderCheck([rule("read", "*", "allow"), rule("bash", "*", "ask"), rule("read", "*", "deny")]).duplicates,
    ).toEqual([{ earlier: 0, later: 2 }])
  })

  test("grouping by permission that changes a result is caught", () => {
    // `* * allow` between two read rules: saved grouped, read's rules come together before it.
    const check = orderCheck([rule("read", "*", "deny"), rule("*", "*", "allow"), rule("read", "*.md", "deny")])
    expect(check.changed).toEqual([1, 2])
    expect(check.saved.map((item) => `${item.permission} ${item.pattern}`)).toEqual(["read *", "read *.md", "* *"])
  })

  test("grouping that changes nothing is not", () => {
    expect(
      orderCheck([rule("read", "*", "allow"), rule("bash", "*", "ask"), rule("read", "*.env", "deny")]).changed,
    ).toEqual([])
  })
})

describe("rule hints", () => {
  const forms = { read: "path", edit: "path", external_directory: "absolute", todowrite: "any" }
  test("an absolute pattern on read matches no file in the project", () => {
    expect(hintOf(rule("read", "~/*", "allow"), forms)).toBe("absolute")
    expect(hintOf(rule("edit", "/root/docs/*", "allow"), forms)).toBe("absolute")
    expect(hintOf(rule("read", "src/*", "allow"), forms)).toBeUndefined()
  })
  test("a relative folder on external_directory, and a pattern on a permission asked with *", () => {
    expect(hintOf(rule("external_directory", "docs/*", "allow"), forms)).toBe("relative")
    expect(hintOf(rule("external_directory", "/tmp/*", "allow"), forms)).toBeUndefined()
    expect(hintOf(rule("todowrite", "x", "deny"), forms)).toBe("any")
    expect(hintOf(rule("todowrite", "*", "deny"), forms)).toBeUndefined()
    expect(hintOf(rule("bash", "/usr/bin/*", "allow"), forms)).toBeUndefined()
  })
})
