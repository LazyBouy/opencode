import { describe, expect, test } from "bun:test"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { OperatorPermissionModel as Model } from "@/operator/permission-model"

// Permission levels (tool_prompt_from_permission.md §3, with the rules the user set on 2026-10-08 and
// 2026-10-10): tool first, then the most specific line decides; a lower level's same line replaces the
// inherited one; at one level a partial overlap goes to the stricter action, across levels to the lower
// level; a lock binds the levels below, and inside it tool first doesn't apply; no line means deny.

const OPENCODE = 0
const GLOBAL = 1
const NAMESPACE = 2
const PROJECT = 3
const AGENT = 4
const SESSION = 5

type Action = Model.Action
const line = (permission: string, pattern: string, action: Action) => ({ permission, pattern, action })
const levels = (byLevel: Record<number, Array<Model.Rule>>, extra: Record<number, Partial<Model.Level>> = {}) =>
  Model.build(Array.from({ length: 6 }, (_, index) => ({ lines: byLevel[index] ?? [], ...extra[index] }))).lines

// A small seeded generator, so a failure reproduces.
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const pick = <T>(next: () => number, list: ReadonlyArray<T>) => list[Math.floor(next() * list.length)]!
const PARTS = ["a", "b", " ", "*", "?", "ab", " *"]
const patternOf = (next: () => number) =>
  Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(next, PARTS)).join("")
function* strings(chars: ReadonlyArray<string>, length: number): Generator<string> {
  yield ""
  if (length === 0) return
  for (const shorter of strings(chars, length - 1))
    if (shorter.length === length - 1) for (const char of chars) yield shorter + char
}
const EVERY = [...strings(["a", "b", " ", "x"], 5)]

describe("the user's examples", () => {
  test("the most specific line decides, across levels", () => {
    const lines = levels({
      [GLOBAL]: [line("*", "*", "ask"), line("bash", "git *", "allow")],
      [PROJECT]: [line("bash", "ls *", "allow")],
      [AGENT]: [line("bash", "*", "ask")],
    })
    expect(Model.decide(lines, "bash", "git push").action).toBe("allow")
    expect(Model.decide(lines, "bash", "ls -la").action).toBe("allow")
    expect(Model.decide(lines, "bash", "cat a").action).toBe("ask")
    expect(Model.decide(lines, "read", "a.ts").action).toBe("ask")
  })

  test("the order lines are written in doesn't matter", () => {
    for (const order of [
      [line("bash", "git *", "allow"), line("bash", "*", "deny")],
      [line("bash", "*", "deny"), line("bash", "git *", "allow")],
    ]) {
      const lines = levels({ [NAMESPACE]: [line("*", "*", "deny")], [PROJECT]: order })
      expect(Model.decide(lines, "bash", "git status").action).toBe("allow")
      expect(Model.decide(lines, "bash", "ls").action).toBe("deny")
      expect(Model.decide(lines, "read", "a").action).toBe("deny")
    }
  })

  test("a partial overlap at one level goes to the stricter action; across levels to the lower level", () => {
    const same = levels({ [PROJECT]: [line("bash", "git *", "allow"), line("bash", "* --force", "deny")] })
    expect(Model.decide(same, "bash", "git push --force").action).toBe("deny")
    expect(Model.decide(same, "bash", "git push").action).toBe("allow")
    const across = levels({ [PROJECT]: [line("bash", "* --force", "deny")], [AGENT]: [line("bash", "git *", "allow")] })
    expect(Model.decide(across, "bash", "git push --force").action).toBe("allow")
  })

  test("a lower level's same line replaces the inherited one; a level can delete one", () => {
    const replaced = levels({ [GLOBAL]: [line("*", "*", "ask")], [PROJECT]: [line("*", "*", "allow")] })
    expect(replaced).toHaveLength(1)
    expect(Model.decide(replaced, "bash", "x").action).toBe("allow")
    const deleted = levels(
      { [OPENCODE]: [line("*", "*", "allow")], [NAMESPACE]: [line("read", "*", "allow")] },
      { [NAMESPACE]: { deleted: [{ permission: "*", pattern: "*" }] } },
    )
    expect(Model.decide(deleted, "read", "a").action).toBe("allow")
    // No line: deny.
    expect(Model.decide(deleted, "bash", "ls").action).toBe("deny")
  })

  test("a lock binds every level below the one that set it", () => {
    const lines = levels(
      {
        [NAMESPACE]: [line("bash", "rm *", "deny"), line("*", "*", "deny")],
        [PROJECT]: [line("bash", "*", "allow"), line("bash", "rm -i *", "allow")],
        [SESSION]: [line("bash", "rm *", "allow")],
      },
      { [NAMESPACE]: { locks: [{ permission: "bash", pattern: "rm *" }] } },
    )
    expect(Model.decide(lines, "bash", "ls").action).toBe("allow")
    const rm = Model.decide(lines, "bash", "rm -i a")
    expect(rm.action).toBe("deny")
    expect(rm.lock).toMatchObject({ pattern: "rm *", lockedAt: NAMESPACE })
    // The session's same line is set aside: the lock above it.
    const built = Model.build(
      [NAMESPACE, SESSION].reduce<Model.Level[]>(
        (list, level) => {
          list[level] =
            level === NAMESPACE
              ? { lines: [line("bash", "rm *", "deny")], locks: [{ permission: "bash", pattern: "rm *" }] }
              : { lines: [line("bash", "rm *", "allow")] }
          return list
        },
        Array.from({ length: 6 }, () => ({ lines: [] })),
      ),
    )
    expect(built.blocked).toEqual([
      expect.objectContaining({ level: SESSION, kind: "line", key: expect.objectContaining({ pattern: "rm *" }) }),
    ])
    // A level's own more specific line inside its own lock still decides.
    const own = levels(
      {
        [NAMESPACE]: [line("bash", "*", "deny"), line("bash", "git *", "allow")],
        [PROJECT]: [line("bash", "ls", "allow")],
      },
      { [NAMESPACE]: { locks: [{ permission: "bash", pattern: "*" }] } },
    )
    expect(Model.decide(own, "bash", "git log").action).toBe("allow")
    expect(Model.decide(own, "bash", "ls").action).toBe("deny")
  })

  test("tool first: the lines for the tool decide before the lines for every tool, at any level", () => {
    // The user's examples (2026-10-10). One level:
    const env = levels({ [PROJECT]: [line("read", "*", "allow"), line("*", "*.env", "deny")] })
    expect(Model.decide(env, "read", "/x/.env").action).toBe("allow")
    // The `*` line still decides the tools that have no line of their own.
    expect(Model.decide(env, "edit", "/x/.env").action).toBe("deny")
    const git = levels({ [PROJECT]: [line("bash", "*", "allow"), line("*", "git *", "deny")] })
    expect(Model.decide(git, "bash", "git status").action).toBe("allow")
    // Across levels: OpenCode's own `read *` decides read; a `read` line is how to stop it.
    const secret = levels({
      [OPENCODE]: [line("*", "*", "allow"), line("read", "*", "allow")],
      [PROJECT]: [line("*", "/p/secret/*", "deny")],
    })
    expect(Model.decide(secret, "read", "/p/secret/k").action).toBe("allow")
    expect(Model.decide(secret, "edit", "/p/secret/k").action).toBe("deny")
    const stopped = levels({
      [OPENCODE]: [line("*", "*", "allow"), line("read", "*", "allow")],
      [PROJECT]: [line("*", "/p/secret/*", "deny"), line("read", "/p/secret/*", "deny")],
    })
    expect(Model.decide(stopped, "read", "/p/secret/k").action).toBe("deny")
    // Tool names with wildcards: the narrower name first.
    const mcp = levels({ [PROJECT]: [line("mcp_github_*", "*", "allow")], [AGENT]: [line("mcp_*", "*", "deny")] })
    expect(Model.decide(mcp, "mcp_github_search", "x").action).toBe("allow")
    expect(Model.decide(mcp, "mcp_slack_post", "x").action).toBe("deny")
    // Reachability follows the same rule: read can be allowed for .env files.
    const found = Model.reach(env, "read")
    expect(found.live.find((item) => item.example.endsWith(".env"))?.action ?? "allow").toBe("allow")
    expect(found.live.every((item) => item.action === "allow")).toBe(true)
  })

  test("locks hold: a locked line decides unless a line at or above it is more specific in tool and pattern", () => {
    const lines = levels(
      {
        [OPENCODE]: [line("*", "*", "allow"), line("read", "*", "allow"), line("read", "*.env", "ask")],
        [NAMESPACE]: [line("*", "/p/secret/*", "deny"), line("read", "/p/secret/public/*", "allow")],
        [PROJECT]: [line("read", "/p/secret/*", "allow")],
      },
      { [NAMESPACE]: { locks: [{ permission: "*", pattern: "/p/secret/*" }] } },
    )
    // The user's example D: OpenCode's `read *` doesn't undo the namespace's locked line.
    const denied = Model.decide(lines, "read", "/p/secret/k")
    expect(denied.action).toBe("deny")
    expect(denied.lock).toMatchObject({ pattern: "/p/secret/*", lockedAt: NAMESPACE })
    expect(Model.decide(lines, "read", "/p/secret/k.env").action).toBe("deny")
    // A line at the lock's level, more specific in both, still decides inside it.
    expect(Model.decide(lines, "read", "/p/secret/public/a").action).toBe("allow")
    // Outside the lock, tool first.
    expect(Model.decide(lines, "read", "/p/open/a.env").action).toBe("ask")
  })

  test("a broader line below doesn't beat a more specific one above (an agent's read: deny)", () => {
    const lines = levels({
      [OPENCODE]: [line("*", "*", "allow"), line("read", "*", "allow"), line("read", "*.env", "ask")],
      [AGENT]: [line("read", "*", "deny")],
    })
    expect(Model.decide(lines, "read", "a.ts").action).toBe("deny")
    expect(Model.decide(lines, "read", "x.env").action).toBe("ask")
  })
})

describe("wildcard languages", () => {
  test("contains and intersects agree with Wildcard.match on every short text", () => {
    const next = random(3)
    for (let run = 0; run < 400; run++) {
      const a = patternOf(next)
      const b = patternOf(next)
      const inA = EVERY.filter((text) => Wildcard.match(text, a))
      const inB = new Set(EVERY.filter((text) => Wildcard.match(text, b)))
      // Contained: no text of b's misses a. Not contained: some text shows it, or a longer one does.
      if (Model.contains(a, b)) expect([...inB].every((text) => Wildcard.match(text, a))).toBe(true)
      if ([...inB].some((text) => !Wildcard.match(text, a))) expect(Model.contains(a, b)).toBe(false)
      if (inA.some((text) => inB.has(text))) expect(Model.intersects(a, b)).toBe(true)
      if (!Model.intersects(a, b)) expect(inA.some((text) => inB.has(text))).toBe(false)
    }
  })
})

describe("reachability and exact rules", () => {
  const randomLines = (next: () => number) =>
    levels(
      Object.fromEntries(
        [GLOBAL, PROJECT, AGENT].map((level) => [
          level,
          Array.from({ length: Math.floor(next() * 3) }, () =>
            line(pick(next, ["bash", "*"]), patternOf(next), pick(next, ["allow", "ask", "deny"] as const)),
          ),
        ]),
      ),
      next() < 0.3 ? { [GLOBAL]: { locks: [{ permission: "bash", pattern: "*" }] } } : {},
    )

  test("every decision reach finds is the decision for its example; unreachable means every text is denied", () => {
    const next = random(5)
    for (let run = 0; run < 300; run++) {
      const lines = randomLines(next)
      const found = Model.reach(lines, "bash")
      expect(found.complete).toBe(true)
      for (const item of found.live) expect(Model.decide(lines, "bash", item.example).action).toBe(item.action)
      if (!found.reachable) for (const text of EVERY) expect(Model.decide(lines, "bash", text).action).toBe("deny")
      if (EVERY.some((text) => Model.decide(lines, "bash", text).action !== "deny")) expect(found.reachable).toBe(true)
    }
  })

  test("the hook's exact rules give each input its decision under OpenCode's last-match check", () => {
    const next = random(9)
    const lastMatch = (rules: ReadonlyArray<Model.Rule>, input: string) =>
      rules.findLast((rule) => Wildcard.match(input, rule.pattern))?.action
    for (let run = 0; run < 300; run++) {
      const lines = randomLines(next)
      const inputs = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
        Array.from({ length: Math.floor(next() * 5) }, () => pick(next, ["a", "b", " ", "*", "?"])).join(""),
      )
      const rules = Model.exact(lines, "bash", inputs)
      for (const input of inputs) {
        // Inputs that match each other as patterns can't all be told apart; the stricter wins there.
        const clash = inputs.some(
          (other) => other !== input && Wildcard.match(input, other) && Wildcard.match(other, input),
        )
        if (!clash) expect(lastMatch(rules, input)).toBe(Model.decide(lines, "bash", input).action)
      }
    }
  })

  test("compile orders the usual lists so the last match is the decision", () => {
    const lines = levels({
      [OPENCODE]: [line("*", "*", "allow"), line("read", "*.env", "ask"), line("question", "*", "deny")],
      [GLOBAL]: [line("bash", "git *", "allow"), line("*", "*", "ask")],
      [PROJECT]: [line("bash", "ls *", "allow"), line("bash", "* --force", "deny")],
      [AGENT]: [line("bash", "*", "ask"), line("task", "explore", "deny")],
      [SESSION]: [line("bash", "git push *", "allow")],
    })
    const rules = Model.compile(lines)
    for (const [permission, input] of [
      ["bash", "git push x"],
      ["bash", "git push --force"],
      ["bash", "ls -la"],
      ["bash", "cat"],
      ["read", "x.env"],
      ["read", "x.ts"],
      ["question", "q"],
      ["task", "explore"],
      ["task", "general"],
    ] as const)
      expect(
        rules.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(input, rule.pattern))
          ?.action,
      ).toBe(Model.decide(lines, permission, input).action)
  })
})

describe("the allowed-only-for note", () => {
  const noteOf = (lines: ReturnType<typeof levels>, permission = "bash") =>
    Model.note(lines, Model.reach(lines, permission))

  test("bash allowed only for `git *` says so; with asks too", () => {
    expect(noteOf(levels({ [PROJECT]: [line("*", "*", "deny"), line("bash", "git *", "allow")] }))).toBe(
      "Allowed only for: `git *`. Other inputs are refused.",
    )
    expect(
      noteOf(
        levels({
          [PROJECT]: [line("bash", "*", "deny"), line("bash", "git *", "allow"), line("bash", "git push *", "ask")],
        }),
      ),
    ).toBe("Allowed only for: `git *`. Needs your approval for: `git push *`. Other inputs are refused.")
  })

  test("no note when nothing is refused, when a line allows everything else, or when it is long", () => {
    // OpenCode's defaults: nothing refused.
    expect(noteOf(levels({ [OPENCODE]: [line("*", "*", "allow"), line("read", "*.env", "ask")] }), "read")).toBe(
      undefined,
    )
    // Allowed except `rm *`: not "allowed only for".
    expect(noteOf(levels({ [OPENCODE]: [line("*", "*", "allow")], [AGENT]: [line("bash", "rm *", "deny")] }))).toBe(
      undefined,
    )
    // Six patterns: no note.
    const six = ["a *", "b *", "c *", "d *", "e *", "f *"].map((pattern) => line("bash", pattern, "allow"))
    expect(noteOf(levels({ [PROJECT]: [line("*", "*", "deny"), ...six] }))).toBe(undefined)
    // Nothing can be allowed: the tool isn't listed, so no note.
    expect(noteOf(levels({ [PROJECT]: [line("*", "*", "deny")] }))).toBe(undefined)
  })
})

describe("verbs", () => {
  test("memory with WRITE and FORGET denied keeps only READ; with every verb denied, none", () => {
    const lines = levels({
      [NAMESPACE]: [line("memory", "*", "ask")],
      [PROJECT]: [line("memory", "WRITE(*)", "deny"), line("memory", "FORGET(*)", "deny")],
    })
    expect(Model.verbs(lines, "memory", ["READ", "WRITE", "FORGET"])).toEqual(["READ"])
    const none = levels({
      [NAMESPACE]: [line("memory", "*", "allow")],
      [PROJECT]: [
        line("memory", "READ(*)", "deny"),
        line("memory", "WRITE(*)", "deny"),
        line("memory", "FORGET(*)", "deny"),
      ],
    })
    expect(Model.verbs(none, "memory", ["READ", "WRITE", "FORGET"])).toEqual([])
    // The permission alone still has inputs no verb covers: verbs decide whether the tool is listed.
    expect(Model.reach(none, "memory").reachable).toBe(true)
    // A verb allowed only for one target is still a verb that can be allowed.
    const project = levels({
      [NAMESPACE]: [line("memory", "*", "deny"), line("memory", "READ(project/*)", "ask")],
    })
    expect(Model.verbs(project, "memory", ["READ", "WRITE"])).toEqual(["READ"])
  })
})
