export * as OperatorAgents from "./agents"

import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { count, eq, max } from "drizzle-orm"
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

export const Source = Schema.Struct({
  kind: Schema.Literals(["builtin", "config", "file"]),
  path: Schema.optional(Schema.String).annotate({ description: "The markdown file that defines the agent" }),
  customized: Schema.Boolean.annotate({ description: "A built-in agent that config or a file changes" }),
}).annotate({ identifier: "OperatorAgentSource" })

export const Info = Schema.Struct({
  ...Agent.Info.fields,
  source: Source,
  home: Schema.optional(Schema.String).annotate({ description: "Folder new sessions as this agent open in" }),
  disabled: Schema.Boolean.annotate({ description: "Turned off with `disable: true`; such agents cannot be used" }),
  settings: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "The agent's own settings as written in config or its file, before defaults are applied",
  }),
  sessions: Schema.Struct({ total: Schema.Finite, lastUsed: Schema.optional(Schema.Finite) }).annotate({
    description: "Sessions in this project that use the agent",
  }),
}).annotate({ identifier: "OperatorAgent" })
export type Info = typeof Info.Type

// Settings an agent can be created or edited with, in config/frontmatter form.
export const ResetKey = Schema.Literals([
  "description",
  "mode",
  "model",
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
  /** Writes a new agent file at the scope; returns its path. */
  readonly create: (
    scope: OperatorConfig.Scope,
    name: string,
    patch: Fields,
  ) => Effect.Effect<string, ConflictError | InvalidError | OperatorConfig.InvalidError>
  /** Edits the agent's file, or for built-in and config agents, its `agent.<name>` config at the scope. */
  readonly update: (
    scope: OperatorConfig.Scope,
    name: string,
    patch: Fields,
  ) => Effect.Effect<string, NotFoundError | InvalidError | OperatorConfig.InvalidError>
  /** Deletes the agent's file or config entry. Built-in agents can only be turned off. */
  readonly remove: (
    scope: OperatorConfig.Scope,
    name: string,
  ) => Effect.Effect<string, NotFoundError | InvalidError | OperatorConfig.InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorAgents") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const operatorConfig = yield* OperatorConfig.Service
    const db = (yield* Database.Service).db

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
      const active = (yield* agents.list()).map((agent) => {
        const file = paths.get(agent.name)
        return {
          ...agent,
          source: {
            kind: agent.native ? ("builtin" as const) : file ? ("file" as const) : ("config" as const),
            path: file,
            customized: !!agent.native && (!!file || agent.name in configured),
          },
          home: configured[agent.name]?.home,
          disabled: false,
          settings: configured[agent.name] ?? {},
          sessions: sessions(agent.name),
        }
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

    const create = Effect.fn("OperatorAgents.create")(function* (
      scope: OperatorConfig.Scope,
      name: string,
      patch: Fields,
    ) {
      if (!Schema.is(Name)(name)) return yield* new InvalidError({ message: `"${name}" is not a valid agent name` })
      if ((yield* list()).some((agent) => agent.name === name))
        return yield* new ConflictError({ message: `An agent named "${name}" already exists` })
      const file = path.join(OperatorConfig.scopeDirectory(scope, yield* InstanceState.context), "agents", `${name}.md`)
      const values = present(settings(patch))
      yield* write(file, omitPrompt(values), String(values.prompt ?? ""))
      yield* ensureHome(patch.home)
      return file
    })

    const update = Effect.fn("OperatorAgents.update")(function* (
      scope: OperatorConfig.Scope,
      name: string,
      patch: Fields,
    ) {
      const agent = (yield* list()).find((item) => item.name === name)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      yield* ensureHome(patch.home)
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
      return (yield* operatorConfig.update(scope, { agent: { [name]: settings(patch) } })).path
    })

    const remove = Effect.fn("OperatorAgents.remove")(function* (scope: OperatorConfig.Scope, name: string) {
      const agent = (yield* list()).find((item) => item.name === name)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      if (agent.source.kind === "builtin")
        return yield* new InvalidError({ message: `"${name}" is built in; turn it off instead of deleting it` })
      if (agent.source.kind === "file" && agent.source.path) {
        const file = agent.source.path
        yield* Effect.promise(() => fs.rm(file, { force: true }))
        return file
      }
      return (yield* operatorConfig.update(scope, { agent: { [name]: null } })).path
    })

    return Service.of({ list, create, update, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Config.node, OperatorConfig.node, Database.node],
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
