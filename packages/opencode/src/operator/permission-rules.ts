export * as OperatorPermissionRules from "./permission-rules"

import os from "os"
import fs from "fs/promises"
import matter from "gray-matter"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { OperatorAgents } from "./agents"
import { OperatorConfig } from "./config"

// Where each rule of an agent's (or a session's) permission list comes from. Rules are one ordered
// list, checked from the bottom up: the last rule that matches wins. An agent's list is built by
// OpenCode (agent/agent.ts) as: OpenCode's defaults; OpenCode's rules for that agent; config
// `permission` (with the legacy `tools` key turned into rules); the agent's own `permission`; and the
// truncation folder allow, added last. A session's own rules (session.permission) come after the
// agent's. The parts are worked out by matching what each part produces against the agent's list.

export const Origin = Schema.Struct({
  kind: Schema.Literals([
    "opencode-default",
    "opencode-agent",
    "config-permission",
    "config-tools",
    "agent",
    "truncation",
    "session-user",
    "session-always",
    "session-task",
    "session-client",
    "session-opencode",
  ]).annotate({
    description:
      "opencode-default / opencode-agent: OpenCode's code (its defaults, its definition of the agent); config-permission / config-tools: a config file's `permission` or legacy `tools` key; agent: the agent's own `permission` (its agent file or config entry); truncation: OpenCode's truncation folder allow; session-*: the session's own rules, set by you, by Always allow, added by `task` for a subagent, by a client's tool switch, or by OpenCode",
  }),
  path: Schema.optional(Schema.String).annotate({ description: "The file the rule is written in" }),
  agent: Schema.optional(Schema.String).annotate({ description: "opencode-agent: the agent whose definition it is" }),
  time: Schema.optional(Schema.Finite).annotate({ description: "Session rules: when it was added" }),
}).annotate({ identifier: "OperatorPermissionOrigin" })
export type Origin = typeof Origin.Type

export const Part = Schema.Literals(["opencode", "config", "agent", "truncation", "session"])
export type Part = typeof Part.Type

export const Row = Schema.Struct({
  index: Schema.Finite.annotate({ description: "1-based, in evaluation order" }),
  permission: Schema.String,
  pattern: Schema.String,
  action: Schema.Literals(["allow", "ask", "deny"]),
  part: Part,
  from: Origin,
}).annotate({ identifier: "OperatorPermissionRow" })
export type Row = typeof Row.Type

type Rule = PermissionV1.Rule

// The permission a tool is checked by: edit, write and apply_patch share `edit`; the MCP resource
// tools are `read` (as Permission.disabled maps them).
export function permissionOf(tool: string) {
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "edit"
  if (tool === "list_mcp_resources" || tool === "list_mcp_resource_templates" || tool === "read_mcp_resource")
    return "read"
  return tool
}

// The rules a subagent session gets when `task` starts it (tool/task.ts, agent/subagent-permissions.ts):
// the parent's deny and external-directory rules, then `todowrite` and `task` denies unless the agent's
// own rules mention them, then a deny for each `experimental.primary_tools`.
export function subagentRules(input: { agent: Agent.Info; parent?: PermissionV1.Ruleset; primaryTools?: string[] }) {
  const canTask = input.agent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.agent.permission.some((rule) => rule.permission === "todowrite")
  const derived: Rule[] = [
    ...(input.parent ?? []).filter((rule) => rule.permission === "external_directory" || rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task", pattern: "*", action: "deny" as const }]),
  ]
  const candidates: Rule[] = [
    { permission: "todowrite", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    ...(input.primaryTools ?? []).map((tool) => ({ permission: tool, pattern: "*", action: "deny" as const })),
  ]
  const denies = candidates.filter((rule) =>
    rule.permission === "todowrite" ? !canTodo : rule.permission === "task" ? !canTask : true,
  )
  return [
    ...derived,
    ...denies.filter(
      (rule) =>
        !derived.some(
          (item) => item.permission === rule.permission && item.pattern === rule.pattern && item.action === rule.action,
        ),
    ),
  ]
}

// Whether a session rule is one `task` adds to a subagent session.
export function isTaskRule(rule: Rule, primaryTools: string[] = []) {
  if (rule.pattern !== "*" || rule.action !== "deny") return rule.permission === "external_directory"
  return rule.permission === "todowrite" || rule.permission === "task" || primaryTools.includes(rule.permission)
}

const same = (a: Rule, b: Rule) => a.permission === b.permission && a.pattern === b.pattern && a.action === b.action

// OpenCode's `~` and `$HOME` expansion of config patterns (permission/index.ts).
function expand(pattern: string) {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

// Does this config `permission` value define this rule's pattern?
function defines(value: unknown, pattern: string) {
  if (typeof value === "string") return pattern === "*"
  if (!value || typeof value !== "object") return false
  return Object.keys(value).some((key) => expand(key) === pattern)
}

export type Labelled = { rows: Row[]; own: { start: number; end: number } }

export interface Interface {
  /** The agent's full list, labelled; `draft` replaces the agent's own rules (as saving would write them). */
  readonly agent: (agent: string, draft?: ReadonlyArray<Rule>) => Effect.Effect<Labelled>
  /** The agent's own rules as written (its file or config entry), and where they are written. */
  readonly own: (agent: string) => Effect.Effect<{ rules: Rule[]; path?: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionRules") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const operatorConfig = yield* OperatorConfig.Service
    const operatorAgents = yield* OperatorAgents.Service

    // The config sources that set `permission` or `tools`, parsed, in load order.
    const sources = Effect.fnUntraced(function* () {
      return (yield* operatorConfig.layers()).sources.flatMap((source) => {
        const value = parse(source.text) as Record<string, unknown> | undefined
        return value && typeof value === "object" ? [{ path: source.path, value }] : []
      })
    })

    // Where a config rule is written: the last source whose `permission` defines it, else whose legacy
    // `tools` switch produced it.
    const configOrigin = (
      rule: Rule,
      parsed: ReadonlyArray<{ path: string; value: Record<string, unknown> }>,
    ): Origin => {
      const permission = parsed.findLast((source) =>
        defines((source.value.permission as Record<string, unknown> | undefined)?.[rule.permission], rule.pattern),
      )
      if (permission) return { kind: "config-permission", path: permission.path }
      const keys = rule.permission === "edit" ? ["edit", "write", "patch"] : [rule.permission]
      const tools = parsed.findLast((source) => {
        const map = source.value.tools as Record<string, unknown> | undefined
        return !!map && keys.some((key) => key in map)
      })
      if (tools) return { kind: "config-tools", path: tools.path }
      if (process.env.OPENCODE_PERMISSION) return { kind: "config-permission", path: "OPENCODE_PERMISSION" }
      return { kind: "config-permission" }
    }

    // Where the agent's own `permission` is written: its agent file when that sets `permission` (or the
    // legacy `tools`), else the last config file with `agent.<name>.permission`.
    const ownPath = Effect.fnUntraced(function* (
      name: string,
      parsed: ReadonlyArray<{ path: string; value: Record<string, unknown> }>,
    ) {
      const file = (yield* operatorAgents.list()).find((item) => item.name === name)?.source.path
      const data = file
        ? yield* Effect.promise(() =>
            fs
              .readFile(file, "utf8")
              .then((text) => matter(text).data as Record<string, unknown>)
              .catch(() => undefined),
          )
        : undefined
      if (file && data && ("permission" in data || "tools" in data)) return file
      return parsed.findLast((source) => {
        const entry = (source.value.agent as Record<string, Record<string, unknown> | undefined> | undefined)?.[name]
        return !!entry && ("permission" in entry || "tools" in entry)
      })?.path
    })

    const own = Effect.fn("OperatorPermissionRules.own")(function* (name: string) {
      const cfg = yield* config.get()
      const entry = cfg.agent?.[name] as { permission?: Parameters<typeof Permission.fromConfig>[0] } | undefined
      const rules = Permission.fromConfig(entry?.permission ?? {})
      return { rules, path: yield* ownPath(name, yield* sources()) }
    })

    const agent = Effect.fn("OperatorPermissionRules.agent")(function* (name: string, draft?: ReadonlyArray<Rule>) {
      const info = yield* agents.get(name)
      const all = yield* agents.list()
      const cfg = yield* config.get()
      const parsed = yield* sources()
      const user = Permission.fromConfig(cfg.permission ?? {})
      const ownRules = (yield* own(name)).rules
      const ownFile = yield* ownPath(name, parsed)
      const list = info.permission
      // The truncation folder allow, added last unless the agent denies it.
      const truncation =
        !list.some(
          (rule) =>
            rule.permission === "external_directory" && rule.action === "deny" && rule.pattern === Truncate.GLOB,
        ) &&
        list.at(-1)?.permission === "external_directory" &&
        list.at(-1)?.pattern === Truncate.GLOB &&
        list.at(-1)?.action === "allow"
          ? 1
          : 0
      const ownEnd = list.length - truncation
      const ownStart = Math.max(0, ownEnd - ownRules.length)
      const userStart = Math.max(0, ownStart - user.length)
      // OpenCode's defaults are what every agent's list starts with.
      const prefix = (item: Agent.Info) => item.permission.slice(0, userStart)
      let defaults = userStart
      for (const other of all) {
        const theirs = prefix(other)
        let shared = 0
        while (shared < defaults && shared < theirs.length && same(theirs[shared]!, list[shared]!)) shared++
        if (theirs.length && other.name !== name) defaults = Math.min(defaults, shared)
      }
      const opencode: Row[] = list.slice(0, userStart).map((rule, index) => ({
        ...rule,
        index: 0,
        part: "opencode",
        from: index < defaults ? { kind: "opencode-default" } : { kind: "opencode-agent", agent: name },
      }))
      const configRows: Row[] = list.slice(userStart, ownStart).map((rule) => ({
        ...rule,
        index: 0,
        part: "config",
        from: configOrigin(rule, parsed),
      }))
      const ownRows: Row[] = (draft ?? list.slice(ownStart, ownEnd)).map((rule) => ({
        ...rule,
        index: 0,
        part: "agent",
        from: { kind: "agent", ...(ownFile ? { path: ownFile } : {}) },
      }))
      // OpenCode adds the truncation allow unless the list denies that folder (agent/agent.ts); with a
      // draft, as saving it would.
      const keepsTruncation = draft
        ? ![...opencode, ...configRows, ...draft].some(
            (rule) =>
              rule.permission === "external_directory" && rule.action === "deny" && rule.pattern === Truncate.GLOB,
          )
        : truncation === 1
      const truncationRows: Row[] = keepsTruncation
        ? [
            {
              permission: "external_directory",
              pattern: Truncate.GLOB,
              action: "allow",
              index: 0,
              part: "truncation",
              from: { kind: "truncation" },
            },
          ]
        : []
      const rows = [...opencode, ...configRows, ...ownRows, ...truncationRows].map((row, index) => ({
        ...row,
        index: index + 1,
      }))
      return {
        rows,
        own: { start: opencode.length + configRows.length, end: opencode.length + configRows.length + ownRows.length },
      }
    })

    return Service.of({ agent, own })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Config.node, OperatorConfig.node, OperatorAgents.node],
})

// Labels a session's own rules: by the origins the fork recorded when it wrote them, else as rules
// `task` adds (a subagent session), else as set by OpenCode.
export function sessionRows(input: {
  rules: ReadonlyArray<Rule>
  start: number
  parent: boolean
  primaryTools?: string[]
  recorded?: ReadonlyArray<Rule & { origin: "user" | "always" | "task" | "client"; time?: number }>
}): Row[] {
  const pool = [...(input.recorded ?? [])]
  return input.rules.map((rule, index) => {
    const found = pool.findIndex((item) => same(item, rule))
    const record = found >= 0 ? pool.splice(found, 1)[0] : undefined
    const from: Origin = record
      ? { kind: `session-${record.origin}`, ...(record.time ? { time: record.time } : {}) }
      : input.parent && isTaskRule(rule, input.primaryTools)
        ? { kind: "session-task" }
        : { kind: "session-opencode" }
    return { ...rule, index: input.start + index + 1, part: "session", from }
  })
}
