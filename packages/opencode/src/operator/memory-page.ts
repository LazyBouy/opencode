export * as OperatorMemoryPage from "./memory-page"

import fs from "fs/promises"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { OperatorLayout } from "./layout"
import { OperatorMemoryFolders } from "./memory-folders"
import { OperatorMemoryFormat as M } from "./memory-format"
import { OperatorMemoryStore } from "./memory-store"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
import { OperatorTrashFiles } from "./trash-files"

// The Memory page's Memory tab (specs/docs/feedbacks/memory/memory_spec.md §8): a project's three levels
// (the agent level for a chosen agent), each memory's file, and edits by the user with the same code the
// memory tool uses (memory-store.ts): new, edit, delete (to Trash), and MEMORY.md as text.

export const LevelName = Schema.Literals(OperatorMemoryFolders.LEVELS).annotate({
  identifier: "OperatorMemoryLevelName",
})

export const Entry = Schema.Struct({
  title: Schema.String,
  file: Schema.String,
  description: Schema.String,
  line: Schema.Finite.annotate({ description: "Its line in MEMORY.md" }),
  created: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
  by: Schema.optional(Schema.String).annotate({ description: "The agent and session that wrote it, or user" }),
}).annotate({ identifier: "OperatorMemoryEntry" })

export const Level = Schema.Struct({
  level: LevelName,
  folder: Schema.String,
  exists: Schema.Boolean.annotate({ description: "Whether its MEMORY.md exists" }),
  entries: Schema.Array(Entry),
  invalid: Schema.Array(Schema.Struct({ line: Schema.Finite, text: Schema.String })).annotate({
    description: "Lines of MEMORY.md that are not memory entries (kept, flagged)",
  }),
  unindexed: Schema.Array(Schema.String).annotate({ description: "Memory files no line of MEMORY.md names" }),
  lines: Schema.Finite.annotate({ description: "The index's entry lines" }),
  chars: Schema.Finite.annotate({ description: "The index's characters, as prompts count them" }),
}).annotate({ identifier: "OperatorMemoryLevel" })

export const Levels = Schema.Struct({
  project: Schema.String,
  namespace: Schema.Struct({ id: Schema.String, name: Schema.String }),
  instructions: Schema.Boolean.annotate({
    description: "Whether instruction files (AGENTS.md, …) apply to the project: the OpenCode and Global namespaces",
  }),
  agent: Schema.optional(Schema.String).annotate({ description: "The agent whose agent level is shown" }),
  limits: Schema.Struct({ lines: Schema.Finite, chars: Schema.Finite }),
  levels: Schema.Array(Level),
}).annotate({ identifier: "OperatorMemoryLevels" })
export type Levels = typeof Levels.Type

export const Detail = Schema.Struct({
  level: LevelName,
  file: Schema.String,
  path: Schema.String,
  title: Schema.String,
  description: Schema.String,
  created: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
  by: Schema.optional(Schema.String),
  content: Schema.String,
}).annotate({ identifier: "OperatorMemoryDetail" })

export const SaveInput = Schema.Struct({
  level: LevelName,
  agent: Schema.optional(Schema.String).annotate({ description: "The agent level's agent" }),
  file: Schema.optional(Schema.String).annotate({ description: "A memory to change; none: a new one" }),
  title: Schema.String,
  description: Schema.String,
  content: Schema.String,
})

export const IndexInput = Schema.Struct({
  level: LevelName,
  agent: Schema.optional(Schema.String),
  text: Schema.String,
})

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorMemoryInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly levels: (agent?: string) => Effect.Effect<Levels>
  readonly entry: (input: {
    level: OperatorMemoryFolders.Level
    file: string
    agent?: string
  }) => Effect.Effect<typeof Detail.Type, InvalidError>
  readonly save: (input: typeof SaveInput.Type) => Effect.Effect<typeof Detail.Type, InvalidError>
  readonly forget: (input: {
    level: OperatorMemoryFolders.Level
    file: string
    agent?: string
  }) => Effect.Effect<void, InvalidError>
  readonly writeIndex: (input: typeof IndexInput.Type) => Effect.Effect<typeof Level.Type, InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorMemoryPage") {}

const DEFAULT_AGENT = "build"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    // The project's folders, the agent's from its home.
    const where = Effect.fnUntraced(function* (agent: string | undefined) {
      const ctx = yield* InstanceState.context
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const name = agent ?? DEFAULT_AGENT
      const home = (yield* config.get()).agent?.[name]?.home
      const folders = yield* Effect.promise(() =>
        OperatorMemoryFolders.of({ project, agent: { name, ...(home ? { home } : {}) } }),
      )
      const folderOf = (level: OperatorMemoryFolders.Level) =>
        level === "namespace" ? folders.namespace.folder : level === "project" ? folders.project : folders.agent!
      return { project, agent: name, folders, folderOf }
    })

    const fail = (error: unknown) =>
      new InvalidError({ message: error instanceof Error ? error.message : String(error) })

    const levelOf = (level: OperatorMemoryFolders.Level, folder: string) =>
      Effect.promise(async (): Promise<typeof Level.Type> => {
        const listed = await OperatorMemoryStore.list(folder)
        const entries = await Promise.all(
          listed.entries.map(async (entry) => {
            const detail = await OperatorMemoryStore.read(folder, entry.file).catch(() => undefined)
            return {
              title: entry.title,
              file: entry.file,
              description: entry.description,
              line: entry.line,
              ...(detail?.detail.created ? { created: detail.detail.created } : {}),
              ...(detail?.detail.updated ? { updated: detail.detail.updated } : {}),
              ...(detail?.detail.by ? { by: detail.detail.by } : {}),
            }
          }),
        )
        const named = new Set(listed.entries.map((entry) => entry.file))
        const files = await fs.readdir(folder).catch(() => [] as string[])
        const lines = listed.entries.map((entry) => M.formatLine(entry))
        return {
          level,
          folder,
          exists: listed.exists,
          entries,
          invalid: [...listed.invalid],
          unindexed: files.filter((file) => M.isFileName(file) && !named.has(file)).toSorted(),
          lines: lines.length,
          chars: lines.join("\n").length,
        }
      })

    const levels = Effect.fn("OperatorMemoryPage.levels")(function* (agent?: string) {
      const found = yield* where(agent)
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const id = found.folders.namespace.id
      const record = yield* Effect.promise(() => OperatorProfileStore.readNamespace(id))
      const settings = yield* Effect.promise(() => OperatorMemoryFolders.settings())
      return {
        project: found.project,
        namespace: { id, name: record?.namespace.name ?? id },
        instructions: id === OperatorLayout.OPENCODE || OperatorLayout.isGlobal(id, layout),
        agent: found.agent,
        limits: { lines: settings.indexLines, chars: settings.indexChars },
        levels: yield* Effect.forEach(OperatorMemoryFolders.LEVELS, (level) => levelOf(level, found.folderOf(level))),
      }
    })

    const detailOf = (level: OperatorMemoryFolders.Level, folder: string, file: string) =>
      Effect.tryPromise({ try: () => OperatorMemoryStore.read(folder, file), catch: fail }).pipe(
        Effect.map((read) => ({
          level,
          file,
          path: read.path,
          title: read.detail.title ?? file,
          description: read.detail.description ?? "",
          ...(read.detail.created ? { created: read.detail.created } : {}),
          ...(read.detail.updated ? { updated: read.detail.updated } : {}),
          ...(read.detail.by ? { by: read.detail.by } : {}),
          content: read.detail.content,
        })),
      )

    const entry = Effect.fn("OperatorMemoryPage.entry")(function* (input: {
      level: OperatorMemoryFolders.Level
      file: string
      agent?: string
    }) {
      const found = yield* where(input.agent)
      return yield* detailOf(input.level, found.folderOf(input.level), input.file)
    })

    const save = Effect.fn("OperatorMemoryPage.save")(function* (input: typeof SaveInput.Type) {
      const found = yield* where(input.agent)
      const folder = found.folderOf(input.level)
      const saved = yield* Effect.tryPromise({
        try: () =>
          input.file
            ? OperatorMemoryStore.update({
                folder,
                project: found.project,
                level: input.level,
                file: input.file,
                title: input.title,
                description: input.description,
                content: input.content,
                by: "user",
              })
            : OperatorMemoryStore.save({
                folder,
                project: found.project,
                level: input.level,
                title: input.title,
                description: input.description,
                content: input.content,
                by: "user",
              }),
        catch: fail,
      })
      return yield* detailOf(input.level, folder, saved.file)
    })

    const forget = Effect.fn("OperatorMemoryPage.forget")(function* (input: {
      level: OperatorMemoryFolders.Level
      file: string
      agent?: string
    }) {
      const found = yield* where(input.agent)
      const folder = found.folderOf(input.level)
      const detail = yield* detailOf(input.level, folder, input.file)
      yield* Effect.tryPromise({
        try: () =>
          OperatorMemoryStore.forget({
            folder,
            file: input.file,
            trash: (file) =>
              OperatorTrashFiles.put({
                kind: "memory",
                name: `${detail.title} (${input.level} memory)`,
                project: found.project,
                paths: [file],
              }),
          }),
        catch: fail,
      })
    })

    const writeIndex = Effect.fn("OperatorMemoryPage.writeIndex")(function* (input: typeof IndexInput.Type) {
      const found = yield* where(input.agent)
      const folder = found.folderOf(input.level)
      yield* Effect.tryPromise({
        try: () => OperatorMemoryStore.writeIndex({ folder, project: found.project, text: input.text }),
        catch: fail,
      })
      return yield* levelOf(input.level, folder)
    })

    return Service.of({ levels, entry, save, forget, writeIndex })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node] })
