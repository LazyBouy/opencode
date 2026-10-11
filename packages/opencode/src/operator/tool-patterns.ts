export * as OperatorToolPatterns from "./tool-patterns"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "./file-cache"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorTools } from "./tools"

// How each tool's permission requests look (specs/docs/feedbacks/memory/memory_spec.md §9), so rules can be
// written without reading code: the permission its rules use, its verbs (if any), what the pattern is
// matched against, examples, and the default rules that apply. OpenCode's tools are filled in from their
// `ctx.ask` calls (this table); MCP tools always ask with `*`; a custom tool's entry is written by the user
// (asked for when it is created), kept in `<config>/namespaces/tool-patterns.json`.

export const Action = Schema.Literals(["allow", "ask", "deny"])
export const Example = Schema.Struct({ pattern: Schema.String, action: Action }).annotate({
  identifier: "OperatorToolPatternExample",
})
export type Example = typeof Example.Type

// How the pattern is matched: one of the permission editor's forms (permission-rules.ts), `verbs`
// (`<VERB>(<target>)`), or `custom` (a custom tool's own description).
export const Form = Schema.Literals([...OperatorPermissionRules.PatternForm.literals, "verbs", "custom"]).annotate({
  identifier: "OperatorToolPatternForm",
})
export type Form = typeof Form.Type

export const Pattern = Schema.Struct({
  tool: Schema.String,
  permission: Schema.String.annotate({ description: "The name rules use" }),
  verbs: Schema.Array(Schema.String).annotate({ description: "The tool's verbs (memory: READ, WRITE, FORGET)" }),
  form: Form,
  text: Schema.optional(Schema.String).annotate({ description: "A custom tool's own words for what the pattern is" }),
  examples: Schema.Array(Example),
  source: Schema.Literals(["code", "mcp", "user", "default"]).annotate({
    description:
      "code: OpenCode's (or the fork's) tool, from its ctx.ask calls; mcp: an MCP tool, always `*`; user: written for a custom tool; default: a custom tool's until one is written (its id, `*`)",
  }),
  editable: Schema.Boolean,
  defaults: Schema.Array(Schema.Struct({ pattern: Schema.String, action: Action, level: Schema.String })).annotate({
    description: "The rules for its permission that apply by default (OpenCode's and Global's), in order",
  }),
}).annotate({ identifier: "OperatorToolPattern" })
export type Pattern = typeof Pattern.Type

export const Input = Schema.Struct({
  tool: Schema.String,
  permission: Schema.String,
  verbs: Schema.Array(Schema.String),
  text: Schema.String,
  examples: Schema.Array(Example),
})
export type Input = typeof Input.Type

type Entry = { permission: string; verbs: string[]; form: Form; examples: Example[] }
const entry = (permission: string, form: Form, examples: Example[], verbs: string[] = []): Entry => ({
  permission,
  verbs,
  form,
  examples,
})

// OpenCode's tools and the fork's, from their `ctx.ask` calls.
export const BUILTINS: Readonly<Record<string, Entry>> = {
  bash: entry("bash", "command", [
    { pattern: "git push*", action: "ask" },
    { pattern: "rm -rf *", action: "deny" },
    { pattern: "bun test*", action: "allow" },
  ]),
  read: entry("read", "path", [
    { pattern: "*.env", action: "ask" },
    { pattern: "*", action: "allow" },
  ]),
  edit: entry("edit", "path", [
    { pattern: "docs/*", action: "allow" },
    { pattern: "*.lock", action: "deny" },
  ]),
  write: entry("edit", "path", [{ pattern: "docs/*", action: "allow" }]),
  apply_patch: entry("edit", "path", [{ pattern: "docs/*", action: "allow" }]),
  glob: entry("glob", "search", [{ pattern: "*", action: "allow" }]),
  grep: entry("grep", "search", [{ pattern: "*", action: "allow" }]),
  webfetch: entry("webfetch", "url", [
    { pattern: "https://internal.example/*", action: "deny" },
    { pattern: "https://docs.*", action: "allow" },
  ]),
  websearch: entry("websearch", "query", [{ pattern: "*", action: "ask" }]),
  task: entry("task", "agent", [
    { pattern: "general", action: "deny" },
    { pattern: "explore", action: "allow" },
  ]),
  skill: entry("skill", "skill", [{ pattern: "rtl-*", action: "ask" }]),
  todowrite: entry("todowrite", "any", [{ pattern: "*", action: "deny" }]),
  question: entry("question", "any", [{ pattern: "*", action: "deny" }]),
  lsp: entry("lsp", "any", [{ pattern: "*", action: "allow" }]),
  external_directory: entry("external_directory", "absolute", [{ pattern: "/tmp/*", action: "allow" }]),
  memory: entry(
    "memory",
    "verbs",
    [
      { pattern: "READ(*)", action: "allow" },
      { pattern: "WRITE(project/*)", action: "ask" },
      { pattern: "FORGET(agent/*)", action: "ask" },
    ],
    ["READ", "WRITE", "FORGET"],
  ),
}

const storeFile = () => path.join(Global.Path.config, "namespaces", "tool-patterns.json")
type Stored = Record<string, { permission: string; verbs: string[]; text: string; examples: Example[] }>
async function readStored(): Promise<Stored> {
  const data = await OperatorFileCache.json(storeFile())
  return data && typeof data === "object" ? (data as Stored) : {}
}

export interface Interface {
  /** Every tool of the project (and `external_directory`), with its pattern and default rules. */
  readonly list: () => Effect.Effect<Pattern[]>
  /** A custom tool's entry (OpenCode's and MCP tools are not edited). */
  readonly save: (input: Input) => Effect.Effect<Pattern, InvalidError>
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorToolPatternInvalid", {
  message: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorToolPatterns") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tools = yield* OperatorTools.Service
    const live = yield* OperatorPermissionLive.Service

    // The rules that apply by default to a permission: OpenCode's (for build) and Global's.
    const defaultsOf = Effect.fnUntraced(function* () {
      const built = yield* live.lines({ agent: "build", upTo: "global" })
      return (permission: string) =>
        built.lines
          .filter((line) => line.permission === permission || line.permission === "*")
          .map((line) => ({
            pattern: line.permission === "*" ? `* (${line.pattern})` : line.pattern,
            action: line.action,
            level: OperatorPermissionLive.levelName(line.level),
          }))
    })

    const patternOf = (
      tool: { id: string; origin: string },
      stored: Stored,
      defaults: (permission: string) => Pattern["defaults"],
    ): Pattern => {
      const builtin = BUILTINS[tool.id]
      if (builtin)
        return { tool: tool.id, ...builtin, source: "code", editable: false, defaults: defaults(builtin.permission) }
      if (tool.origin === "mcp")
        return {
          tool: tool.id,
          permission: tool.id,
          verbs: [],
          form: "any",
          examples: [{ pattern: "*", action: "deny" }],
          source: "mcp",
          editable: false,
          defaults: defaults(tool.id),
        }
      const own = stored[tool.id]
      if (own)
        return {
          tool: tool.id,
          permission: own.permission,
          verbs: own.verbs,
          form: own.verbs.length ? "verbs" : "custom",
          text: own.text,
          examples: own.examples,
          source: "user",
          editable: true,
          defaults: defaults(own.permission),
        }
      // Custom tools usually ask with `*` unless their code does otherwise.
      return {
        tool: tool.id,
        permission: tool.id,
        verbs: [],
        form: "custom",
        text: "*",
        examples: [],
        source: "default",
        editable: true,
        defaults: defaults(tool.id),
      }
    }

    const list = Effect.fn("OperatorToolPatterns.list")(function* () {
      const listed = yield* tools.list()
      const stored = yield* Effect.promise(readStored)
      const defaults = yield* defaultsOf()
      const all = [
        ...listed.map((tool) => ({ id: tool.id, origin: tool.origin })),
        { id: "external_directory", origin: "builtin" },
      ]
      return all
        .filter((tool, at) => all.findIndex((other) => other.id === tool.id) === at)
        .map((tool) => patternOf(tool, stored, defaults))
        .toSorted((a, b) => a.tool.localeCompare(b.tool))
    })

    const save = Effect.fn("OperatorToolPatterns.save")(function* (input: Input) {
      const listed = yield* tools.list()
      // A custom tool just created may not be listed yet: its entry is kept for when it is.
      const tool = listed.find((item) => item.id === input.tool) ?? { id: input.tool, origin: "custom" as const }
      if (!/^[A-Za-z0-9_-]+$/.test(tool.id))
        return yield* new InvalidError({ message: `"${input.tool}" is not a tool id` })
      if (BUILTINS[tool.id] || tool.origin === "mcp")
        return yield* new InvalidError({ message: `${tool.id}'s permission pattern comes from its code` })
      if (!input.permission.trim())
        return yield* new InvalidError({ message: "A permission pattern needs a permission" })
      const verbs = input.verbs.map((verb) => verb.trim().toUpperCase()).filter(Boolean)
      const stored = yield* Effect.promise(readStored)
      const next: Stored = {
        ...stored,
        [tool.id]: {
          permission: input.permission.trim(),
          verbs,
          text: input.text.trim() || "*",
          examples: [...input.examples],
        },
      }
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(storeFile()), { recursive: true })
        await Bun.write(storeFile(), JSON.stringify(next, null, 2) + "\n")
      })
      return patternOf(tool, next, yield* defaultsOf())
    })

    return Service.of({ list, save })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorTools.node, OperatorPermissionLive.node],
})
