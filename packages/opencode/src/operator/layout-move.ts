export * as OperatorLayoutMove from "./layout-move"

import fs from "fs/promises"
import path from "path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MergeAdapter } from "@/merge/adapter/adapter"
import { MergeAdapterRegistry } from "@/merge/adapter/registry"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorFolderSql } from "./folder-sql"
import { OperatorFolders } from "./folders"
import { OperatorLayout } from "./layout"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorPathRewrite } from "./path-rewrite"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorReloadWhenIdle } from "./reload-when-idle"

// Moving a project's or a namespace's folder (global_and_opencode_namespaces_spec.md §11): one procedure
// for the Move actions, and later the upgrade and a working-directory change.
// 1. A plan: each item from → to, its size and sessions, and what blocks it (the target exists, the move
//    crosses file systems, linked git worktrees, running sessions, open terminals, protected folders).
// 2. The move, item by item, with a journal (`<data>/operator/moves/<id>.json`) updated after each step:
//    stop the folder's instances, rename it, rewrite every stored path (the database here; the files,
//    queue and snapshots in path-rewrite.ts; merged agents' own records of sessions in it, through their
//    adapters' relocators, such as Claude Code's transcripts), verify, finish. A failure rolls the item
//    back; a journal a stopped server left is rolled back (or finished, if only finishing was left) at the
//    next start.
// 3. A report: what moved, what was skipped and why, and the files that still name the old folder (config
//    files aren't rewritten; they are updated by hand).
// Never moved: Global's folder, the working directory, OpenCode's own folders, anything outside the
// workspace roots (Global's folder aside, as a target).

export const BlockerKind = Schema.Literals([
  "target-exists",
  "cross-device",
  "worktrees",
  "busy",
  "terminal",
  "protected",
  "name",
  "agent-data",
]).annotate({ identifier: "OperatorLayoutBlockerKind" })

export const Blocker = Schema.Struct({
  kind: BlockerKind,
  message: Schema.String,
}).annotate({ identifier: "OperatorLayoutBlocker" })
export type Blocker = typeof Blocker.Type

const AgentFolders = Schema.Struct({
  adapter: Schema.String,
  name: Schema.String,
  folders: Schema.Finite.annotate({ description: "Its folders of sessions that ran in the folder or below it" }),
}).annotate({ identifier: "OperatorLayoutAgentFolders" })

export const Item = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["project", "namespace"]),
  name: Schema.String,
  from: Schema.String,
  to: Schema.String,
  namespace: Schema.String.annotate({ description: "project: the namespace it goes to; namespace: the one moving" }),
  size: Schema.optional(Schema.Finite).annotate({ description: "Bytes, when they could be counted" }),
  sessions: Schema.Finite.annotate({ description: "Sessions in the folder" }),
  agents: Schema.optional(Schema.Array(AgentFolders)).annotate({
    description: "Merged agents' records of sessions in the folder that follow it (Claude Code's transcripts)",
  }),
  blockers: Schema.Array(Blocker),
}).annotate({ identifier: "OperatorLayoutMoveItem" })
export type Item = typeof Item.Type

export const Plan = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["project", "namespace", "upgrade", "working-dir"]),
  items: Schema.Array(Item),
  workingDir: Schema.optional(Schema.String).annotate({
    description: "working-dir: the new working directory, saved once the move has run",
  }),
}).annotate({ identifier: "OperatorLayoutPlan" })
export type Plan = typeof Plan.Type

export const PlanInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
    project: Schema.String,
    namespace: Schema.String,
    name: Schema.optional(Schema.String).annotate({ description: "The folder name there (default: its name now)" }),
  }),
  Schema.Struct({ kind: Schema.Literal("namespace"), namespace: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("upgrade") }),
  Schema.Struct({ kind: Schema.Literal("working-dir"), workingDir: Schema.String }),
]).annotate({ identifier: "OperatorLayoutPlanInput" })
export type PlanInput = typeof PlanInput.Type

export const MoveInput = Schema.Struct({
  plan: Schema.String,
  items: Schema.Array(Schema.String).annotate({ description: "The plan's items to move" }),
  waitIdle: Schema.optional(Schema.Boolean).annotate({
    description: "Wait (up to 10 minutes) for running sessions in a folder to finish instead of skipping it",
  }),
}).annotate({ identifier: "OperatorLayoutMoveInput" })

const Moved = Schema.Struct({
  item: Schema.String,
  name: Schema.String,
  from: Schema.String,
  to: Schema.String,
  sessions: Schema.Finite,
  agents: Schema.optional(Schema.Array(AgentFolders)),
})
const Skipped = Schema.Struct({
  item: Schema.String,
  name: Schema.String,
  from: Schema.String,
  to: Schema.String,
  reason: Schema.String,
})

export const Report = Schema.Struct({
  id: Schema.String,
  plan: Schema.String,
  status: Schema.Literals(["running", "done", "partial", "failed"]),
  moved: Schema.Array(Moved),
  skipped: Schema.Array(Skipped),
  byHand: Schema.Array(Schema.String).annotate({
    description: "Files that still name an old folder (config files aren't rewritten): update these by hand",
  }),
  startedAt: Schema.Finite,
  finishedAt: Schema.optional(Schema.Finite),
}).annotate({ identifier: "OperatorLayoutMoveReport" })
export type Report = typeof Report.Type

export class MoveError extends Schema.TaggedErrorClass<MoveError>()("OperatorLayoutMoveError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly plan: (input: PlanInput) => Effect.Effect<Plan, MoveError>
  readonly move: (input: typeof MoveInput.Type) => Effect.Effect<Report, MoveError>
  readonly report: (id: string) => Effect.Effect<Report, MoveError>
  /** Rolls back (or finishes) moves a stopped server left half done; run at the start. */
  readonly recover: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorLayoutMove") {}

// The steps an item goes through; the journal says how far it got.
type Step = "planned" | "stopping" | "renaming" | "rewriting" | "finishing" | "done" | "rolled-back" | "skipped"
type Entry = Item & {
  step: Step
  /** A project's entry in projects.json before its prompt settings moved with it (null: it had none). */
  prior?: unknown
  /** Sessions repointed through their events (taken back on a rollback). */
  repointed?: string[]
  database?: boolean
  undo?: OperatorPathRewrite.Undo
  /** What merged agents' relocators changed (put back on a rollback). */
  relocated?: MergeAdapter.Relocation[]
  error?: string
}
type Journal = { id: string; plan: Plan; startedAt: number; entries: Entry[]; report: Report }

const movesFolder = () => path.join(Global.Path.data, "operator", "moves")
const journalFile = (id: string) => path.join(movesFolder(), `${id}.json`)
const writeJournal = async (journal: Journal) => {
  await fs.mkdir(movesFolder(), { recursive: true })
  const file = journalFile(journal.id)
  await fs.writeFile(`${file}.tmp`, JSON.stringify(journal, null, 2))
  await fs.rename(`${file}.tmp`, file)
}
const readJournal = (id: string) =>
  fs
    .readFile(journalFile(id), "utf8")
    .then((text) => JSON.parse(text) as Journal)
    .catch(() => undefined)

const exists = (file: string) =>
  fs
    .lstat(file)
    .then(() => true)
    .catch(() => false)
const newID = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// The device a path is on: the nearest folder that exists, for a target not created yet.
async function deviceOf(file: string): Promise<number | undefined> {
  let current = path.resolve(file)
  for (;;) {
    const stat = await fs.stat(current).catch(() => undefined)
    if (stat) return stat.dev
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// The git repositories a move takes along: the folder's own, or (a namespace) its projects'.
async function repositories(folder: string, depth = 2): Promise<string[]> {
  if (await exists(path.join(folder, ".git"))) return [folder]
  if (depth === 0) return []
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => repositories(path.join(folder, entry.name), depth - 1)),
  )
  return found.flat()
}

async function worktrees(repo: string) {
  const child = Bun.spawn(["git", "worktree", "list", "--porcelain"], { cwd: repo, stdout: "pipe", stderr: "ignore" })
  const text = await new Response(child.stdout).text()
  await child.exited
  return text.split("\n").filter((line) => line.startsWith("worktree ")).length
}

async function sizeOf(folder: string): Promise<number | undefined> {
  const child = Bun.spawn(["du", "-sk", folder], { stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => child.kill(), 10_000)
  const text = await new Response(child.stdout).text()
  clearTimeout(timer)
  const kb = Number(text.split(/\s/)[0])
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const instances = yield* InstanceStore.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const store = yield* OperatorProfileStore.Service
    const adapters = yield* MergeAdapterRegistry.Service
    const scope = yield* Scope.Scope
    const plans = new Map<string, Plan>()
    // Merged agents keep their own records per working folder; they read the server's environment
    // (CLAUDE_CONFIG_DIR, HOME), as the agents the server starts do.
    const relocators = () =>
      adapters.list().flatMap((adapter) => (adapter.relocator ? [{ adapter, relocator: adapter.relocator }] : []))
    const agentsOf = (from: string) =>
      Effect.forEach(relocators(), ({ adapter, relocator }) =>
        relocator.check(from, process.env).pipe(Effect.map((check) => ({ adapter, check }))),
      )

    // Terminals open now, by folder: a move skips a folder with one open.
    const terminals = new Map<string, string>()
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: Record<string, unknown> } | undefined
      const properties = payload?.properties ?? {}
      if (payload?.type === "pty.created") {
        const info = properties.info as { id?: string; cwd?: string } | undefined
        if (info?.id && info.cwd) terminals.set(info.id, path.resolve(info.cwd))
      }
      if (payload?.type === "pty.exited" || payload?.type === "pty.deleted") terminals.delete(String(properties.id))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    const sessionsUnder = (folder: string) =>
      db
        .select({ id: SessionTable.id, directory: SessionTable.directory })
        .from(SessionTable)
        .where(OperatorFolderSql.within(SessionTable.directory, folder))
        .all()
        .pipe(Effect.orDie)

    // What keeps a folder from moving now.
    const blockersOf = Effect.fnUntraced(function* (from: string, to: string, kind: Item["kind"]) {
      const blockers: Blocker[] = []
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const roots = OperatorFolders.workspaceRoots().map((root) => path.resolve(root))
      const inside = (folder: string, file: string) => OperatorLayout.contains(folder, file)
      const protect = (message: string) => blockers.push({ kind: "protected", message })
      if (inside(from, Global.Path.config) || (inside(Global.Path.config, from) && kind === "namespace"))
        protect("Global's folder never moves")
      if (layout.workingDir && inside(from, layout.workingDir)) protect("The working directory itself never moves")
      if (inside(from, process.cwd())) protect(`OpenCode runs from ${from}`)
      if (inside(from, Global.Path.data)) protect(`${from} holds OpenCode's own data`)
      const allowed = (folder: string) =>
        roots.some((root) => inside(root, folder)) || inside(Global.Path.config, folder)
      if (!allowed(from)) protect(`${from} is outside the workspace (${roots.join(", ")})`)
      if (!allowed(to)) protect(`${to} is outside the workspace (${roots.join(", ")})`)
      if (inside(from, to)) protect(`${to} is inside ${from}`)
      if (yield* Effect.promise(() => exists(to)))
        blockers.push({ kind: "target-exists", message: `${to} already exists; nothing is overwritten` })
      const [source, target] = yield* Effect.promise(() => Promise.all([deviceOf(from), deviceOf(path.dirname(to))]))
      if (source !== undefined && target !== undefined && source !== target)
        blockers.push({
          kind: "cross-device",
          message: `${from} and ${path.dirname(to)} are on different file systems; moving would mean copying`,
        })
      for (const repo of yield* Effect.promise(() => repositories(from)))
        if ((yield* Effect.promise(() => worktrees(repo))) > 1)
          blockers.push({
            kind: "worktrees",
            message: `${repo} has linked git worktrees: move them with \`git worktree move\` by hand, then try again`,
          })
      const running = yield* reloads.runningUnder(from)
      if (running.length)
        blockers.push({ kind: "busy", message: `${running.length} session(s) running or waiting for approval in it` })
      const open = [...terminals.values()].filter((cwd) => inside(from, cwd))
      if (open.length) blockers.push({ kind: "terminal", message: `${open.length} terminal(s) open in it` })
      for (const { check } of yield* agentsOf(from))
        if (check.problem) blockers.push({ kind: "agent-data", message: check.problem })
      return blockers
    })

    const itemOf = Effect.fnUntraced(function* (input: {
      kind: Item["kind"]
      name: string
      from: string
      to: string
      namespace: string
      extra?: Blocker[]
    }) {
      const from = path.resolve(input.from)
      const to = path.resolve(input.to)
      const agents = (yield* agentsOf(from))
        .filter(({ check }) => check.folders > 0)
        .map(({ adapter, check }) => ({ adapter: adapter.id, name: adapter.name, folders: check.folders }))
      return {
        id: newID("mi"),
        kind: input.kind,
        name: input.name,
        from,
        to,
        namespace: input.namespace,
        ...(yield* Effect.promise(() => sizeOf(from)).pipe(Effect.map((size) => (size === undefined ? {} : { size })))),
        sessions: (yield* sessionsUnder(from)).length,
        ...(agents.length ? { agents } : {}),
        blockers: [...(input.extra ?? []), ...(yield* blockersOf(from, to, input.kind))],
      } satisfies Item
    })

    const plan = Effect.fn("OperatorLayoutMove.plan")(function* (input: PlanInput) {
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const items: Item[] = []
      if (input.kind === "project") {
        const place = OperatorLayout.placeOf(input.namespace, layout)
        if (!place) return yield* new MoveError({ message: `No namespace ${input.namespace}` })
        const from = path.resolve(input.project)
        if (!(yield* Effect.promise(() => exists(from))))
          return yield* new MoveError({ message: `${from} doesn't exist` })
        const name = (input.name ?? path.basename(from)).trim()
        const problem = place.global
          ? yield* Effect.promise(() => OperatorLayout.globalNameProblem(name))
          : !name || name.includes("/") || name.startsWith(".")
            ? `"${name}" isn't a folder name for a project`
            : undefined
        const to = path.join(place.folder, name)
        if (to === from) return yield* new MoveError({ message: `${from} is already there` })
        items.push(
          yield* itemOf({
            kind: "project",
            name: path.basename(from),
            from,
            to,
            namespace: place.id,
            // An existing folder is the target-exists blocker already.
            extra: problem && !problem.endsWith("already exists") ? [{ kind: "name", message: problem }] : [],
          }),
        )
      }
      if (input.kind === "namespace") {
        const place = OperatorLayout.placeOf(input.namespace, layout)
        if (!place) return yield* new MoveError({ message: `No namespace ${input.namespace}` })
        if (place.global) return yield* new MoveError({ message: "Global's folder never moves" })
        if (place.inPlace)
          return yield* new MoveError({ message: `${place.id} is already in place, at ${place.folder}` })
        items.push(
          yield* itemOf({
            kind: "namespace",
            name: place.id,
            from: place.folder,
            to: place.target,
            namespace: place.id,
          }),
        )
      }
      if (input.kind === "upgrade") {
        const assigned = Object.fromEntries(
          Object.entries(yield* Effect.promise(() => OperatorProfileStore.readProjects())).map(([key, value]) => [
            key,
            value.namespace,
          ]),
        )
        const found = OperatorLayout.upgradeItems(layout, assigned)
        for (const id of found.namespaces) {
          const place = OperatorLayout.placeOf(id, layout)!
          if (!(yield* Effect.promise(() => exists(place.folder)))) continue
          items.push(
            yield* itemOf({ kind: "namespace", name: id, from: place.folder, to: place.target, namespace: id }),
          )
        }
        for (const item of found.projects) {
          if (!(yield* Effect.promise(() => exists(item.project)))) continue
          items.push(
            yield* itemOf({
              kind: "project",
              name: path.basename(item.project),
              from: item.project,
              to: item.to,
              namespace: item.namespace,
            }),
          )
        }
      }
      let workingDir: string | undefined
      if (input.kind === "working-dir") {
        workingDir = path.resolve(input.workingDir)
        if (!layout.workingDir)
          return yield* new MoveError({ message: "The working directory is blank: set it, nothing moves" })
        if (workingDir === layout.workingDir)
          return yield* new MoveError({ message: `The working directory is ${workingDir} already` })
        const problem = yield* Effect.promise(() =>
          OperatorLayout.workingDirProblem(workingDir!, OperatorFolders.workspaceRoots()),
        )
        if (problem) return yield* new MoveError({ message: problem })
        for (const place of layout.places) {
          if (place.global || !(yield* Effect.promise(() => exists(place.folder)))) continue
          items.push(
            yield* itemOf({
              kind: "namespace",
              name: place.id,
              from: place.folder,
              to: path.join(workingDir, place.id),
              namespace: place.id,
            }),
          )
        }
      }
      const result: Plan = { id: newID("mp"), kind: input.kind, items, ...(workingDir ? { workingDir } : {}) }
      plans.set(result.id, result)
      return result
    })

    // The core database: rows that keep the folder, in one transaction (sessions go through their events).
    const rewriteDatabase = (from: string, to: string) => {
      const prefix = `${from}/`
      const swap = (column: string) =>
        sql
          .raw(column)
          .append(
            sql` = ${to} || substr(${sql.raw(column)}, ${from.length + 1}) WHERE ${sql.raw(column)} = ${from} OR substr(${sql.raw(column)}, 1, ${prefix.length}) = ${prefix}`,
          )
      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`UPDATE project SET `.append(swap("worktree")))
            yield* tx.run(sql`UPDATE OR REPLACE project_directory SET `.append(swap("directory")))
            yield* tx.run(sql`UPDATE workspace SET `.append(swap("directory")))
            yield* tx.run(sql`UPDATE session_merge_binding SET `.append(swap("cwd")))
            const rows = yield* tx
              .select({ id: ProjectTable.id, sandboxes: ProjectTable.sandboxes })
              .from(ProjectTable)
              .all()
            for (const row of rows) {
              const next = row.sandboxes.map((item) => OperatorPathRewrite.swap(item, from, to) ?? item)
              if (next.some((item, index) => item !== row.sandboxes[index]))
                yield* tx.run(sql`UPDATE project SET sandboxes = ${JSON.stringify(next)} WHERE id = ${row.id}`)
            }
          }),
        )
        .pipe(Effect.orDie)
    }

    // A session's record points at its new folder, through its events (the session table is their projection).
    const repoint = Effect.fnUntraced(function* (id: string, from: string, to: string) {
      const sessionID = SessionID.make(id)
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const directory = OperatorPathRewrite.swap(current.directory, from, to)
      if (!directory) return
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID,
        info: { ...current, directory, time: { ...current.time, updated: Date.now() } },
      })
    })

    // Puts an item back as it was before its move, from what its journal entry says was done.
    const rollback = Effect.fnUntraced(function* (entry: Entry) {
      for (const done of (entry.relocated ?? []).toReversed()) {
        const relocator = adapters.get(done.adapter)?.relocator
        if (relocator) yield* relocator.restore(done, entry.from, entry.to)
      }
      if (entry.undo) yield* Effect.promise(() => OperatorPathRewrite.rollback(entry.undo!, entry.from, entry.to))
      if (entry.prior !== undefined)
        yield* Effect.promise(() =>
          OperatorProfileStore.putProject(
            entry.from,
            (entry.prior ?? undefined) as OperatorProfile.ProjectSetting | undefined,
          ),
        )
      for (const id of entry.repointed ?? []) yield* repoint(id, entry.to, entry.from).pipe(Effect.ignore)
      if (entry.database) yield* rewriteDatabase(entry.to, entry.from)
      if (
        entry.step !== "stopping" &&
        (yield* Effect.promise(() => exists(entry.to))) &&
        !(yield* Effect.promise(() => exists(entry.from)))
      )
        yield* Effect.promise(() => fs.rename(entry.to, entry.from))
    })

    const emit = (journal: Journal, entry?: Entry) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          payload: {
            type: "operator.layout.move",
            properties: {
              id: journal.id,
              status: journal.report.status,
              ...(entry ? { item: entry.id, step: entry.step } : {}),
            },
          },
        }),
      )

    const save = (journal: Journal) => Effect.promise(() => writeJournal(journal))

    // One item: stop, rename, rewrite, verify, finish. A failure rolls it back.
    const moveOne = Effect.fnUntraced(function* (journal: Journal, entry: Entry) {
      const step = (next: Step) =>
        Effect.gen(function* () {
          entry.step = next
          yield* save(journal)
          yield* emit(journal, entry)
        })
      const before = (yield* sessionsUnder(entry.from)).map((row) => row.id)
      return yield* Effect.gen(function* () {
        // A project's prompt settings go with it: what it uses is copied into the namespace it moves to.
        if (entry.kind === "project") {
          const projects = yield* Effect.promise(() => OperatorProfileStore.readProjects())
          entry.prior = projects[entry.from] ?? null
          yield* save(journal)
          yield* store
            .setProject(entry.from, { namespace: entry.namespace })
            .pipe(Effect.mapError((error) => new MoveError({ message: error.message })))
        }
        yield* step("stopping")
        for (const directory of OperatorNamespaceScope.instancesUnder(entry.from))
          yield* instances.disposeDirectory(directory)
        yield* step("renaming")
        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(path.dirname(entry.to), { recursive: true })
            await fs.rename(entry.from, entry.to)
          },
          catch: (error) => new MoveError({ message: error instanceof Error ? error.message : String(error) }),
        })
        yield* step("rewriting")
        const projects = yield* db
          .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .all()
          .pipe(Effect.orDie)
        yield* rewriteDatabase(entry.from, entry.to)
        entry.database = true
        yield* save(journal)
        entry.repointed = []
        for (const id of before) {
          yield* repoint(id, entry.from, entry.to)
          entry.repointed.push(id)
        }
        yield* save(journal)
        entry.undo = yield* Effect.tryPromise({
          try: () => OperatorPathRewrite.rewrite(`${journal.id}-${entry.id}`, entry.from, entry.to, projects),
          catch: (error) => new MoveError({ message: error instanceof Error ? error.message : String(error) }),
        })
        yield* save(journal)
        // Merged agents' records of the folder's sessions follow it, so those sessions resume there.
        entry.relocated = []
        for (const { relocator } of relocators()) {
          const done = yield* relocator
            .move(entry.from, entry.to, process.env)
            .pipe(Effect.mapError((error) => new MoveError({ message: error.message })))
          if (!done.renames.length && !done.rewritten.length) continue
          entry.relocated.push(done)
          yield* save(journal)
        }
        yield* step("finishing")
        const after = (yield* sessionsUnder(entry.to)).length
        if (!(yield* Effect.promise(() => exists(entry.to))) || (yield* Effect.promise(() => exists(entry.from))))
          return yield* new MoveError({ message: `${entry.to} isn't where it should be after the move` })
        if (after < before.length)
          return yield* new MoveError({ message: `${before.length - after} session(s) weren't re-linked` })
        yield* Effect.promise(() => OperatorPathRewrite.finish(entry.undo!))
        yield* step("done")
        journal.report = {
          ...journal.report,
          moved: [
            ...journal.report.moved,
            {
              item: entry.id,
              name: entry.name,
              from: entry.from,
              to: entry.to,
              sessions: after,
              ...(entry.relocated.length
                ? {
                    agents: entry.relocated.map((done) => ({
                      adapter: done.adapter,
                      name: adapters.get(done.adapter)?.name ?? done.adapter,
                      folders: done.renames.length,
                    })),
                  }
                : {}),
            },
          ],
          byHand: [
            ...journal.report.byHand,
            ...(yield* Effect.promise(() => OperatorPathRewrite.filesNaming(entry.to, entry.from))),
          ],
        }
        yield* save(journal)
      }).pipe(
        Effect.catch((error: MoveError) =>
          Effect.gen(function* () {
            entry.error = error.message
            yield* rollback(entry)
            yield* step("rolled-back")
            journal.report = {
              ...journal.report,
              skipped: [
                ...journal.report.skipped,
                {
                  item: entry.id,
                  name: entry.name,
                  from: entry.from,
                  to: entry.to,
                  reason: `Failed and rolled back: ${error.message}`,
                },
              ],
            }
            yield* save(journal)
          }),
        ),
      )
    })

    const waitIdle = Effect.fnUntraced(function* (folder: string) {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (!(yield* reloads.runningUnder(folder)).length) return true
        yield* Effect.sleep("2 seconds")
      }
      return false
    })

    const move = Effect.fn("OperatorLayoutMove.move")(function* (input: typeof MoveInput.Type) {
      const found = plans.get(input.plan)
      if (!found) return yield* new MoveError({ message: `No plan ${input.plan}; make the plan again` })
      const chosen = found.items.filter((item) => input.items.includes(item.id))
      const journal: Journal = {
        id: newID("mv"),
        plan: found,
        startedAt: Date.now(),
        entries: chosen.map((item) => ({ ...item, step: "planned" })),
        report: {
          id: "",
          plan: found.id,
          status: "running",
          moved: [],
          skipped: [],
          byHand: [],
          startedAt: Date.now(),
        },
      }
      journal.report = { ...journal.report, id: journal.id }
      yield* save(journal)
      for (const entry of journal.entries) {
        // The folder as it is now: the plan may be old.
        let blockers = yield* blockersOf(entry.from, entry.to, entry.kind)
        if (input.waitIdle && blockers.some((item) => item.kind === "busy") && (yield* waitIdle(entry.from)))
          blockers = yield* blockersOf(entry.from, entry.to, entry.kind)
        const named = entry.blockers.filter((item) => item.kind === "name")
        if (blockers.length || named.length) {
          entry.step = "skipped"
          journal.report = {
            ...journal.report,
            skipped: [
              ...journal.report.skipped,
              {
                item: entry.id,
                name: entry.name,
                from: entry.from,
                to: entry.to,
                reason: [...named, ...blockers].map((item) => item.message).join("; "),
              },
            ],
          }
          yield* save(journal)
          continue
        }
        yield* moveOne(journal, entry)
      }
      yield* afterMove(found, journal)
      for (const item of found.items.filter((item) => !input.items.includes(item.id)))
        journal.report = {
          ...journal.report,
          skipped: [
            ...journal.report.skipped,
            { item: item.id, name: item.name, from: item.from, to: item.to, reason: "Not chosen" },
          ],
        }
      const moved = journal.report.moved.length
      journal.report = {
        ...journal.report,
        status: moved === chosen.length ? "done" : moved ? "partial" : "failed",
        finishedAt: Date.now(),
      }
      yield* save(journal)
      yield* emit(journal)
      plans.delete(found.id)
      return journal.report
    })

    // What a plan does once its folders have moved: a new working directory is saved (the namespaces that
    // didn't move keep their folders, named in their records, "Not in place"); the upgrade is done.
    const afterMove = Effect.fnUntraced(function* (plan: Plan, journal: Journal) {
      if (plan.kind === "working-dir" && plan.workingDir) {
        const moved = new Set(journal.entries.filter((entry) => entry.step === "done").map((entry) => entry.namespace))
        for (const item of plan.items)
          if (!moved.has(item.namespace))
            yield* Effect.promise(() => OperatorProfileStore.pinFolder(item.namespace, item.from))
        const settings = yield* Effect.promise(() => OperatorLayout.readSettings())
        yield* Effect.promise(() => OperatorLayout.writeSettings({ ...settings, workingDir: plan.workingDir }))
      }
      if (plan.kind === "upgrade") {
        const settings = yield* Effect.promise(() => OperatorLayout.readSettings())
        yield* Effect.promise(() => OperatorLayout.writeSettings({ ...settings, upgradeDone: true }))
      }
    })

    const report = Effect.fn("OperatorLayoutMove.report")(function* (id: string) {
      if (!/^[\w-]+$/.test(id)) return yield* new MoveError({ message: `No move ${id}` })
      const journal = yield* Effect.promise(() => readJournal(id))
      if (!journal) return yield* new MoveError({ message: `No move ${id}` })
      return journal.report
    })

    // A move a stopped server left half done: rolled back, or finished when only finishing was left.
    const recover = Effect.fnUntraced(function* () {
      const files = yield* Effect.promise(() => fs.readdir(movesFolder()).catch(() => [] as string[]))
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const journal = yield* Effect.promise(() => readJournal(file.slice(0, -".json".length)))
        if (!journal || journal.report.status !== "running") continue
        for (const entry of journal.entries) {
          if (entry.step === "finishing") {
            if (entry.undo) yield* Effect.promise(() => OperatorPathRewrite.finish(entry.undo!))
            entry.step = "done"
            continue
          }
          if (entry.step !== "stopping" && entry.step !== "renaming" && entry.step !== "rewriting") continue
          yield* rollback(entry).pipe(Effect.ignore)
          entry.step = "rolled-back"
          entry.error = "The server stopped during the move"
        }
        journal.report = {
          ...journal.report,
          status: journal.entries.every((entry) => entry.step === "done" || entry.step === "skipped")
            ? "done"
            : journal.entries.some((entry) => entry.step === "done")
              ? "partial"
              : "failed",
          finishedAt: Date.now(),
        }
        yield* save(journal)
      }
    })
    yield* recover().pipe(Effect.ignore, Effect.forkIn(scope))

    return Service.of({ plan, move, report, recover: () => recover().pipe(Effect.ignore) })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    Session.node,
    EventV2Bridge.node,
    InstanceStore.node,
    OperatorReloadWhenIdle.node,
    OperatorProfileStore.node,
    MergeAdapterRegistry.node,
  ],
})
