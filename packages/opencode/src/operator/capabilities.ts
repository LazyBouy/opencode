export * as OperatorCapabilities from "./capabilities"

import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Glob } from "@opencode-ai/core/util/glob"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { configEntryNameFromPath } from "@/config/entry-name"
import { ConfigMarkdown } from "@/config/markdown"
import { ConfigPaths } from "@/config/paths"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import { isRecord } from "@/util/record"
import { OperatorCapabilitySwitches } from "./capability-switches"
import { OperatorConfig } from "./config"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorReloadWhenIdle } from "./reload-when-idle"
import { OperatorTools } from "./tools"
import { OperatorTrashFiles } from "./trash-files"

// A project's capabilities by scope (capability_scopes_spec.md §3, §5): commands, skills, tools, MCP
// servers, agents and plugins, each with the scope its effective definition comes from (OpenCode,
// Global, Namespace, Project), the farther definitions it replaces, and whether it is turned off. The
// definitions are read from the same files, in the same order, as OpenCode loads them (Config,
// ConfigPaths, Skill), so the last one found is the one in effect.
//
// A project can accept an inherited capability (nothing to store), override it (a copy in the project
// to edit: the file into its .opencode, the config entry into its opencode.jsonc), or disable it with
// OpenCode's own switches (mcp enabled: false, agent disable: true, a tool's or skill's permission
// deny) or, for commands and plugins, the fork's `capabilities.disabled`. Revert removes either.
// Nothing is ever written to the scope a capability comes from.

export const Kind = Schema.Literals(["command", "skill", "tool", "mcp", "agent", "plugin"]).annotate({
  identifier: "OperatorCapabilityKind",
})
export type Kind = typeof Kind.Type

export const Origin = Schema.Literals(["opencode", "global", "namespace", "project"]).annotate({
  identifier: "OperatorCapabilityOrigin",
})
export type Origin = typeof Origin.Type

export const State = Schema.Literals(["local", "inherited", "overridden", "disabled"]).annotate({
  identifier: "OperatorCapabilityState",
  description:
    "local: defined only here; inherited: from a farther scope, used as is; overridden: defined here and in a farther scope (this one wins); disabled: turned off here or in the namespace",
})
export type State = typeof State.Type

export const Definition = Schema.Struct({
  origin: Origin,
  location: Schema.String.annotate({
    description: "Its file, or `<config file>#<section>.<name>` for a config entry; `<built-in>` for OpenCode's own",
  }),
}).annotate({ identifier: "OperatorCapabilityDefinition" })
export type Definition = typeof Definition.Type

export const Item = Schema.Struct({
  kind: Kind,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  origin: Origin,
  location: Schema.String,
  state: State,
  hides: Schema.Array(Definition).annotate({ description: "Farther definitions of the same name this one replaces" }),
  disabledAt: Schema.optional(Definition).annotate({ description: "Where it is turned off" }),
  basedOn: Schema.optional(
    Schema.Struct({
      version: Schema.String.annotate({ description: "The OpenCode version it was copied from" }),
      changed: Schema.Boolean.annotate({ description: "OpenCode's own text has changed since" }),
    }),
  ).annotate({ description: "For a copy of one of OpenCode's built-ins" }),
}).annotate({ identifier: "OperatorCapability" })
export type Item = typeof Item.Type

export const Inventory = Schema.Struct({
  scope: Schema.Literals(["project", "namespace"]),
  namespace: Schema.String,
  inheritGlobal: Schema.Boolean,
  items: Schema.Array(Item),
  config: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Namespace view: the top-level keys its own config sets, besides its capability entries",
  }),
}).annotate({ identifier: "OperatorCapabilities" })
export type Inventory = typeof Inventory.Type

export class ActionError extends Schema.TaggedErrorClass<ActionError>()("OperatorCapabilityAction", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The capabilities of the project in context, or of a namespace on its own. */
  readonly inventory: (input: { namespace?: string }) => Effect.Effect<Inventory>
  /** Copies an inherited capability into the project (or the namespace), to edit there. */
  readonly override: (input: { kind: Kind; name: string; namespace?: string }) => Effect.Effect<Item, ActionError>
  /** Turns an inherited capability off in the project (or the namespace). */
  readonly disable: (input: { kind: Kind; name: string; namespace?: string }) => Effect.Effect<Item, ActionError>
  /** Removes the project's override (to Trash) or its disable, so the inherited capability applies. */
  readonly revert: (input: { kind: Kind; name: string; namespace?: string }) => Effect.Effect<Item, ActionError>
  /** Deletes a capability defined at the scope (to Trash). */
  readonly remove: (input: { kind: Kind; name: string; namespace?: string }) => Effect.Effect<boolean, ActionError>
  /** Creates a capability at the scope. */
  readonly create: (input: CreateInput) => Effect.Effect<Item, ActionError>
  /** Copies a namespace's capability into another namespace's layer. */
  readonly copyTo: (input: {
    kind: Kind
    name: string
    namespace: string
    to: string
  }) => Effect.Effect<Item, ActionError>
  /** The text of a definition the scope owns: its file, or its config entry as JSON. */
  readonly read: (input: {
    kind: Kind
    name: string
    namespace?: string
  }) => Effect.Effect<{ location: string; text: string }, ActionError>
  /** Replaces a definition the scope owns. */
  readonly write: (input: {
    kind: Kind
    name: string
    namespace?: string
    text: string
  }) => Effect.Effect<Item, ActionError>
  /** A copy of an OpenCode built-in takes OpenCode's current text. */
  readonly takeOpenCode: (input: { kind: Kind; name: string; namespace?: string }) => Effect.Effect<Item, ActionError>
  /** Copies a source namespace's chosen capabilities and config keys into a new namespace. */
  readonly seed: (input: SeedInput) => Effect.Effect<Item[], ActionError>
}

export const SeedInput = Schema.Struct({
  from: Schema.String.annotate({ description: "The source namespace (OpenCode: its layer and its built-ins)" }),
  to: Schema.String.annotate({ description: "The new namespace" }),
  items: Schema.Array(Schema.Struct({ kind: Kind, name: Schema.String })),
  config: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Top-level keys of the source namespace's config to copy",
  }),
}).annotate({ identifier: "OperatorCapabilitySeed" })
export type SeedInput = typeof SeedInput.Type

export const CreateInput = Schema.Struct({
  kind: Kind,
  name: Schema.String,
  namespace: Schema.optional(Schema.String).annotate({
    description: "Create it in this namespace's layer instead of the project",
  }),
  description: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String).annotate({
    description: "A command's template, a skill's SKILL.md body, a tool's or plugin's source",
  }),
  agent: Schema.optional(Schema.String).annotate({ description: "The agent a command runs with" }),
  model: Schema.optional(Schema.String).annotate({ description: "The model a command runs with" }),
  subtask: Schema.optional(Schema.Boolean).annotate({ description: "Whether a command runs as a subtask" }),
  mcp: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "An MCP server's settings (type local with command, or remote with url)",
  }),
}).annotate({ identifier: "OperatorCapabilityCreate" })
export type CreateInput = typeof CreateInput.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorCapabilities") {}

type Scope = "global" | "namespace" | "project"
// A place definitions are read from, in load order: a config file, or a config folder.
type Source = { scope: Scope; json?: string; dir?: string }
// A definition found, with what override needs to copy it.
type Found = Definition & {
  kind: Kind
  name: string
  root?: string
  value?: unknown
  description?: string
  basedOn?: string
}
type Off = Definition & { kind: Kind; name: string }

const BUILTIN = "<built-in>"
const JSON_NAMES = ["opencode.json", "opencode.jsonc"]
const GLOBAL_JSON = ["config.json", "opencode.json", "opencode.jsonc"]
const RANK: Record<Origin, number> = { opencode: 0, global: 1, namespace: 2, project: 3 }

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

const readConfig = async (file: string) => {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const value = parse(text) as unknown
  return isRecord(value) ? value : {}
}

const scan = (pattern: string, cwd: string) =>
  Glob.scan(pattern, { cwd, absolute: true, dot: true, symlink: true }).catch(() => [] as string[])

// What a config file defines and turns off.
function fromConfig(source: Source & { json: string }, data: Record<string, unknown>) {
  const found: Found[] = []
  const off: Off[] = []
  const at = (section: string, name: string) => `${source.json}#${section}.${name}`
  for (const [section, kind] of [
    ["command", "command"],
    ["agent", "agent"],
    ["mode", "agent"],
    ["mcp", "mcp"],
  ] as const) {
    const entries = data[section]
    if (!isRecord(entries)) continue
    for (const [name, value] of Object.entries(entries)) {
      const keys = isRecord(value) ? Object.keys(value) : []
      // An empty entry defines nothing.
      if (isRecord(value) && !keys.length) continue
      // `{ enabled: false }` and `{ disable: true }` turn an inherited one off; they define nothing.
      if (kind === "mcp" && isRecord(value) && value.enabled === false && keys.every((key) => key === "enabled")) {
        off.push({ kind, name, origin: source.scope, location: at(section, name) })
        continue
      }
      if (kind === "agent" && isRecord(value) && value.disable === true && keys.every((key) => key === "disable")) {
        off.push({ kind, name, origin: source.scope, location: at(section, name) })
        continue
      }
      if (kind === "mcp" && isRecord(value) && value.enabled === false)
        off.push({ kind, name, origin: source.scope, location: at(section, name) })
      if (kind === "agent" && isRecord(value) && value.disable === true)
        off.push({ kind, name, origin: source.scope, location: at(section, name) })
      found.push({
        kind,
        name,
        origin: source.scope,
        location: at(section, name),
        value,
        description: isRecord(value) && typeof value.description === "string" ? value.description : undefined,
      })
    }
  }
  if (Array.isArray(data.plugin))
    for (const entry of data.plugin) {
      const spec =
        typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined
      if (!spec) continue
      found.push({
        kind: "plugin",
        name: OperatorCapabilitySwitches.pluginName(spec),
        origin: source.scope,
        location: at("plugin", spec),
        value: entry,
      })
    }
  for (const name of OperatorCapabilitySwitches.disabledList(data, "commands"))
    off.push({ kind: "command", name, origin: source.scope, location: at("capabilities.disabled.commands", name) })
  for (const name of OperatorCapabilitySwitches.disabledList(data, "plugins"))
    off.push({ kind: "plugin", name, origin: source.scope, location: at("capabilities.disabled.plugins", name) })
  const permission = data.permission
  if (isRecord(permission)) {
    for (const [name, value] of Object.entries(permission)) {
      if (name === "skill" && isRecord(value)) {
        for (const [skill, action] of Object.entries(value))
          if (skill !== "*" && action === "deny")
            off.push({ kind: "skill", name: skill, origin: source.scope, location: at("permission.skill", skill) })
        continue
      }
      if (value === "deny") off.push({ kind: "tool", name, origin: source.scope, location: at("permission", name) })
    }
  }
  return { found, off }
}

// What a config folder's files define.
async function fromFolder(source: Source & { dir: string }) {
  const found: Found[] = []
  const dir = source.dir
  const file = (kind: Kind, name: string, location: string, data?: Record<string, unknown>): Found => ({
    kind,
    name,
    origin: source.scope,
    location,
    root: dir,
    ...(typeof data?.description === "string" ? { description: data.description } : {}),
    ...(typeof data?.basedOn === "string" ? { basedOn: data.basedOn } : {}),
  })
  for (const item of await scan("{command,commands}/**/*.md", dir)) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue
    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])
    found.push(file("command", name, item, md.data))
  }
  for (const [pattern, prefixes] of [
    ["{agent,agents}/**/*.md", ["agent/", "agents/"]],
    ["{mode,modes}/*.md", ["mode/", "modes/"]],
  ] as const) {
    for (const item of await scan(pattern, dir)) {
      const md = await ConfigMarkdown.parse(item).catch(() => undefined)
      if (!md) continue
      const name = configEntryNameFromPath(path.relative(dir, item), [...prefixes])
      found.push(file("agent", name, item, md.data))
    }
  }
  for (const item of await scan("{tool,tools}/*.{js,ts}", dir))
    found.push(file("tool", path.basename(item, path.extname(item)), item))
  for (const item of await scan("{plugin,plugins}/*.{ts,js}", dir))
    found.push(file("plugin", path.basename(item, path.extname(item)), item))
  found.push(...(await skills(source.scope, dir, "{skill,skills}/**/SKILL.md")))
  return found
}

// The skills under a folder, by their frontmatter name (a skill without one is ignored, as OpenCode does).
async function skills(scope: Scope, dir: string, pattern: string): Promise<Found[]> {
  const found: Found[] = []
  for (const item of await scan(pattern, dir)) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md || typeof md.data.name !== "string") continue
    found.push({
      kind: "skill",
      name: md.data.name,
      origin: scope,
      location: item,
      root: dir,
      ...(typeof md.data.description === "string" ? { description: md.data.description } : {}),
      ...(typeof md.data.basedOn === "string" ? { basedOn: md.data.basedOn } : {}),
    })
  }
  return found
}

// The items: the last definition of each (kind, name) in load order is the effective one.
function items(view: Scope, found: ReadonlyArray<Found>, off: ReadonlyArray<Off>): Item[] {
  const groups = new Map<string, Found[]>()
  for (const item of found) {
    const key = `${item.kind}\u0000${item.name}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.values()]
    .map((list) => {
      const effective = list.at(-1)!
      const disabled = off.findLast((item) => item.kind === effective.kind && item.name === effective.name)
      const hides = list.slice(0, -1).map((item) => ({ origin: item.origin, location: item.location }))
      const state: State = disabled
        ? "disabled"
        : effective.origin === view
          ? hides.length
            ? "overridden"
            : "local"
          : "inherited"
      return {
        kind: effective.kind,
        name: effective.name,
        ...((effective.description ?? list.findLast((item) => item.description)?.description)
          ? { description: effective.description ?? list.findLast((item) => item.description)!.description }
          : {}),
        origin: effective.origin,
        location: effective.location,
        state,
        hides,
        ...(disabled ? { disabledAt: { origin: disabled.origin, location: disabled.location } } : {}),
        ...(effective.basedOn ? { basedOn: { version: effective.basedOn, changed: false } } : {}),
      }
    })
    .toSorted((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const config = yield* Config.Service
    const commands = yield* Command.Service
    const agents = yield* Agent.Service
    const tools = yield* OperatorTools.Service
    const operatorConfig = yield* OperatorConfig.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const runtime = yield* RuntimeFlags.Service
    const skillService = yield* Skill.Service
    const fail = (message: string) => new ActionError({ message })

    // A copy of one of OpenCode's built-ins, as a file of the same kind (capability_scopes_spec.md §7):
    // its `init` and `review` commands with their templates, its `build`, `plan`, `general` and `explore`
    // agents with their settings and prompts, and its `customize-opencode` skill. `basedOn` records the
    // OpenCode version and a fingerprint of its text, so a later OpenCode release that changes it shows.
    const builtinCopy = Effect.fnUntraced(function* (kind: Kind, name: string) {
      const front = (fields: Record<string, unknown>) =>
        `---\n${Object.entries(fields)
          .filter((pair) => pair[1] !== undefined && pair[1] !== "")
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join("\n")}\n---\n`
      const body = yield* Effect.gen(function* () {
        if (kind === "command" && (name === Command.Default.INIT || name === Command.Default.REVIEW)) {
          const command = yield* commands.get(name)
          if (!command) return undefined
          const template = yield* Effect.promise(async () => String(await command.template))
          return {
            file: path.join("commands", `${name}.md`),
            fields: { description: command.description, ...(command.subtask ? { subtask: true } : {}) },
            text: template,
          }
        }
        if (kind === "agent" && ["build", "plan", "general", "explore"].includes(name)) {
          const agent = yield* agents.get(name)
          if (!agent) return undefined
          return {
            file: path.join("agents", `${name}.md`),
            fields: { description: agent.description, mode: agent.mode },
            text: agent.prompt ?? "",
          }
        }
        if (kind === "skill" && name === "customize-opencode") {
          const skill = yield* skillService.get(name)
          if (!skill) return undefined
          return {
            file: path.join("skills", name, "SKILL.md"),
            fields: { name, description: skill.description },
            text: skill.content,
          }
        }
        return undefined
      })
      if (!body) return undefined
      const hash = createHash("sha256")
        .update(JSON.stringify([body.fields, body.text]))
        .digest("hex")
        .slice(0, 12)
      const basedOn = `opencode@${InstallationVersion}#${hash}`
      return { file: body.file, hash, text: `${front({ ...body.fields, basedOn })}${body.text}\n` }
    })

    // A copy's `basedOn` against OpenCode's text now.
    const withBasedOn = Effect.fnUntraced(function* (list: Item[]) {
      return yield* Effect.forEach(list, (item) =>
        Effect.gen(function* () {
          if (!item.basedOn) return item
          const match = item.basedOn.version.match(/^opencode@([^#]*)#(.+)$/)
          if (!match) return item
          const current = yield* builtinCopy(item.kind, item.name)
          return { ...item, basedOn: { version: match[1]!, changed: !!current && current.hash !== match[2] } }
        }),
      )
    })

    // OpenCode's own: its built-in commands, agents, tools and skill.
    const builtins = Effect.fnUntraced(function* () {
      const found: Found[] = []
      const own = (kind: Kind, name: string, description?: string): Found => ({
        kind,
        name,
        origin: "opencode",
        location: BUILTIN,
        ...(description ? { description } : {}),
      })
      for (const name of [Command.Default.INIT, Command.Default.REVIEW, Command.Default.MERGE]) {
        const command = yield* commands.get(name)
        found.push(own("command", name, command?.description))
      }
      for (const agent of yield* agents.list())
        if (agent.native) found.push(own("agent", agent.name, agent.description))
      for (const tool of yield* tools.list()) if (tool.origin === "builtin") found.push(own("tool", tool.id))
      found.push(own("skill", "customize-opencode"))
      return found
    })

    // The sources of the project in context, in OpenCode's load order.
    const projectSources = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const scope = yield* Effect.promise(() => OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree))
      const dirs = yield* ConfigPaths.directories(ctx.directory, ctx.worktree).pipe(
        Effect.provideService(FSUtil.Service, fsys),
        Effect.orDie,
      )
      const files = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? []
        : yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(
            Effect.provideService(FSUtil.Service, fsys),
            Effect.orDie,
          )
      const classify = (dir: string): Scope =>
        OperatorNamespaceScope.isGlobalFolder(dir) || dir === Flag.OPENCODE_CONFIG_DIR
          ? "global"
          : OperatorNamespaceScope.owns(dir)
            ? "namespace"
            : "project"
      const sources: Source[] = [
        ...(scope.inherit
          ? GLOBAL_JSON.map((name) => ({ scope: "global" as const, json: path.join(Global.Path.config, name) }))
          : []),
        ...(scope.dir
          ? JSON_NAMES.map((name) => ({ scope: "namespace" as const, json: path.join(scope.dir!, name) }))
          : []),
        ...(Flag.OPENCODE_CONFIG ? [{ scope: "global" as const, json: Flag.OPENCODE_CONFIG }] : []),
        ...files.map((file) => ({ scope: "project" as const, json: file })),
        ...dirs.flatMap((dir): Source[] => {
          const scope = classify(dir)
          const own =
            (dir.endsWith(".opencode") && !OperatorNamespaceScope.owns(dir)) || dir === Flag.OPENCODE_CONFIG_DIR
          return [...(own ? JSON_NAMES.map((name) => ({ scope, json: path.join(dir, name) })) : []), { scope, dir }]
        }),
      ]
      return { ctx, scope, sources }
    })

    // The skills OpenCode finds outside its config folders: ~/.claude and ~/.agents, and those folders
    // from the working folder up to the project root (skill/index.ts), then config `skills.paths`.
    const externalSkills = Effect.fnUntraced(function* (
      ctx: { directory: string; worktree: string },
      inherit: boolean,
    ) {
      const found: Found[] = []
      const flags = { external: !runtime.disableExternalSkills, claude: !runtime.disableClaudeCodeSkills }
      if (!flags.external) return { before: found, after: [] as Found[] }
      const names = [...(flags.claude ? [".claude"] : []), ".agents"]
      if (inherit)
        for (const name of names)
          found.push(
            ...(yield* Effect.promise(() => skills("global", path.join(Global.Path.home, name), "skills/**/SKILL.md"))),
          )
      const up = yield* fsys
        .up({ targets: names, start: ctx.directory, stop: ctx.worktree })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      for (const root of up) found.push(...(yield* Effect.promise(() => skills("project", root, "skills/**/SKILL.md"))))
      const cfg = yield* config.get()
      const after: Found[] = []
      for (const item of cfg.skills?.paths ?? []) {
        const expanded = item.startsWith("~/") ? path.join(Global.Path.home, item.slice(2)) : item
        const dir = path.isAbsolute(expanded) ? expanded : path.join(ctx.directory, expanded)
        after.push(...(yield* Effect.promise(() => skills("project", dir, "**/SKILL.md"))))
      }
      return { before: found, after }
    })

    const collect = Effect.fnUntraced(function* (sources: ReadonlyArray<Source>) {
      const found: Found[] = []
      const off: Off[] = []
      for (const source of sources) {
        if (source.json) {
          const data = yield* Effect.promise(() => readConfig(source.json!))
          if (!data) continue
          const read = fromConfig(source as Source & { json: string }, data)
          found.push(...read.found)
          off.push(...read.off)
        }
        if (source.dir) found.push(...(yield* Effect.promise(() => fromFolder(source as Source & { dir: string }))))
      }
      return { found, off }
    })

    // Skills are found in their own order (skill/index.ts): OpenCode's, then ~/.claude and ~/.agents,
    // then the project's .claude and .agents, then the config folders, then `skills.paths`.
    const ordered = (found: ReadonlyArray<Found>, external: { before: Found[]; after: Found[] }, builtin: Found[]) => [
      ...builtin.filter((item) => item.kind === "skill"),
      ...external.before,
      ...found.filter((item) => item.kind === "skill"),
      ...external.after,
      ...builtin.filter((item) => item.kind !== "skill"),
      ...found.filter((item) => item.kind !== "skill"),
    ]

    // Every definition and switch in view: the project's (its effective set), or a namespace's own
    // layer over Global (when it inherits it) and OpenCode.
    const gather = Effect.fnUntraced(function* (namespace?: string) {
      const builtin = yield* builtins()
      if (namespace) {
        const scope = yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(namespace))
        const sources: Source[] = [
          ...(scope.inherit
            ? [
                ...GLOBAL_JSON.map((name) => ({ scope: "global" as const, json: path.join(Global.Path.config, name) })),
                { scope: "global" as const, dir: Global.Path.config },
                { scope: "global" as const, dir: path.join(Global.Path.home, ".opencode") },
              ]
            : []),
          ...(scope.dir
            ? [
                ...JSON_NAMES.map((name) => ({ scope: "namespace" as const, json: path.join(scope.dir!, name) })),
                { scope: "namespace" as const, dir: scope.dir },
              ]
            : []),
        ]
        const read = yield* collect(sources)
        const home = scope.inherit
          ? (yield* Effect.forEach([".claude", ".agents"], (name) =>
              Effect.promise(() => skills("global", path.join(Global.Path.home, name), "skills/**/SKILL.md")),
            )).flat()
          : []
        const own = scope.dir
          ? yield* Effect.promise(async () => {
              for (const name of [...JSON_NAMES].reverse()) {
                const data = await readConfig(path.join(scope.dir!, name))
                if (data) return data
              }
              return {}
            })
          : {}
        return {
          view: "namespace" as const,
          namespace,
          inherit: scope.inherit,
          found: ordered(read.found, { before: home, after: [] }, builtin),
          off: read.off,
          config: Object.keys(own).filter(
            (key) => !["$schema", "command", "agent", "mode", "mcp", "plugin"].includes(key),
          ),
        }
      }
      const { ctx, scope, sources } = yield* projectSources()
      const read = yield* collect(sources)
      const external = yield* externalSkills(ctx, scope.inherit)
      return {
        view: "project" as const,
        namespace: scope.namespace,
        inherit: scope.inherit,
        found: ordered(read.found, external, builtin),
        off: read.off,
        config: undefined,
      }
    })

    const inventory = Effect.fn("OperatorCapabilities.inventory")(function* (input: { namespace?: string }) {
      const all = yield* gather(input.namespace)
      return {
        scope: all.view,
        namespace: all.namespace,
        inheritGlobal: all.inherit,
        items: yield* withBasedOn(items(all.view, all.found, all.off)),
        ...(all.config ? { config: all.config } : {}),
      }
    })

    // Where an action writes: the project's .opencode and config, or the namespace's.
    type Target = {
      view: Scope
      namespace?: string
      dir: string
      patch: (body: Record<string, unknown>) => Effect.Effect<unknown, ActionError>
      config: () => Effect.Effect<Record<string, unknown>>
      reload: () => Effect.Effect<void>
      project?: string
    }
    const targetOf = Effect.fnUntraced(function* (namespace?: string) {
      if (namespace) {
        const layers = yield* operatorConfig.layers(namespace)
        const dir = layers.folders.namespace
        if (!dir) return yield* fail(`The namespace ${namespace} has no folder; set one in Settings → Namespaces`)
        return {
          view: "namespace" as const,
          namespace,
          dir,
          patch: (body: Record<string, unknown>) =>
            operatorConfig.update("namespace", body, namespace).pipe(Effect.mapError((error) => fail(error.message))),
          config: () => fileConfig(layers.targets.namespace),
          reload: () =>
            Effect.forEach(
              OperatorNamespaceScope.instancesOf({ namespace }),
              (directory) => reloads.want({ directory }),
              {
                discard: true,
              },
            ),
        } satisfies Target
      }
      const ctx = yield* InstanceState.context
      const scope = yield* Effect.promise(() => OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree))
      return {
        view: "project" as const,
        dir: OperatorConfig.scopeDirectory("project", ctx),
        patch: (body: Record<string, unknown>) =>
          operatorConfig.update("project", body).pipe(Effect.mapError((error) => fail(error.message))),
        config: () => operatorConfig.layers().pipe(Effect.flatMap((layers) => fileConfig(layers.targets.project))),
        reload: () =>
          Effect.forEach(
            OperatorNamespaceScope.instancesOf({ project: scope.project }),
            (directory) => reloads.want({ directory }),
            { discard: true },
          ),
        project: ctx.directory,
      } satisfies Target
    })

    // A config file's contents, as written (for lists that are replaced whole).
    const fileConfig = (file: string | undefined) =>
      Effect.promise(async () => (file ? ((await readConfig(file)) ?? {}) : {}))

    // The item and every definition of it, in the target's view.
    const lookup = Effect.fnUntraced(function* (input: { kind: Kind; name: string; namespace?: string }) {
      const all = yield* gather(input.namespace)
      const item = items(all.view, all.found, all.off).find(
        (found) => found.kind === input.kind && found.name === input.name,
      )
      if (!item) return yield* fail(`No ${input.kind} named ${input.name} here`)
      const definitions = all.found.filter((found) => found.kind === input.kind && found.name === input.name)
      const off = all.off.filter((found) => found.kind === input.kind && found.name === input.name)
      return { item, definitions, off, target: yield* targetOf(input.namespace) }
    })

    const after = Effect.fnUntraced(function* (
      input: { kind: Kind; name: string; namespace?: string },
      target: Target,
    ) {
      yield* target.reload()
      return (yield* inventory({ namespace: input.namespace })).items.find(
        (item) => item.kind === input.kind && item.name === input.name,
      )!
    })

    // Copies a definition into a target's layer: its file (a skill with its folder) to the same place
    // under the target's .opencode, or its config entry into the target's config. OpenCode's own
    // commands go with their text; its agents, tools and skill are code and can't be copied.
    const copyInto = Effect.fnUntraced(function* (input: { kind: Kind; name: string }, source: Found, target: Target) {
      if (source.location === BUILTIN) {
        const copy = yield* builtinCopy(input.kind, input.name)
        if (!copy)
          return yield* fail(`OpenCode's ${input.kind} ${input.name} can't be copied; disable it, or define your own`)
        const file = path.join(target.dir, copy.file)
        if (yield* Effect.promise(() => exists(file))) return yield* fail(`${file} exists already`)
        yield* fsys.writeWithDirs(file, copy.text).pipe(Effect.orDie)
        return
      }
      if (source.root) {
        const from = input.kind === "skill" ? path.dirname(source.location) : source.location
        const to = path.join(target.dir, path.relative(source.root, from))
        if (yield* Effect.promise(() => exists(to))) return yield* fail(`${to} exists already`)
        yield* Effect.promise(() => fs.cp(from, to, { recursive: true }))
        return
      }
      if (input.kind === "plugin") {
        const current = yield* target.config()
        const list = Array.isArray(current.plugin) ? current.plugin : []
        yield* target.patch({ plugin: OperatorConfig.whole([...list, source.value]) })
        return
      }
      const section = source.location.slice(source.location.lastIndexOf("#") + 1).split(".")[0]!
      yield* target.patch({ [section]: { [input.name]: source.value } })
    })

    const override = Effect.fn("OperatorCapabilities.override")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
    }) {
      const { item, definitions, target } = yield* lookup(input)
      if (item.origin === target.view) return yield* fail(`${input.name} is already defined here`)
      yield* copyInto(input, definitions.at(-1)!, target)
      return yield* after(input, target)
    })

    // A namespace's capability copied into another namespace's layer, as that one's own.
    const copyTo = Effect.fn("OperatorCapabilities.copyTo")(function* (input: {
      kind: Kind
      name: string
      namespace: string
      to: string
    }) {
      if (input.to === input.namespace) return yield* fail("Choose another namespace")
      const { definitions } = yield* lookup(input)
      const target = yield* targetOf(input.to)
      yield* copyInto(input, definitions.at(-1)!, target)
      return yield* after({ kind: input.kind, name: input.name, namespace: input.to }, target)
    })

    // The text of a definition the scope owns, to edit: its file, or its config entry as JSON.
    const read = Effect.fn("OperatorCapabilities.read")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
    }) {
      const { item, definitions, target } = yield* lookup(input)
      if (item.origin !== target.view) return yield* fail(`${input.name} isn't defined here; override it to edit it`)
      const own = definitions.at(-1)!
      if (own.root)
        return { location: own.location, text: yield* Effect.promise(() => fs.readFile(own.location, "utf8")) }
      return { location: own.location, text: `${JSON.stringify(own.value, null, 2)}\n` }
    })

    const write = Effect.fn("OperatorCapabilities.write")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
      text: string
    }) {
      const { item, definitions, target } = yield* lookup(input)
      if (item.origin !== target.view) return yield* fail(`${input.name} isn't defined here; override it to edit it`)
      const own = definitions.at(-1)!
      if (own.root) yield* fsys.writeWithDirs(own.location, input.text).pipe(Effect.orDie)
      else {
        const value = yield* Effect.try({
          try: () => JSON.parse(input.text) as unknown,
          catch: () => fail("The entry must be valid JSON"),
        })
        if (input.kind === "plugin") return yield* fail("Edit a plugin entry in the Config page")
        const section = own.location.slice(own.location.lastIndexOf("#") + 1).split(".")[0]!
        yield* target.patch({ [section]: { [input.name]: OperatorConfig.whole(value) } })
      }
      return yield* after(input, target)
    })

    const disable = Effect.fn("OperatorCapabilities.disable")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
    }) {
      const { item, target } = yield* lookup(input)
      if (item.state === "disabled") return yield* fail(`${input.name} is turned off already`)
      if (item.origin === target.view) return yield* fail(`${input.name} is defined here: delete it instead`)
      if (input.kind === "command" && input.name === Command.Default.MERGE)
        return yield* fail("/merge is reserved and can't be turned off")
      if (input.kind === "mcp") yield* target.patch({ mcp: { [input.name]: { enabled: false } } })
      if (input.kind === "agent") yield* target.patch({ agent: { [input.name]: { disable: true } } })
      if (input.kind === "tool") yield* target.patch({ permission: { [input.name]: "deny" } })
      if (input.kind === "skill") {
        const current = yield* target.config()
        const permission = isRecord(current.permission) ? current.permission : {}
        const skill = permission.skill
        const next = isRecord(skill)
          ? { ...skill, [input.name]: "deny" }
          : typeof skill === "string"
            ? { "*": skill, [input.name]: "deny" }
            : { [input.name]: "deny" }
        yield* target.patch({ permission: { skill: OperatorConfig.whole(next) } })
      }
      if (input.kind === "command" || input.kind === "plugin") {
        const list = input.kind === "command" ? "commands" : "plugins"
        const current = OperatorCapabilitySwitches.disabledList(yield* target.config(), list)
        yield* target.patch({ capabilities: { disabled: { [list]: OperatorConfig.whole([...current, input.name]) } } })
      }
      return yield* after(input, target)
    })

    // Moves the target's own definition to Trash: a file or folder, or a config entry kept to write back.
    const trashOwn = Effect.fnUntraced(function* (input: { kind: Kind; name: string }, own: Found, target: Target) {
      const trashKind = input.kind
      if (own.root) {
        const file = input.kind === "skill" ? path.dirname(own.location) : own.location
        yield* Effect.promise(() =>
          OperatorTrashFiles.put({
            kind: trashKind,
            name: input.name,
            ...(target.project ? { project: target.project } : {}),
            ...(target.namespace ? { namespace: target.namespace } : {}),
            paths: [file],
          }),
        )
        return
      }
      if (input.kind === "plugin") {
        const current = yield* target.config()
        const list = (Array.isArray(current.plugin) ? current.plugin : []).filter((entry) => {
          const spec = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined
          return typeof spec !== "string" || OperatorCapabilitySwitches.pluginName(spec) !== input.name
        })
        yield* target.patch({ plugin: list.length ? OperatorConfig.whole(list) : null })
        return
      }
      const section = own.location.slice(own.location.lastIndexOf("#") + 1).split(".")[0]!
      yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: trashKind,
          name: input.name,
          ...(target.project ? { project: target.project } : {}),
          ...(target.namespace ? { namespace: target.namespace } : {}),
          config: {
            scope: target.view === "namespace" ? "global" : "project",
            key: [section, input.name],
            value: own.value,
          },
        }),
      )
      yield* target.patch({ [section]: { [input.name]: null } })
    })

    const revert = Effect.fn("OperatorCapabilities.revert")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
    }) {
      const { item, definitions, off, target } = yield* lookup(input)
      const own = off.findLast((found) => found.origin === target.view)
      if (own) {
        // The switch goes; anything else in the entry stays. An entry that only held it goes with it.
        const entry = (section: "mcp" | "agent", key: string) =>
          Effect.gen(function* () {
            const current = yield* target.config()
            const value = isRecord(current[section]) ? current[section][input.name] : undefined
            const only = isRecord(value) && Object.keys(value).every((item) => item === key)
            yield* target.patch({ [section]: { [input.name]: only ? null : { [key]: null } } })
          })
        if (input.kind === "mcp") yield* entry("mcp", "enabled")
        if (input.kind === "agent") yield* entry("agent", "disable")
        if (input.kind === "tool") yield* target.patch({ permission: { [input.name]: null } })
        if (input.kind === "skill") yield* target.patch({ permission: { skill: { [input.name]: null } } })
        if (input.kind === "command" || input.kind === "plugin") {
          const list = input.kind === "command" ? "commands" : "plugins"
          const current = OperatorCapabilitySwitches.disabledList(yield* target.config(), list).filter(
            (name) => name !== input.name,
          )
          yield* target.patch({
            capabilities: { disabled: { [list]: current.length ? OperatorConfig.whole(current) : null } },
          })
        }
        return yield* after(input, target)
      }
      if (item.state !== "overridden") return yield* fail(`${input.name} has no override or switch here`)
      yield* trashOwn(input, definitions.at(-1)!, target)
      return yield* after(input, target)
    })

    // Deletes the target's own definition (to Trash). OpenCode's built-ins and farther scopes' items
    // can't be deleted here: they can be disabled.
    const remove = Effect.fn("OperatorCapabilities.remove")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
    }) {
      const { item, definitions, target } = yield* lookup(input)
      if (item.origin !== target.view)
        return yield* fail(
          item.origin === "opencode"
            ? `${input.name} is OpenCode's own and can't be deleted`
            : `${input.name} comes from the ${item.origin} scope; disable it here instead`,
        )
      yield* trashOwn(input, definitions.at(-1)!, target)
      yield* target.reload()
      return true
    })

    // A new capability at the target scope: a file under its .opencode, or an MCP server entry.
    const create = Effect.fn("OperatorCapabilities.create")(function* (input: CreateInput) {
      const target = yield* targetOf(input.namespace)
      const name = input.name.trim()
      if (!/^[\w][\w.-]*(\/[\w][\w.-]*)*$/.test(name)) return yield* fail(`"${input.name}" is not a valid name`)
      const front = (fields: Record<string, unknown>) =>
        `---\n${Object.entries(fields)
          .filter((pair) => pair[1] !== undefined && pair[1] !== "")
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join("\n")}\n---\n`
      const files: Record<Exclude<Kind, "mcp" | "agent">, () => { file: string; text: string }> = {
        command: () => ({
          file: path.join(target.dir, "commands", `${name}.md`),
          text: `${front({ description: input.description, agent: input.agent, model: input.model, subtask: input.subtask })}${input.text ?? ""}\n`,
        }),
        skill: () => ({
          file: path.join(target.dir, "skills", name, "SKILL.md"),
          text: `${front({ name, description: input.description })}${input.text ?? ""}\n`,
        }),
        tool: () => ({ file: path.join(target.dir, "tools", `${name}.ts`), text: input.text ?? "" }),
        plugin: () => ({ file: path.join(target.dir, "plugins", `${name}.ts`), text: input.text ?? "" }),
      }
      if (input.kind === "agent") return yield* fail("Agents are created with the agent form")
      if (input.kind === "mcp") {
        if (!input.mcp) return yield* fail("An MCP server needs its settings")
        const current = yield* target.config()
        if (isRecord(current.mcp) && name in current.mcp) return yield* fail(`${name} is defined here already`)
        yield* target.patch({ mcp: { [name]: input.mcp } })
        return yield* after({ kind: "mcp", name, namespace: input.namespace }, target)
      }
      const { file, text } = files[input.kind]()
      if (yield* Effect.promise(() => exists(file))) return yield* fail(`${file} exists already`)
      yield* fsys.writeWithDirs(file, text).pipe(Effect.orDie)
      return yield* after({ kind: input.kind, name, namespace: input.namespace }, target)
    })

    // A copy of an OpenCode built-in takes OpenCode's current text (and a new `basedOn`).
    const takeOpenCode = Effect.fn("OperatorCapabilities.takeOpenCode")(function* (input: {
      kind: Kind
      name: string
      namespace?: string
    }) {
      const { item, definitions, target } = yield* lookup(input)
      const own = definitions.at(-1)!
      if (item.origin !== target.view || !own.root || !own.basedOn)
        return yield* fail(`${input.name} here is not a copy of OpenCode's`)
      const copy = yield* builtinCopy(input.kind, input.name)
      if (!copy) return yield* fail(`OpenCode has no ${input.kind} ${input.name} now`)
      yield* fsys.writeWithDirs(own.location, copy.text).pipe(Effect.orDie)
      return yield* after(input, target)
    })

    // A new namespace's starting capabilities (§7): the chosen items of the source namespace's own
    // layer (with OpenCode's copyable built-ins when the source is OpenCode), and the chosen keys of its
    // config, copied into the new namespace's layer as its own. MCP logins are never copied.
    const seed = Effect.fn("OperatorCapabilities.seed")(function* (input: SeedInput) {
      const target = yield* targetOf(input.to)
      const all = yield* gather(input.from)
      for (const wanted of input.items) {
        const definitions = all.found.filter((found) => found.kind === wanted.kind && found.name === wanted.name)
        const source = definitions.at(-1)
        if (!source) return yield* fail(`${input.from} has no ${wanted.kind} ${wanted.name}`)
        if (source.origin === "global")
          return yield* fail(`${wanted.name} is a global one: it is inherited, not copied`)
        yield* copyInto(wanted, source, target)
      }
      if (input.config?.length) {
        const layers = yield* operatorConfig.layers(input.from)
        const from = yield* fileConfig(layers.targets.namespace)
        const patch = Object.fromEntries(
          input.config.filter((key) => key in from).map((key) => [key, OperatorConfig.whole(from[key])]),
        )
        if (Object.keys(patch).length) yield* target.patch(patch)
      }
      const listed = (yield* inventory({ namespace: input.to })).items
      return listed.filter((item) =>
        input.items.some((wanted) => wanted.kind === item.kind && wanted.name === item.name),
      )
    })

    return Service.of({
      inventory,
      override,
      disable,
      revert,
      remove,
      create,
      copyTo,
      read,
      write,
      takeOpenCode,
      seed,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    FSUtil.node,
    Config.node,
    Command.node,
    Agent.node,
    OperatorTools.node,
    OperatorConfig.node,
    OperatorReloadWhenIdle.node,
    RuntimeFlags.node,
    Skill.node,
  ],
})
