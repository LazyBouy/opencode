import { describe, expect, test } from "bun:test"
import { insertAt, linesOf, mayOverlap } from "./permission-lines"
import type { Rule } from "./rules"

const rule = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action })
const defaults = [
  rule("*", "*", "allow"),
  rule("read", "*", "allow"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.example", "allow"),
]
const truncation = [rule("external_directory", "/tmp/tool-output/*", "allow")]
const view = (own: Rule[]) =>
  linesOf(defaults, own, truncation).map((line) => ({
    text: `${line.rule.permission} ${line.rule.pattern} ${line.rule.action}`,
    kind: line.kind,
    number: line.number,
    ...(line.replacedBy ? { replacedBy: line.replacedBy } : {}),
    ...(line.partly ? { partly: line.partly } : {}),
  }))

describe("permission lines", () => {
  test("without changes, every rule is a line in evaluation order", () => {
    expect(view([]).map((line) => [line.text, line.number])).toEqual([
      ["* * allow", 1],
      ["read * allow", 2],
      ["read *.env ask", 3],
      ["read *.env.example allow", 4],
      ["external_directory /tmp/tool-output/* allow", 5],
    ])
  })

  test("a change is shown on the line it changes, with its place in evaluation order", () => {
    const lines = view([rule("read", "*.env", "allow")])
    expect(lines).toHaveLength(5)
    expect(lines[2]).toEqual({ text: "read *.env allow", kind: "locked", number: 5 })
    expect(lines[3]).toEqual({ text: "read *.env.example allow", kind: "locked", number: 4 })
  })

  test("lines a change now decides instead are marked: always, or for some calls", () => {
    const lines = view([rule("read", "*", "deny")])
    expect(lines[1]).toEqual({ text: "read * deny", kind: "locked", number: 5 })
    // Checked before the change, with another action: the change decides every call they match.
    expect(lines[2]).toMatchObject({ text: "read *.env ask", replacedBy: 5 })
    expect(lines[3]).toMatchObject({ text: "read *.env.example allow", replacedBy: 5 })

    // A narrower change above a broader rule checked before it: the change decides the calls it matches.
    const config = [...defaults, rule("read", "*", "ask")]
    const partly = linesOf(config, [rule("read", "*.env", "deny")], [])
    expect(partly[2]).toMatchObject({ rule: { pattern: "*.env", action: "deny" }, number: 6 })
    expect(partly[4]).toMatchObject({ rule: { pattern: "*", action: "ask" }, number: 5, partly: [6] })
    // `*.env` and `*.env.example` never match the same file.
    expect(partly[3]).toEqual({ kind: "locked", row: config[3], rule: config[3], number: 4 })
  })

  test("patterns overlap when some text matches both", () => {
    expect(mayOverlap("*.env", "*.env.example")).toBe(false)
    expect(mayOverlap("*", "*.env")).toBe(true)
    expect(mayOverlap("src/*", "*.ts")).toBe(true)
    expect(mayOverlap("git *", "git")).toBe(true)
    expect(mayOverlap("git status", "npm *")).toBe(false)
    expect(mayOverlap("read", "edit")).toBe(false)
  })

  test("the agent's other rules are lines of their own; of a repeated pair only the last is a change", () => {
    const lines = view([rule("bash", "git *", "allow"), rule("read", "*.env", "deny"), rule("read", "*.env", "allow")])
    expect(lines[2]).toEqual({ text: "read *.env allow", kind: "locked", number: 7 })
    expect(lines.slice(4, 6)).toEqual([
      { text: "bash git * allow", kind: "own", number: 5 },
      { text: "read *.env deny", kind: "own", number: 6, replacedBy: 7 },
    ])
  })

  test("a new change goes after the agent's rules, before changes of lines further down", () => {
    const own = [rule("bash", "*", "ask"), rule("read", "*.env", "allow")]
    expect(insertAt(defaults, own, 1)).toBe(1)
    expect(insertAt(defaults, own, 3)).toBe(2)
    expect(insertAt(defaults, [], 2)).toBe(0)
  })
})
