export * as OperatorMemory from "./memory"

import fs from "fs/promises"
import path from "path"
import { glob } from "glob"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Instruction } from "@/session/instruction"
import { Skill } from "@/skill"
import { OperatorConfig } from "./config"

// Everything OpenCode remembers today, in one view: the files added to prompts (instruction files,
// nested AGENTS.md, skills, prompt profile files) and what the database keeps
// (sessions, messages, compaction summaries and the other tables).

export const FileKind = Schema.Literals(["instructions", "nested", "url", "skill", "profile"])
export const File = Schema.Struct({
  kind: FileKind,
  scope: OperatorConfig.Scope,
  path: Schema.String,
  size: Schema.optional(Schema.Finite),
  modified: Schema.optional(Schema.Finite),
  loaded: Schema.Literals(["always", "when-reading", "on-demand", "never", "in-profile"]).annotate({
    description:
      "always: in every system prompt; when-reading: added when the agent reads a file in its folder; on-demand: loaded when the agent asks for it; never: another instruction file in the same folder comes first; in-profile: used where a prompt profile includes it",
  }),
  editable: Schema.Boolean,
}).annotate({ identifier: "OperatorMemoryFile" })
export type File = typeof File.Type

export const Table = Schema.Struct({ name: Schema.String, rows: Schema.Finite }).annotate({
  identifier: "OperatorMemoryTable",
})

export const Summary = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  time: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "OperatorMemorySummary" })

export const Overview = Schema.Struct({
  files: Schema.Array(File),
  database: Schema.Struct({
    path: Schema.String,
    size: Schema.Finite.annotate({ description: "Bytes, including the write-ahead log" }),
    tables: Schema.Array(Table),
  }),
  summaries: Schema.Array(Summary).annotate({ description: "The latest compaction summaries in this project" }),
  creatable: Schema.Array(Schema.Struct({ scope: OperatorConfig.Scope, path: Schema.String })).annotate({
    description: "Where an AGENTS.md can be created that OpenCode would read, when there is none yet",
  }),
}).annotate({ identifier: "OperatorMemoryOverview" })
export type Overview = typeof Overview.Type

export class NotAllowedError extends Schema.TaggedErrorClass<NotAllowedError>()("OperatorMemoryNotAllowed", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly overview: () => Effect.Effect<Overview>
  /** Reads a memory file listed by overview. */
  readonly read: (file: string) => Effect.Effect<string, NotAllowedError>
  /**
   * Writes a listed memory file, or creates AGENTS.md at the project root or in the global config
   * folder. Returns what was written, so callers can reload what caches it (skills).
   */
  readonly write: (
    file: string,
    text: string,
  ) => Effect.Effect<{ kind: typeof FileKind.Type; scope: OperatorConfig.Scope }, NotAllowedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorMemory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const instruction = yield* Instruction.Service
    const skill = yield* Skill.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    // The names OpenCode looks for in a folder, in order; only the first one found is used.
    const names = ["AGENTS.md", ...(flags.disableClaudeCodePrompt ? [] : ["CLAUDE.md"]), "CONTEXT.md"]

    const stat = (file: string) =>
      Effect.promise(() =>
        fs
          .stat(file)
          .then((info) => ({ size: info.size, modified: info.mtimeMs }))
          .catch(() => ({})),
      )

    const files = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const root = OperatorConfig.projectRoot(ctx)
      const scopeOf = (file: string): OperatorConfig.Scope =>
        file === root || file.startsWith(root + path.sep) ? "project" : "global"

      const always = [...(yield* instruction.systemPaths().pipe(Effect.orDie))]
      const urls = ((yield* config.get()).instructions ?? []).filter((item) => /^https?:\/\//.test(item))
      // Instruction files below the session folder are added when the agent reads a file under
      // theirs. In each folder only the first name in `names` counts; the session folder's own files
      // come from the system prompt paths above.
      const found =
        ctx.directory === "/"
          ? []
          : yield* Effect.promise(() =>
              glob(`**/{${names.map((name) => name.slice(0, -3)).join(",")}}.md`, {
                cwd: ctx.directory,
                absolute: true,
                nodir: true,
                maxDepth: 8,
                ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
              }),
            )
      const first = new Map<string, string>()
      for (const file of found.toSorted((a, b) => names.indexOf(path.basename(a)) - names.indexOf(path.basename(b))))
        if (!first.has(path.dirname(file))) first.set(path.dirname(file), file)
      const nested = found
        .filter((file) => !always.includes(file))
        .toSorted()
        .map((file) => ({
          file,
          used: path.dirname(file) !== path.resolve(ctx.directory) && first.get(path.dirname(file)) === file,
        }))
      const skills = yield* skill.all()
      // Prompt profile data: namespaces, their types, layers, groups and profiles, project and agent settings.
      const profile = yield* Effect.promise(() =>
        glob("**/*.{md,json}", { cwd: path.join(Global.Path.config, "namespaces"), absolute: true, nodir: true }),
      )
      const local = [
        ...always.map((file) => ({ kind: "instructions" as const, path: file, loaded: "always" as const })),
        ...nested.map((item) => ({
          kind: "nested" as const,
          path: item.file,
          loaded: item.used ? ("when-reading" as const) : ("never" as const),
        })),
        ...skills
          .filter((item) => path.isAbsolute(item.location))
          .map((item) => ({ kind: "skill" as const, path: item.location, loaded: "on-demand" as const })),
        ...profile.toSorted().map((file) => ({ kind: "profile" as const, path: file, loaded: "in-profile" as const })),
      ]
      const described = yield* Effect.forEach(local, (item) =>
        stat(item.path).pipe(Effect.map((info) => ({ ...item, ...info, scope: scopeOf(item.path), editable: true }))),
      )
      return [
        ...described,
        ...urls.map((url) => ({
          kind: "url" as const,
          path: url,
          loaded: "always" as const,
          scope: "project" as const,
          editable: false,
        })),
      ]
    })

    // The two places OpenCode reads an AGENTS.md from on its own.
    const candidates = (ctx: { directory: string; worktree: string }) => [
      { path: path.join(OperatorConfig.projectRoot(ctx), "AGENTS.md"), scope: "project" as const },
      { path: path.join(Global.Path.config, "AGENTS.md"), scope: "global" as const },
    ]

    const overview = Effect.fn("OperatorMemory.overview")(function* () {
      const ctx = yield* InstanceState.context
      const dbPath = Database.path()
      // Every table, counted only: rows are never read, since some (accounts, credentials) hold secrets.
      const names = yield* db
        .all<{
          name: string
        }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
        )
        .pipe(Effect.orDie)
      const tables = yield* Effect.forEach(names, (table) =>
        db.get<{ rows: number }>(sql`SELECT count(*) AS rows FROM ${sql.identifier(table.name)}`).pipe(
          Effect.map((row) => ({ name: table.name, rows: row?.rows ?? 0 })),
          Effect.orElseSucceed(() => ({ name: table.name, rows: 0 })),
        ),
      )
      const size = yield* Effect.promise(async () => {
        const sizes = await Promise.all(
          [dbPath, `${dbPath}-wal`].map((file) =>
            fs
              .stat(file)
              .then((info) => info.size)
              .catch(() => 0),
          ),
        )
        return sizes.reduce((total, item) => total + item, 0)
      })
      const compactions = yield* db
        .select({
          id: MessageTable.id,
          session: MessageTable.session_id,
          time: MessageTable.time_created,
          title: SessionTable.title,
        })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
        .where(
          and(
            eq(SessionTable.project_id, ctx.project.id),
            sql`json_extract(${MessageTable.data}, '$.agent') = 'compaction'`,
          ),
        )
        .orderBy(desc(MessageTable.time_created))
        .limit(20)
        .all()
        .pipe(Effect.orDie)
      const parts = compactions.length
        ? yield* db
            .select({ message: PartTable.message_id, data: PartTable.data })
            .from(PartTable)
            .where(
              inArray(
                PartTable.message_id,
                compactions.map((item) => item.id),
              ),
            )
            .all()
            .pipe(Effect.orDie)
        : []
      const textOf = (message: string) =>
        parts
          .filter((part) => part.message === message)
          .flatMap((part) => {
            const data = part.data as { type?: string; text?: string }
            return data.type === "text" && data.text ? [data.text] : []
          })
          .join("\n")
      const listed = yield* files()
      const creatable = yield* Effect.filter(candidates(ctx), (item) =>
        Effect.promise(() =>
          fs
            .access(item.path)
            .then(() => false)
            .catch(() => !listed.some((file) => file.path === item.path)),
        ),
      )
      return {
        files: listed,
        creatable,
        database: { path: dbPath, size, tables },
        summaries: compactions.map((item) => ({
          sessionID: item.session,
          title: item.title,
          time: item.time,
          text: textOf(item.id),
        })),
      }
    })

    // Only files the overview lists can be read or written, plus a new AGENTS.md in the two
    // places OpenCode reads one from.
    const allowed = Effect.fnUntraced(function* (file: string, creating: boolean) {
      const ctx = yield* InstanceState.context
      const resolved = path.resolve(file)
      const listed = (yield* files()).find((item) => item.editable && path.resolve(item.path) === resolved)
      if (listed) return { path: resolved, kind: listed.kind, scope: listed.scope }
      const fresh = creating ? candidates(ctx).find((item) => item.path === resolved) : undefined
      if (!fresh) return yield* new NotAllowedError({ message: `${resolved} is not a memory file` })
      return { path: resolved, kind: "instructions" as const, scope: fresh.scope }
    })

    const read = Effect.fn("OperatorMemory.read")(function* (file: string) {
      const found = yield* allowed(file, false)
      return yield* Effect.promise(() => fs.readFile(found.path, "utf8").catch(() => ""))
    })

    const write = Effect.fn("OperatorMemory.write")(function* (file: string, text: string) {
      const found = yield* allowed(file, true)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(found.path), { recursive: true })
        await fs.writeFile(found.path, text)
      })
      return { kind: found.kind, scope: found.scope }
    })

    return Service.of({ overview, read, write })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Instruction.node, Skill.node, Config.node, RuntimeFlags.node],
})
