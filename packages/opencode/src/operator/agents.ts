export * as OperatorAgents from "./agents"

import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { count, eq, max } from "drizzle-orm"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { configEntryNameFromPath } from "@/config/entry-name"
import { InstanceState } from "@/effect/instance-state"
import { OperatorProjects } from "./projects"
import { OperatorConfig } from "./config"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorProfileStore } from "./profile-store"
import { OperatorScopes } from "./scopes"
import { OperatorProjectConfig } from "./project-config"
import { OperatorModels } from "./models"
import { OperatorSmallAgentNotes } from "./small-agent-notes"
import { OperatorTrashFiles } from "./trash-files"

export const Source = Schema.Struct({
  kind: Schema.Literals(["builtin", "config", "file"]),
  path: Schema.optional(Schema.String).annotate({ description: "The markdown file that defines the agent" }),
  customized: Schema.Boolean.annotate({ description: "A built-in agent that config or a file changes" }),
}).annotate({ identifier: "OperatorAgentSource" })

// Where an agent is defined (agent_form_spec.md §1, the form's "Saved in"): OpenCode's own, Global's folder or
// config (every namespace that inherits Global), a namespace's (every project in it), this project, or the
// environment (OPENCODE_CONFIG and its kind).
export const Level = Schema.Struct({
  kind: Schema.Literals(["builtin", "global", "namespace", "project", "environment"]),
  namespace: Schema.optional(Schema.String).annotate({ description: "A namespace's agent: the namespace's id" }),
}).annotate({ identifier: "OperatorAgentLevel" })
export type Level = typeof Level.Type

export const Info = Schema.Struct({
  ...Agent.Info.fields,
  source: Source,
  level: Level,
  home: Schema.optional(Schema.String).annotate({ description: "Folder new sessions as this agent open in" }),
  disabled: Schema.Boolean.annotate({ description: "Turned off with `disable: true`; such agents cannot be used" }),
  settings: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "The agent's own settings as written in config or its file, before defaults are applied",
  }),
  sessions: Schema.Struct({ total: Schema.Finite, lastUsed: Schema.optional(Schema.Finite) }).annotate({
    description: "Sessions in this project that use the agent",
  }),
  modelSource: Schema.optional(OperatorModels.Source).annotate({
    description: "The model the agent's requests use, and where it is set (not for turned-off agents)",
  }),
  variantCleared: Schema.optional(
    Schema.Struct({ variant: Schema.String, model: Schema.String, at: Schema.Finite }).annotate({
      identifier: "OperatorAgentVariantCleared",
    }),
  ).annotate({
    description: "An agent on the small model: the variant cleared when the small model changed to one without it",
  }),
}).annotate({ identifier: "OperatorAgent" })
export type Info = typeof Info.Type

// Settings an agent can be created or edited with, in config/frontmatter form.
export const ResetKey = Schema.Literals([
  "description",
  "mode",
  "model",
  "modelSource",
  "subagentMemory",
  "variant",
  "temperature",
  "top_p",
  "steps",
  "color",
  "hidden",
  "disable",
  "home",
  "prompt",
  "permission",
])
export type ResetKey = typeof ResetKey.Type

// Not named in the API document, so the generated client takes these as flat parameters.
export const Patch = Schema.Struct({
  description: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
  model: Schema.optional(Schema.String).annotate({ description: "provider/model" }),
  modelSource: Schema.optional(Schema.Literals(["small", "fixed"])).annotate({
    description:
      "small: the agent runs on its project's small model (its `model` is filled in and kept in step); fixed or unset: `model` as given",
  }),
  subagentMemory: Schema.optional(Schema.Literals(["incognito", "retentive"])).annotate({
    description: "A subagent's Flavor: incognito (default) or retentive",
  }),
  variant: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  steps: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  color: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  disable: Schema.optional(Schema.Boolean),
  home: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  permission: Schema.optional(ConfigPermissionV1.Info),
  reset: Schema.optional(Schema.Array(ResetKey)).annotate({
    description: "Settings to remove so their defaults apply",
  }),
})
type Fields = typeof Patch.Type

// How a new agent is saved: an agent file (`agents/<name>.md`, its prompt as the body) or an entry in
// the config file (`agent.<name>`).
export const Format = Schema.Literals(["file", "config"]).annotate({ identifier: "OperatorAgentFormat" })
export type Format = typeof Format.Type

// Where an agent's prompt comes from: its agent file, `agent.<name>.prompt` in a config file,
// OpenCode's own definition of a built-in agent, or nowhere (the agent has no prompt).
export type PromptOrigin = { kind: "file" | "config" | "builtin" | "none"; path?: string }

export const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)).annotate({
  description: "Letters, digits, dots, dashes and underscores; used as the file name",
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorAgentNotFound", {
  message: Schema.String,
}) {}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("OperatorAgentConflict", {
  message: Schema.String,
}) {}
export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorAgentInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  /** The agent's file, when it has one (cheaper than list: no models, no session counts). */
  readonly fileOf: (name: string) => Effect.Effect<string | undefined>
  /** Writes a new agent at the scope, as an agent file or a config entry; returns the file written. */
  readonly create: (
    scope: OperatorConfig.WriteScope,
    name: string,
    patch: Fields,
    format?: Format,
  ) => Effect.Effect<
    string,
    ConflictError | InvalidError | OperatorConfig.InvalidError | OperatorProjectConfig.CopyNeededError
  >
  /** Where the agent's prompt comes from. */
  readonly promptOrigin: (name: string) => Effect.Effect<PromptOrigin>
  /** Edits the agent's file, or for built-in and config agents, its `agent.<name>` config at the scope. */
  readonly update: (
    scope: OperatorConfig.WriteScope,
    name: string,
    patch: Fields,
  ) => Effect.Effect<
    string,
    NotFoundError | InvalidError | OperatorConfig.InvalidError | OperatorProjectConfig.CopyNeededError
  >
  /** Deletes the agent's file or config entry. Built-in agents can only be turned off. */
  readonly remove: (
    scope: OperatorConfig.WriteScope,
    name: string,
  ) => Effect.Effect<
    string,
    NotFoundError | InvalidError | OperatorConfig.InvalidError | OperatorProjectConfig.CopyNeededError
  >
  /**
   * Moves an agent to another project (agent_form_spec.md §1, §7): its definition becomes an agent file there, with
   * its prompt setting (profile, override), and leaves where it was. Its sessions stay. Returns the new file and the
   * level it left.
   */
  readonly move: (
    name: string,
    project: string,
  ) => Effect.Effect<
    { path: string; from: Level },
    NotFoundError | ConflictError | InvalidError | OperatorConfig.InvalidError | OperatorProjectConfig.CopyNeededError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorAgents") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const operatorConfig = yield* OperatorConfig.Service
    const models = yield* OperatorModels.Service
    const store = yield* OperatorProfileStore.Service
    const db = (yield* Database.Service).db

    // The level a definition file belongs to, and a config agent's: the last config source defining it.
    const levelOfScope = (scope: OperatorScopes.Scope): Level =>
      scope.kind === "namespace"
        ? { kind: "namespace", namespace: scope.namespace }
        : scope.kind === "global"
          ? { kind: "global" }
          : scope.kind === "environment"
            ? { kind: "environment" }
            : { kind: "project" }
    const configLevels = Effect.fnUntraced(function* (names: ReadonlyArray<string>) {
      const found = new Map<string, Level>()
      if (!names.length) return found
      const layers = yield* operatorConfig.layers()
      for (const source of layers.sources) {
        const data = parse(source.text) as
          | { agent?: Record<string, unknown>; mode?: Record<string, unknown> }
          | undefined
        for (const name of names) {
          if (!data?.agent?.[name] && !data?.mode?.[name]) continue
          found.set(
            name,
            source.kind === "global"
              ? { kind: "global" }
              : source.kind === "namespace"
                ? { kind: "namespace", namespace: layers.namespace }
                : source.kind === "env"
                  ? { kind: "environment" }
                  : { kind: "project" },
          )
        }
      }
      return found
    })

    // Same discovery as ConfigAgent.load/loadMode; later directories win, as they do when config merges.
    const files = Effect.fnUntraced(function* () {
      const found = yield* Effect.forEach(yield* config.directories(), (dir) =>
        Effect.promise(async () => {
          const agentFiles = await Glob.scan("{agent,agents}/**/*.md", {
            cwd: dir,
            absolute: true,
            dot: true,
            symlink: true,
          })
          const modeFiles = await Glob.scan("{mode,modes}/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })
          return [
            ...agentFiles.map(
              (file) => [configEntryNameFromPath(path.relative(dir, file), ["agent/", "agents/"]), file] as const,
            ),
            ...modeFiles.map(
              (file) => [configEntryNameFromPath(path.relative(dir, file), ["mode/", "modes/"]), file] as const,
            ),
          ]
        }),
      )
      return new Map(found.flat())
    })

    const list = Effect.fn("OperatorAgents.list")(function* () {
      const ctx = yield* InstanceState.context
      const paths = yield* files()
      const configured = { ...(yield* config.get()).agent } as Record<
        string,
        ({ home?: string; disable?: boolean } & Record<string, unknown>) | undefined
      >
      const usage = yield* db
        .select({ agent: SessionTable.agent, total: count(), lastUsed: max(SessionTable.time_updated) })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, ctx.project.id))
        .groupBy(SessionTable.agent)
        .all()
        .pipe(Effect.orDie)
      const byAgent = new Map(usage.map((row) => [row.agent, row]))
      const sessions = (name: string) => {
        const used = byAgent.get(name)
        return { total: used?.total ?? 0, lastUsed: used?.lastUsed ?? undefined }
      }
      // Agents on the small model whose variant was cleared when the small model changed (small-agents.ts).
      const notes = yield* Effect.promise(() => OperatorSmallAgentNotes.forProject(OperatorConfig.projectRoot(ctx)))
      const cleared = (name: string) =>
        configured[name]?.modelSource === "small" && notes[name] ? { variantCleared: notes[name] } : {}
      const layout = yield* Effect.promise(() => OperatorScopes.layout([OperatorConfig.projectRoot(ctx)]))
      const all = yield* agents.list()
      const inConfig = yield* configLevels([
        ...all.filter((agent) => !agent.native && !paths.has(agent.name)).map((agent) => agent.name),
        ...Object.keys(configured).filter((name) => configured[name]?.disable && !paths.has(name)),
      ])
      const levelOf = (name: string, native: boolean): Level => {
        if (native) return { kind: "builtin" }
        const file = paths.get(name)
        if (file) return levelOfScope(OperatorScopes.classify(file, layout))
        return inConfig.get(name) ?? { kind: "project" }
      }
      const active = yield* Effect.forEach(all, (agent) => {
        const file = paths.get(agent.name)
        return models.resolve(agent, file).pipe(
          Effect.map((modelSource) => ({
            ...cleared(agent.name),
            ...agent,
            source: {
              kind: agent.native ? ("builtin" as const) : file ? ("file" as const) : ("config" as const),
              path: file,
              customized: !!agent.native && (!!file || agent.name in configured),
            },
            level: levelOf(agent.name, !!agent.native),
            home: configured[agent.name]?.home,
            disabled: false,
            settings: configured[agent.name] ?? {},
            sessions: sessions(agent.name),
            modelSource,
          })),
        )
      })
      // Turned-off agents are dropped by the agent service; list them so they can be turned back on.
      const disabled = Object.entries(configured)
        .filter(([name, value]) => value?.disable && !active.some((agent) => agent.name === name))
        .map(([name, value]) => ({
          name,
          mode: "all" as const,
          permission: [],
          options: {},
          source: {
            kind: paths.has(name) ? ("file" as const) : ("config" as const),
            path: paths.get(name),
            customized: false,
          },
          level: levelOf(name, false),
          home: value?.home,
          disabled: true,
          settings: value ?? {},
          sessions: sessions(name),
        }))
      return [...active, ...disabled]
    })

    const write = (file: string, data: Record<string, unknown>, prompt: string) =>
      Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, matter.stringify(prompt ? `${prompt.trim()}\n` : "", data))
      })

    // A home folder must be inside the agent's project: its sessions belong to that project.
    const ensureHome = (home: string | null | undefined) =>
      Effect.gen(function* () {
        if (!home) return
        const ctx = yield* InstanceState.context
        const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
        const folder = path.resolve(project, home)
        if (folder !== project && !folder.startsWith(project.endsWith(path.sep) ? project : project + path.sep))
          return yield* new InvalidError({
            message: `The home folder ${folder} is outside the project ${project}; it must be inside it`,
          })
        yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }))
      })

    // The folder an agent file goes in: Global's, the namespace folder's `.opencode` (this project's namespace; Global
    // has none: its agents are Global's), or the project's `.opencode`.
    const folderOf = Effect.fnUntraced(function* (scope: OperatorConfig.WriteScope) {
      const ctx = yield* InstanceState.context
      if (scope !== "namespace") return OperatorConfig.scopeDirectory(scope, ctx)
      const layer = yield* Effect.promise(() => OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree))
      const found = yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(layer.namespace))
      if (found.global || !found.target)
        return yield* new InvalidError({
          message: "Global has no namespace folder of its own: save the agent in Global",
        })
      return found.target
    })
    // A namespace's agent serves every project in it, each with its own small model: it can't follow one.
    const checkScope = (scope: OperatorConfig.WriteScope, patch: Fields) =>
      scope === "namespace" && patch.modelSource === "small"
        ? new InvalidError({
            message: "An agent of a whole namespace can't use the Small model (each project has its own): pick a model",
          })
        : undefined

    const create = Effect.fn("OperatorAgents.create")(function* (
      scope: OperatorConfig.WriteScope,
      name: string,
      patch: Fields,
      format: Format = "file",
    ) {
      if (!Schema.is(Name)(name)) return yield* new InvalidError({ message: `"${name}" is not a valid agent name` })
      if ((yield* list()).some((agent) => agent.name === name))
        return yield* new ConflictError({ message: `An agent named "${name}" already exists` })
      const refused = checkScope(scope, patch)
      if (refused) return yield* refused
      const values = present(settings(patch))
      // Its home is inside each project it runs in: made here for a project's agent (and Global's, as before).
      const home = scope === "namespace" ? Effect.void : ensureHome(patch.home)
      if (format === "config") {
        yield* home
        return (yield* operatorConfig.update(scope, { agent: { [name]: values } })).path
      }
      const file = path.join(yield* folderOf(scope), "agents", `${name}.md`)
      yield* write(file, omitPrompt(values), String(values.prompt ?? ""))
      yield* home
      return file
    })

    // The agent's prompt is matched against its agent file's body and each config file's
    // `agent.<name>.prompt`; the one that holds the same text is where it comes from. A file or config
    // prompt that is written differently (a `{file:…}` reference) still counts, the file first.
    const promptOrigin = Effect.fn("OperatorAgents.promptOrigin")(function* (name: string) {
      const agent: Info | undefined = (yield* list()).find((item) => item.name === name)
      const prompt = agent?.prompt?.trim()
      if (!agent || !prompt) return { kind: "none" as const }
      const file = agent.source.path
      const body = file
        ? yield* Effect.promise(() =>
            fs
              .readFile(file, "utf8")
              .then((text) => matter(text).content.trim())
              .catch(() => ""),
          )
        : ""
      const configs = (yield* operatorConfig.layers()).sources.flatMap((source) => {
        const value = (parse(source.text) as { agent?: Record<string, { prompt?: unknown } | undefined> } | undefined)
          ?.agent?.[name]?.prompt
        return typeof value === "string" ? [{ path: source.path, text: value.trim() }] : []
      })
      if (file && body === prompt) return { kind: "file" as const, path: file }
      const config = configs.findLast((item) => item.text === prompt)
      if (config) return { kind: "config" as const, path: config.path }
      if (file && body) return { kind: "file" as const, path: file }
      if (configs.length) return { kind: "config" as const, path: configs.at(-1)!.path }
      return agent.native ? { kind: "builtin" as const } : { kind: "none" as const }
    })

    const update = Effect.fn("OperatorAgents.update")(function* (
      scope: OperatorConfig.WriteScope,
      name: string,
      patch: Fields,
    ) {
      const agent = (yield* list()).find((item) => item.name === name)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      const refused = checkScope(agent.level.kind === "namespace" ? "namespace" : scope, patch)
      if (refused) return yield* refused
      if (agent.level.kind !== "namespace") yield* ensureHome(patch.home)
      if (agent.source.kind === "file" && agent.source.path) {
        const file = agent.source.path
        const current = matter(yield* Effect.promise(() => fs.readFile(file, "utf8")))
        const changes = settings(patch)
        const data = present({ ...current.data, ...changes })
        // A new prompt replaces the body, a reset prompt empties it, and otherwise the body is kept.
        const prompt =
          typeof changes.prompt === "string" ? changes.prompt : changes.prompt === null ? "" : current.content
        yield* write(file, omitPrompt(data), prompt)
        return file
      }
      const values = settings(patch)
      // Rules are written as a whole: merged, removed rules would stay and the order would not change.
      if (values.permission) values.permission = OperatorConfig.whole(values.permission)
      return (yield* operatorConfig.update(scope, { agent: { [name]: values } })).path
    })

    const remove = Effect.fn("OperatorAgents.remove")(function* (scope: OperatorConfig.WriteScope, name: string) {
      const agent = (yield* list()).find((item) => item.name === name)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      if (agent.source.kind === "builtin")
        return yield* new InvalidError({ message: `"${name}" is built in; turn it off instead of deleting it` })
      // To Trash: the agent's file, or its config entry (kept, to write back on restore).
      const ctx = yield* InstanceState.context
      if (agent.source.kind === "file" && agent.source.path) {
        const file = agent.source.path
        yield* Effect.promise(() =>
          OperatorTrashFiles.put({ kind: "agent", name, project: ctx.directory, paths: [file] }),
        )
        return file
      }
      const result = yield* operatorConfig.update(scope, { agent: { [name]: null } })
      yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: "agent",
          name,
          project: ctx.directory,
          config: { scope, key: ["agent", name], value: agent.settings },
        }),
      )
      return result.path
    })

    const fileOf = Effect.fn("OperatorAgents.fileOf")(function* (name: string) {
      return (yield* files()).get(name)
    })

    const move = Effect.fn("OperatorAgents.move")(function* (name: string, project: string) {
      const agent = (yield* list()).find((item) => item.name === name)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      if (agent.level.kind === "builtin")
        return yield* new InvalidError({ message: `"${name}" is built in: it is part of every project` })
      if (agent.level.kind === "environment")
        return yield* new InvalidError({ message: `"${name}" is set by the environment: it can't be moved` })
      const ctx = yield* InstanceState.context
      const here = OperatorConfig.projectRoot(ctx)
      const target = path.resolve(project)
      const found = yield* Effect.promise(() => OperatorProjects.projectOf(target))
      if (!found || found.key !== target) return yield* new InvalidError({ message: `${target} is not a project` })
      if (target === here && agent.level.kind === "project")
        return yield* new InvalidError({ message: `"${name}" is already this project's agent` })
      const file = path.join(target, ".opencode", "agents", `${name}.md`)
      if (
        yield* Effect.promise(() =>
          fs.stat(file).then(
            () => true,
            () => false,
          ),
        )
      )
        return yield* new ConflictError({ message: `${target} has an agent "${name}" already` })
      // Its definition as it is: its file's, else its config entry's (the prompt becomes the file's body).
      const definition =
        agent.source.kind === "file" && agent.source.path
          ? matter(yield* Effect.promise(() => fs.readFile(agent.source.path!, "utf8")))
          : undefined
      const data = definition ? { ...definition.data } : present({ ...agent.settings })
      const prompt = definition ? definition.content : String(data.prompt ?? "")
      yield* write(file, omitPrompt(data), prompt)
      // It leaves where it was: its file goes, or its config entry.
      if (agent.source.kind === "file" && agent.source.path)
        yield* Effect.promise(() => fs.rm(agent.source.path!, { force: true }))
      else {
        const scope =
          agent.level.kind === "global" ? "global" : agent.level.kind === "namespace" ? "namespace" : "project"
        yield* operatorConfig.update(scope, { agent: { [name]: null } })
      }
      // Its prompt setting goes with it, when the target's namespace has its profile.
      const setting = yield* store.agent(here, name)
      if (Object.keys(setting).length) yield* store.setAgent(target, name, setting).pipe(Effect.ignore)
      return { path: file, from: agent.level }
    })

    return Service.of({ list, fileOf, create, promptOrigin, update, remove, move })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Config.node, OperatorConfig.node, OperatorModels.node, OperatorProfileStore.node, Database.node],
})

// The patch as config/frontmatter values: reset settings become null, which removes them.
function settings(patch: Fields): Record<string, unknown> {
  const { reset, ...values } = patch
  return { ...values, ...Object.fromEntries((reset ?? []).map((key) => [key, null])) }
}

// Drops unset and null values, which mean "use the default" in a new or rewritten file.
function present(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null))
}

function omitPrompt(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key !== "prompt"))
}
