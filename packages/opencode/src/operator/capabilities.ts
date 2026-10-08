export * as OperatorCapabilities from "./capabilities"

import fs from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { configEntryNameFromPath } from "@/config/entry-name"
import { ConfigMarkdown } from "@/config/markdown"
import { ConfigPaths } from "@/config/paths"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
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
}).annotate({ identifier: "OperatorCapability" })
export type Item = typeof Item.Type

export const Inventory = Schema.Struct({
  scope: Schema.Literals(["project", "namespace"]),
  namespace: Schema.String,
  inheritGlobal: Schema.Boolean,
  items: Schema.Array(Item),
}).annotate({ identifier: "OperatorCapabilities" })
export type Inventory = typeof Inventory.Type

export class ActionError extends Schema.TaggedErrorClass<ActionError>()("OperatorCapabilityAction", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The capabilities of the project in context, or of a namespace on its own. */
  readonly inventory: (input: { namespace?: string }) => Effect.Effect<Inventory>
  /** Copies an inherited capability into the project, to edit there. */
  readonly override: (input: { kind: Kind; name: string }) => Effect.Effect<Item, ActionError>
  /** Turns an inherited capability off in the project. */
  readonly disable: (input: { kind: Kind; name: string }) => Effect.Effect<Item, ActionError>
  /** Removes the project's override (to Trash) or its disable, so the inherited capability applies. */
  readonly revert: (input: { kind: Kind; name: string }) => Effect.Effect<Item, ActionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorCapabilities") {}

type Scope = "global" | "namespace" | "project"
// A place definitions are read from, in load order: a config file, or a config folder.
type Source = { scope: Scope; json?: string; dir?: string }
// A definition found, with what override needs to copy it.
type Found = Definition & { kind: Kind; name: string; root?: string; value?: unknown; description?: string }
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
  const file = (kind: Kind, name: string, location: string, description?: string): Found => ({
    kind,
    name,
    origin: source.scope,
    location,
    root: dir,
    ...(description ? { description } : {}),
  })
  for (const item of await scan("{command,commands}/**/*.md", dir)) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue
    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])
    found.push(file("command", name, item, typeof md.data.description === "string" ? md.data.description : undefined))
  }
  for (const [pattern, prefixes] of [
    ["{agent,agents}/**/*.md", ["agent/", "agents/"]],
    ["{mode,modes}/*.md", ["mode/", "modes/"]],
  ] as const) {
    for (const item of await scan(pattern, dir)) {
      const md = await ConfigMarkdown.parse(item).catch(() => undefined)
      if (!md) continue
      const name = configEntryNameFromPath(path.relative(dir, item), [...prefixes])
      found.push(file("agent", name, item, typeof md.data.description === "string" ? md.data.description : undefined))
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
    const fail = (message: string) => new ActionError({ message })

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

    const inventory = Effect.fn("OperatorCapabilities.inventory")(function* (input: { namespace?: string }) {
      const builtin = yield* builtins()
      if (input.namespace) {
        const scope = yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(input.namespace!))
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
        return {
          scope: "namespace" as const,
          namespace: input.namespace,
          inheritGlobal: scope.inherit,
          items: items("namespace", ordered(read.found, { before: home, after: [] }, builtin), read.off),
        }
      }
      const { ctx, scope, sources } = yield* projectSources()
      const read = yield* collect(sources)
      const external = yield* externalSkills(ctx, scope.inherit)
      return {
        scope: "project" as const,
        namespace: scope.namespace,
        inheritGlobal: scope.inherit,
        items: items("project", ordered(read.found, external, builtin), read.off),
      }
    })

    // The item and every definition of it, for the project in context.
    const lookup = Effect.fnUntraced(function* (input: { kind: Kind; name: string }) {
      const { ctx, scope, sources } = yield* projectSources()
      const read = yield* collect(sources)
      const external = yield* externalSkills(ctx, scope.inherit)
      const all = ordered(read.found, external, yield* builtins())
      const item = items("project", all, read.off).find(
        (found) => found.kind === input.kind && found.name === input.name,
      )
      if (!item) return yield* fail(`No ${input.kind} named ${input.name} here`)
      const definitions = all.filter((found) => found.kind === input.kind && found.name === input.name)
      const off = read.off.filter((found) => found.kind === input.kind && found.name === input.name)
      return { ctx, scope, item, definitions, off }
    })

    const reload = Effect.fnUntraced(function* (project: string) {
      for (const directory of OperatorNamespaceScope.instancesOf({ project })) yield* reloads.want({ directory })
    })

    const patch = (body: Record<string, unknown>) =>
      operatorConfig.update("project", body).pipe(Effect.mapError((error) => fail(error.message)))

    // The project's own config, as written (for lists that are replaced whole).
    const projectConfig = Effect.fnUntraced(function* () {
      const layers = yield* operatorConfig.layers()
      const source = layers.sources.find((item) => item.path === layers.targets.project)
      const value = source ? (parse(source.text) as unknown) : undefined
      return isRecord(value) ? value : {}
    })

    const after = Effect.fnUntraced(function* (input: { kind: Kind; name: string }, project: string) {
      yield* reload(project)
      return (yield* inventory({})).items.find((item) => item.kind === input.kind && item.name === input.name)!
    })

    const override = Effect.fn("OperatorCapabilities.override")(function* (input: { kind: Kind; name: string }) {
      const { ctx, scope, item, definitions } = yield* lookup(input)
      if (item.origin === "project") return yield* fail(`${input.name} is already this project's own`)
      const source = definitions.at(-1)!
      const own = OperatorConfig.scopeDirectory("project", ctx)
      if (source.location === BUILTIN) {
        // OpenCode's own commands can be copied with their text; its agents, tools and skill are code.
        if (input.kind !== "command" || input.name === Command.Default.MERGE)
          return yield* fail(`OpenCode's ${input.kind} ${input.name} can't be copied; disable it, or define your own`)
        const command = yield* commands.get(input.name)
        const template = command ? yield* Effect.promise(async () => String(await command.template)) : ""
        const file = path.join(own, "commands", `${input.name}.md`)
        if (yield* Effect.promise(() => exists(file))) return yield* fail(`${file} exists already`)
        yield* fsys
          .writeWithDirs(file, `---\ndescription: ${JSON.stringify(command?.description ?? "")}\n---\n${template}\n`)
          .pipe(Effect.orDie)
        return yield* after(input, scope.project)
      }
      if (source.root) {
        // A file (or a skill's folder) goes to the same place under the project's .opencode.
        const from = input.kind === "skill" ? path.dirname(source.location) : source.location
        const to = path.join(own, path.relative(source.root, from))
        if (yield* Effect.promise(() => exists(to))) return yield* fail(`${to} exists already`)
        yield* Effect.promise(() => fs.cp(from, to, { recursive: true }))
        return yield* after(input, scope.project)
      }
      if (input.kind === "plugin") {
        const current = yield* projectConfig()
        const list = Array.isArray(current.plugin) ? current.plugin : []
        yield* patch({ plugin: OperatorConfig.whole([...list, source.value]) })
        return yield* after(input, scope.project)
      }
      const section = source.location.slice(source.location.lastIndexOf("#") + 1).split(".")[0]!
      yield* patch({ [section]: { [input.name]: source.value } })
      return yield* after(input, scope.project)
    })

    const disable = Effect.fn("OperatorCapabilities.disable")(function* (input: { kind: Kind; name: string }) {
      const { scope, item } = yield* lookup(input)
      if (item.state === "disabled") return yield* fail(`${input.name} is turned off already`)
      if (input.kind === "command" && input.name === Command.Default.MERGE)
        return yield* fail("/merge is reserved and can't be turned off")
      if (input.kind === "mcp") yield* patch({ mcp: { [input.name]: { enabled: false } } })
      if (input.kind === "agent") yield* patch({ agent: { [input.name]: { disable: true } } })
      if (input.kind === "tool") yield* patch({ permission: { [input.name]: "deny" } })
      if (input.kind === "skill") {
        const current = yield* projectConfig()
        const permission = isRecord(current.permission) ? current.permission : {}
        const skill = permission.skill
        const next = isRecord(skill)
          ? { ...skill, [input.name]: "deny" }
          : typeof skill === "string"
            ? { "*": skill, [input.name]: "deny" }
            : { [input.name]: "deny" }
        yield* patch({ permission: { skill: OperatorConfig.whole(next) } })
      }
      if (input.kind === "command" || input.kind === "plugin") {
        const list = input.kind === "command" ? "commands" : "plugins"
        const current = OperatorCapabilitySwitches.disabledList(yield* projectConfig(), list)
        yield* patch({ capabilities: { disabled: { [list]: OperatorConfig.whole([...current, input.name]) } } })
      }
      return yield* after(input, scope.project)
    })

    const revert = Effect.fn("OperatorCapabilities.revert")(function* (input: { kind: Kind; name: string }) {
      const { ctx, scope, item, definitions, off } = yield* lookup(input)
      const own = off.findLast((found) => found.origin === "project")
      if (own) {
        // The project's switch goes; anything else in the entry stays.
        // An entry that only held the switch goes with it.
        const entry = (section: "mcp" | "agent", key: string) =>
          Effect.gen(function* () {
            const current = yield* projectConfig()
            const value = isRecord(current[section]) ? current[section][input.name] : undefined
            const only = isRecord(value) && Object.keys(value).every((item) => item === key)
            yield* patch({ [section]: { [input.name]: only ? null : { [key]: null } } })
          })
        if (input.kind === "mcp") yield* entry("mcp", "enabled")
        if (input.kind === "agent") yield* entry("agent", "disable")
        if (input.kind === "tool") yield* patch({ permission: { [input.name]: null } })
        if (input.kind === "skill") yield* patch({ permission: { skill: { [input.name]: null } } })
        if (input.kind === "command" || input.kind === "plugin") {
          const list = input.kind === "command" ? "commands" : "plugins"
          const current = OperatorCapabilitySwitches.disabledList(yield* projectConfig(), list).filter(
            (name) => name !== input.name,
          )
          yield* patch({
            capabilities: { disabled: { [list]: current.length ? OperatorConfig.whole(current) : null } },
          })
        }
        return yield* after(input, scope.project)
      }
      if (item.state !== "overridden") return yield* fail(`${input.name} has no override or switch in this project`)
      const copy = definitions.at(-1)!
      if (copy.root) {
        const target = input.kind === "skill" ? path.dirname(copy.location) : copy.location
        yield* Effect.promise(() =>
          OperatorTrashFiles.put({ kind: input.kind, name: input.name, project: ctx.directory, paths: [target] }),
        )
        return yield* after(input, scope.project)
      }
      if (input.kind === "plugin") {
        const current = yield* projectConfig()
        const list = (Array.isArray(current.plugin) ? current.plugin : []).filter((entry) => {
          const spec = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined
          return typeof spec !== "string" || OperatorCapabilitySwitches.pluginName(spec) !== input.name
        })
        yield* patch({ plugin: list.length ? OperatorConfig.whole(list) : null })
        return yield* after(input, scope.project)
      }
      const section = copy.location.slice(copy.location.lastIndexOf("#") + 1).split(".")[0]!
      yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: input.kind,
          name: input.name,
          project: ctx.directory,
          config: { scope: "project", key: [section, input.name], value: copy.value },
        }),
      )
      yield* patch({ [section]: { [input.name]: null } })
      return yield* after(input, scope.project)
    })

    return Service.of({ inventory, override, disable, revert })
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
  ],
})
