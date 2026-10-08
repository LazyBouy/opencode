import { describe, expect, test } from "bun:test"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { OperatorPermissionReach as Reach } from "@/operator/permission-reach"

// Can a tool ever be allowed? (tool_prompt_from_permission.md §4): the automata agree with OpenCode's
// wildcard, and the reachability check agrees with OpenCode's decision on every input it can find.

const rule = (pattern: string, action: Reach.Action, permission = "bash"): Reach.Rule => ({
  permission,
  pattern,
  action,
})

// A small seeded generator, so a failure reproduces.
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const pick = <T>(next: () => number, list: ReadonlyArray<T>) => list[Math.floor(next() * list.length)]!

const PATTERN_PARTS = ["a", "b", " ", "/", "\\", "*", "?", "ab", "rm", " *"]
const TEXT_CHARS = ["a", "b", " ", "/", "\\", "r", "m", "x"]
const patternOf = (next: () => number) =>
  Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(next, PATTERN_PARTS)).join("")
const textOf = (next: () => number) =>
  Array.from({ length: Math.floor(next() * 7) }, () => pick(next, TEXT_CHARS)).join("")

// Every string up to `length` over `chars`.
function* strings(chars: ReadonlyArray<string>, length: number): Generator<string> {
  yield ""
  if (length === 0) return
  for (const shorter of strings(chars, length - 1))
    if (shorter.length === length - 1) for (const char of chars) yield shorter + char
}

describe("wildcard automata", () => {
  test("match exactly what Wildcard.match matches", () => {
    const next = random(7)
    for (let run = 0; run < 3000; run++) {
      const pattern = patternOf(next)
      const text = textOf(next)
      expect(Reach.matches(pattern, text)).toBe(Wildcard.match(text, pattern))
    }
  })

  test('a trailing " *" also matches without its tail', () => {
    for (const [pattern, text, expected] of [
      ["git *", "git", true],
      ["git *", "git push", true],
      ["git *", "gitx", false],
      ["git*", "gitx", true],
      ["*", "", true],
      ["a?c", "abc", true],
      ["a?c", "ac", false],
      ["a\\b", "a/b", true],
    ] as const) {
      expect(Reach.matches(pattern, text)).toBe(expected)
      expect(Wildcard.match(text, pattern)).toBe(expected)
    }
  })
})

describe("reachability", () => {
  test("the spec's examples", () => {
    expect(Reach.reach("bash", [rule("*", "allow"), rule("rm *", "deny")]).reachable).toBe(true)
    expect(Reach.reach("bash", [rule("*", "deny"), rule("rm *", "deny")]).reachable).toBe(false)
    expect(Reach.reach("bash", [rule("*", "deny"), rule("git *", "allow")]).reachable).toBe(true)
    expect(Reach.reach("bash", [rule("*", "allow"), rule("*", "deny")]).reachable).toBe(false)
    expect(Reach.reach("bash", [rule("*", "ask")]).reachable).toBe(true)
    // No rule at all: OpenCode asks.
    expect(Reach.reach("bash", []).reachable).toBe(true)
    // Rules for other permissions don't apply; a permission wildcard does.
    expect(Reach.reach("bash", [rule("*", "deny", "read")]).reachable).toBe(true)
    expect(Reach.reach("bash", [rule("*", "deny", "*")]).reachable).toBe(false)
    // A deny that leaves a gap: the gap asks.
    expect(Reach.reach("bash", [rule("rm *", "deny")]).reachable).toBe(true)
  })

  test("the live rules: which rules decide some input, with an input each one decides", () => {
    const rules = [rule("*", "deny"), rule("git *", "allow"), rule("git push *", "ask")]
    const found = Reach.reach("bash", rules)
    expect(found.live.map((item) => item.index)).toEqual([2, 1, 0])
    for (const item of found.live) expect(Reach.decide("bash", item.example, rules)).toBe(item.action)
    // `*` last shadows everything before it.
    expect(Reach.reach("bash", [rule("git *", "allow"), rule("*", "deny")]).live.map((item) => item.index)).toEqual([1])
  })

  test("agrees with OpenCode's decision on random rulesets", () => {
    const next = random(11)
    const chars = ["a", "b", " ", "r", "m", "x"]
    const every = [...strings(chars, 5)]
    for (let run = 0; run < 400; run++) {
      const rules = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
        rule(patternOf(next), pick(next, ["allow", "ask", "deny"] as const)),
      )
      const found = Reach.reach("bash", rules)
      // Every live rule's example is decided by that rule.
      for (const item of found.live) expect(Reach.decide("bash", item.example, rules)).toBe(item.action)
      // Not reachable: no input up to 5 characters gets allow or ask.
      if (!found.reachable) for (const text of every) expect(Reach.decide("bash", text, rules)).toBe("deny")
      // Some short input gets allow or ask: reachable.
      if (every.some((text) => Reach.decide("bash", text, rules) !== "deny")) expect(found.reachable).toBe(true)
    }
  })
})
