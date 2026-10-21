import { describe, expect, test } from "bun:test"
import { OperatorHookResolve as Resolve } from "../../../src/operator/hooks/resolve"

// SPEC-0022 §6.3: every level's hooks run, the highest first and then as written; a lower level replaces one
// by name and turns one off, unless it's locked; an invalid entry is kept with its problems and never runs.

const source = (level: Resolve.Level, hooks: Record<string, unknown>, disabled: string[] = []): Resolve.Source => ({
  level,
  file: `/${level}/opencode.jsonc`,
  base: `/${level}`,
  hooks,
  disabled,
})
const hook = (event: string, extra: Record<string, unknown> = {}) => ({ event, command: "hooks/a.sh", ...extra })
const names = (hooks: Resolve.Hook[]) => hooks.map((item) => `${item.level}:${item.name}:${item.state}`)

describe("hook levels", () => {
  test("highest level first, then as written; a relative script resolves against its file's folder", () => {
    const hooks = Resolve.resolve([
      source("project", { p1: hook("tool.before"), p2: hook("tool.before") }),
      source("global", { g1: hook("tool.before") }),
      source("agent", { a1: hook("tool.before") }),
      source("namespace", { n1: hook("tool.before") }),
    ])
    expect(names(hooks)).toEqual(["global:g1:on", "namespace:n1:on", "project:p1:on", "project:p2:on", "agent:a1:on"])
    expect(hooks[0]!.command).toBe("/global/hooks/a.sh")
    expect(Resolve.forEvent(hooks, "tool.before", "bash").map((item) => item.name)).toEqual([
      "g1",
      "n1",
      "p1",
      "p2",
      "a1",
    ])
  })

  test("a lower level replaces a hook by name, and turns an inherited one off", () => {
    const hooks = Resolve.resolve([
      source("global", { guard: hook("tool.before"), notify: hook("turn.after") }),
      source("project", { guard: hook("tool.before", { command: "/x/mine.sh" }) }, ["notify"]),
    ])
    const guard = hooks.find((item) => item.name === "guard")!
    expect([guard.level, guard.command, guard.replaces]).toEqual([
      "project",
      "/x/mine.sh",
      { level: "global", file: "/global/opencode.jsonc" },
    ])
    expect(hooks.find((item) => item.name === "notify")).toMatchObject({ state: "off", offAt: "project" })
    // An agent turns off what its project declares.
    const agent = Resolve.resolve([source("project", { lint: hook("tool.after") }), source("agent", {}, ["lint"])])
    expect(agent[0]).toMatchObject({ state: "off", offAt: "agent" })
  })

  test("a locked hook can't be replaced or turned off below: it keeps running and the conflict is listed", () => {
    const hooks = Resolve.resolve([
      source("namespace", { guard: hook("tool.before", { locked: true }) }),
      source("project", { guard: hook("tool.before", { command: "/other.sh" }) }, ["guard"]),
    ])
    expect(hooks).toHaveLength(1)
    expect(hooks[0]).toMatchObject({ level: "namespace", state: "on", locked: true })
    expect(hooks[0]!.problems).toEqual([
      "locked at namespace: project can't turn it off (/project/opencode.jsonc)",
      "locked at namespace: project can't replace it (/project/opencode.jsonc)",
    ])
  })

  test("an invalid entry is kept with its problems and never runs; disabled ones don't run either", () => {
    const hooks = Resolve.resolve([
      source("project", {
        nothing: { event: "tool.before" },
        unknown: hook("tool.middle"),
        stray: hook("turn.after", { match: ["bash"] }),
        slow: hook("tool.before", { timeout: 900 }),
        loose: hook("tool.before", { onFailure: "maybe" }),
        resting: hook("tool.before", { enabled: false }),
        odd: "a string",
      }),
    ])
    const problems = Object.fromEntries(hooks.map((item) => [item.name, item.problems]))
    expect(problems).toEqual({
      nothing: ["no command"],
      unknown: ["unknown event tool.middle"],
      stray: ["match doesn't apply to turn.after"],
      slow: ["timeout must be 0.1 to 600 seconds"],
      loose: ["onFailure must be deny or allow"],
      resting: [],
      odd: ["not an object", "no event", "no command"],
    })
    expect(hooks.find((item) => item.name === "resting")!.state).toBe("disabled")
    expect(Resolve.forEvent(hooks, "tool.before", "bash")).toEqual([])
  })

  test("match: names and wildcards; no match list means every subject", () => {
    const hooks = Resolve.resolve([
      source("project", {
        any: hook("tool.before"),
        bash: hook("tool.before", { match: ["bash"] }),
        mcp: hook("tool.before", { match: ["github_*"] }),
      }),
    ])
    expect(Resolve.forEvent(hooks, "tool.before", "bash").map((item) => item.name)).toEqual(["any", "bash"])
    expect(Resolve.forEvent(hooks, "tool.before", "github_search").map((item) => item.name)).toEqual(["any", "mcp"])
    expect(Resolve.forEvent(hooks, "tool.after", "bash")).toEqual([])
  })
})
