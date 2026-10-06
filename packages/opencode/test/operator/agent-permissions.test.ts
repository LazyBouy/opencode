import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import matter from "gray-matter"
import { parse } from "jsonc-parser"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Permission } from "@/permission"
import { OperatorAgentPermissions } from "@/operator/agent-permissions"
import { OperatorPermissionRules } from "@/operator/permission-rules"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([root, OperatorAgentPermissions.node, OperatorToolPrompt.node, OperatorPermissionRules.node]),
    replacements,
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const failure = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)
const rule = (permission: string, pattern: string, action: "allow" | "ask" | "deny") => ({
  permission,
  pattern,
  action,
})
const json = (file: string) => Effect.promise(async () => parse(await fs.readFile(file, "utf8")) as Record<string, any>)

unix("build's editor shows the full list with every rule's origin, and its own rules as the editable part", () =>
  Effect.gen(function* () {
    yield* configure({ tools: { webfetch: false }, permission: { bash: { "git *": "allow" } } })
    const permissions = yield* OperatorAgentPermissions.Service
    const info = yield* permissions.get("build")
    const kinds = info.rows.map((row) => row.from.kind)
    // OpenCode's defaults, then build's own definition, then config, then the truncation folder.
    expect(kinds[0]).toBe("opencode-default")
    expect(kinds).toContain("opencode-agent")
    expect(info.rows.find((row) => row.permission === "question" && row.action === "allow")?.from).toEqual({
      kind: "opencode-agent",
      agent: "build",
    })
    expect(info.rows.find((row) => row.permission === "bash" && row.pattern === "git *")?.from.kind).toBe(
      "config-permission",
    )
    expect(info.rows.find((row) => row.permission === "webfetch" && row.action === "deny")?.from.kind).toBe(
      "config-tools",
    )
    expect(info.rows.at(-1)?.from.kind).toBe("truncation")
    // build has no rules of its own yet: the editable part is empty, just before the truncation rule.
    expect(info.own).toEqual({ start: info.rows.length - 1, end: info.rows.length - 1 })
    expect(info.written).toEqual([])
    expect(info.targets.project.kind).toBe("config")
    expect(info.forms.read).toBe("path")
    expect(info.known).toEqual(expect.arrayContaining(["*", "bash", "edit", "read", "task", "webfetch"]))
  }),
)

unix("saving writes only the agent's own rules, in order, replacing the earlier ones", () =>
  Effect.gen(function* () {
    yield* configure()
    const permissions = yield* OperatorAgentPermissions.Service
    const first = yield* permissions.save({
      agent: "build",
      scope: "project",
      rules: [rule("webfetch", "*", "deny"), rule("read", "~/*", "allow"), rule("read", "*.secret", "deny")],
    })
    const written = (yield* json(first.path)).agent.build.permission
    expect(written).toEqual({ webfetch: "deny", read: { "~/*": "allow", "*.secret": "deny" } })
    expect(Object.keys(written.read)).toEqual(["~/*", "*.secret"])

    // A second save replaces the rules: webfetch's rule goes, and read's keys take the new order.
    const second = yield* permissions.save({
      agent: "build",
      scope: "project",
      rules: [rule("read", "*.secret", "deny"), rule("read", "~/*", "allow")],
    })
    const replaced = (yield* json(second.path)).agent.build.permission
    expect(replaced).toEqual({ read: { "*.secret": "deny", "~/*": "allow" } })
    expect(Object.keys(replaced.read)).toEqual(["*.secret", "~/*"])

    // No rules: the setting goes.
    yield* permissions.save({ agent: "build", scope: "project", rules: [] })
    expect((yield* json(second.path)).agent.build.permission).toBeUndefined()
  }),
)

unix("a pair written twice is refused, and so is an order grouping would change, unless confirmed", () =>
  Effect.gen(function* () {
    yield* configure()
    const permissions = yield* OperatorAgentPermissions.Service
    const twice = yield* Effect.exit(
      permissions.save({
        agent: "build",
        scope: "project",
        rules: [rule("read", "*", "allow"), rule("read", "*", "deny")],
      }),
    )
    expect(String(failure(twice))).toContain("the later one replaces the earlier one")

    const reordered = [rule("read", "*", "deny"), rule("*", "*", "allow"), rule("read", "*.md", "deny")]
    const refused = yield* Effect.exit(permissions.save({ agent: "build", scope: "project", rules: reordered }))
    expect(String(failure(refused))).toContain("grouped by permission")
    const saved = yield* permissions.save({ agent: "build", scope: "project", rules: reordered, confirmOrder: true })
    expect(Permission.fromConfig((yield* json(saved.path)).agent.build.permission)).toEqual([
      rule("read", "*", "deny"),
      rule("read", "*.md", "deny"),
      rule("*", "*", "allow"),
    ])
  }),
)

unix("an agent file's rules are written in its frontmatter, the rest of the file kept", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const file = path.join(directory, ".opencode", "agents", "docs.md")
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        "---\ndescription: Writes docs\nmode: subagent\npermission:\n  edit: deny\n  bash: ask\n---\nWrite clear docs.\n",
      )
    })
    yield* configure()
    const permissions = yield* OperatorAgentPermissions.Service
    const info = yield* permissions.get("docs")
    expect(info.targets.project).toMatchObject({ path: file, kind: "file" })
    expect(info.written).toEqual([rule("edit", "*", "deny"), rule("bash", "*", "ask")])
    expect(info.rows.slice(info.own.start, info.own.end).map((row) => row.from)).toEqual([
      { kind: "agent", path: file },
      { kind: "agent", path: file },
    ])
    yield* permissions.save({ agent: "docs", scope: "project", rules: [rule("bash", "*", "ask")] })
    const written = yield* Effect.promise(async () => matter(await fs.readFile(file, "utf8")))
    expect(written.data).toEqual({ description: "Writes docs", mode: "subagent", permission: { bash: "ask" } })
    expect(written.content.trim()).toBe("Write clear docs.")
  }),
)

unix("a draft is labelled and checked as saving would write it", () =>
  Effect.gen(function* () {
    yield* configure()
    const rules = yield* OperatorPermissionRules.Service
    const labelled = yield* rules.agent("build", [
      rule("read", "*", "deny"),
      rule("*", "*", "allow"),
      rule("read", "*.md", "deny"),
    ])
    expect(
      labelled.rows.slice(labelled.own.start, labelled.own.end).map((row) => `${row.permission} ${row.pattern}`),
    ).toEqual(["read *", "read *.md", "* *"])
    // The tool prompt with a draft that only changes a pattern: nothing changes.
    const prompts = yield* OperatorToolPrompt.Service
    const same = yield* prompts.draft({ agent: "build", agentRules: [rule("read", "src/*", "allow")] })
    expect(same.diff.added).toEqual([])
    expect(same.diff.removed).toEqual([])
    expect(same.diff.after).toBe(same.diff.before)
    const denied = yield* prompts.draft({ agent: "build", agentRules: [rule("webfetch", "*", "deny")] })
    expect(denied.diff.removed.map((item) => item.name)).toEqual(["webfetch"])
  }),
)

unix("toConfig keeps the later of a repeated pair, after the rules in between", () =>
  Effect.sync(() => {
    const config = OperatorPermissionRules.toConfig([
      rule("read", "*", "allow"),
      rule("read", "*.env", "deny"),
      rule("read", "*", "ask"),
    ])
    expect(config).toEqual({ read: { "*.env": "deny", "*": "ask" } })
    expect(Object.keys(config.read as object)).toEqual(["*.env", "*"])
    expect(
      OperatorPermissionRules.orderCheck([rule("read", "*", "allow"), rule("read", "*", "deny")]).duplicates,
    ).toEqual([{ earlier: 0, later: 1 }])
  }),
)
