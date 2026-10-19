export * as OperatorTrash from "./trash"

import fs from "fs/promises"
import path from "path"
import { and, eq, inArray, isNull, like, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorProjectConfig } from "./project-config"
import { OperatorReloadWhenIdle } from "./reload-when-idle"
import { OperatorConfig } from "./config"
import { OperatorProfileStore } from "./profile-store"
import { OperatorRegistry } from "./registry"
import { OperatorTrashFiles } from "./trash-files"

export const Kind = OperatorTrashFiles.Kind
export type Kind = OperatorTrashFiles.Kind
export const Entry = OperatorTrashFiles.Entry
export type Entry = OperatorTrashFiles.Entry
const { put, list, get, root, exists, move } = OperatorTrashFiles

// Trash (see trash-files.ts). Config entries (MCP servers, agents and commands defined in config) keep
// their value, and are written back on restore. Sessions are archived while in Trash, and deleted
// with it.

export class TrashError extends Schema.TaggedErrorClass<TrashError>()("OperatorTrashError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Entry[]>
  /**
   * Moves a project to Trash: the project, never its folder (a project is OpenCode's record of a folder, not
   * the files: the user, 2026-10-12). Its prompt and agent settings go to Trash, its sessions are archived, and
   * it leaves the lists; the folder stays as it is.
   */
  readonly project: (key: string) => Effect.Effect<Entry, TrashError>
  /** Moves a session (and its subagents' sessions) to Trash: archived until restored or deleted. */
  readonly session: (sessionID: string) => Effect.Effect<Entry, TrashError>
  readonly restore: (id: string) => Effect.Effect<Entry, TrashError>
  /** Deletes an entry permanently, with the files and sessions it holds. */
  readonly purge: (id: string) => Effect.Effect<void, TrashError>
  readonly empty: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorTrash") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const config = yield* OperatorConfig.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const fail = (message: string) => new TrashError({ message })

    // Sessions that ran in a folder or below it.
    const sessionsUnder = Effect.fnUntraced(function* (key: string) {
      const prefix = key.endsWith(path.sep) ? key : key + path.sep
      const rows = yield* db
        .select({ id: SessionTable.id, directory: SessionTable.directory, archived: SessionTable.time_archived })
        .from(SessionTable)
        .where(or(eq(SessionTable.directory, key), like(SessionTable.directory, `${key}%`)))
        .all()
        .pipe(Effect.orDie)
      return rows.filter((row) => row.directory === key || row.directory.startsWith(prefix))
    })

    const tellTelemetry = (ids: ReadonlyArray<string>, trashed: boolean) => {
      try {
        OperatorRegistry.telemetry.trash?.(ids, trashed)
      } catch {
        // never reaches the move
      }
    }

    const archive = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
      const time = Date.now()
      for (const id of ids) yield* sessions.setArchived({ sessionID: SessionID.make(id), time })
      // Observability shows them as In Trash (telemetry.ts).
      tellTelemetry(ids, true)
    })

    // Upstream has no unarchive: its session projection leaves the archive time when an update has
    // none. So the row is cleared here, then the update is published, for clients to see it.
    const unarchive = Effect.fnUntraced(function* (id: string) {
      yield* db
        .update(SessionTable)
        .set({ time_archived: null })
        .where(eq(SessionTable.id, SessionID.make(id)))
        .run()
        .pipe(Effect.orDie)
      yield* sessions.setArchived({ sessionID: SessionID.make(id), time: undefined }).pipe(Effect.ignore)
      tellTelemetry([id], false)
    })

    const project = Effect.fn("OperatorTrash.project")(function* (key: string) {
      const folder = path.resolve(key)
      // Only the console's projects (its records, specs/docs/issues/002) go to Trash.
      if (!(folder in (yield* Effect.promise(() => OperatorProfileStore.readProjects()))))
        return yield* fail(`${folder} is not a project`)
      const found = yield* sessionsUnder(folder)
      const open = found.filter((row) => row.archived === null).map((row) => row.id)
      yield* archive(open)
      yield* instances.disposeDirectory(folder)
      return yield* Effect.tryPromise({
        try: async () => {
          const projects = await OperatorProfileStore.readProjects()
          const agents = await OperatorProfileStore.readAgents()
          const settings = { project: projects[folder], agents: agents[folder] }
          await OperatorProfileStore.forgetProject(folder)
          // No paths: the folder is never moved.
          return put({
            kind: "project",
            name: path.basename(folder),
            project: folder,
            settings,
            sessions: found.map((row) => row.id),
            archived: open,
          })
        },
        catch: (error) => fail(error instanceof Error ? error.message : String(error)),
      })
    })

    const session = Effect.fn("OperatorTrash.session")(function* (sessionID: string) {
      const found = yield* sessions
        .get(SessionID.make(sessionID))
        .pipe(Effect.mapError(() => fail(`No session ${sessionID}`)))
      const ids = [sessionID]
      for (let index = 0; index < ids.length; index++) {
        const children = yield* sessions.children(SessionID.make(ids[index]!))
        ids.push(...children.map((child) => child.id))
      }
      const rows = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            isNull(SessionTable.time_archived),
            inArray(
              SessionTable.id,
              ids.map((id) => SessionID.make(id)),
            ),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const open = rows.map((row) => row.id)
      yield* archive(open)
      return yield* Effect.promise(() =>
        put({ kind: "session", name: found.title, project: found.directory, sessions: ids, archived: open }),
      )
    })

    const restore = Effect.fn("OperatorTrash.restore")(function* (id: string) {
      const entry = yield* Effect.promise(() => get(id))
      if (!entry) return yield* fail(`Nothing in Trash with id ${id}`)
      // A cleared telemetry store replaces the current one, which goes to Trash first (observability_spec.md §15).
      if (entry.kind === "telemetry") {
        const replace = OperatorRegistry.telemetry.replaceStore
        if (!replace) return yield* fail("Telemetry isn't running, so its store can't be replaced now")
        yield* Effect.promise(() =>
          replace(async () => {
            for (const file of entry.files) await move(path.join(root(), id, file.stored), file.path)
          }),
        )
        yield* Effect.promise(() => fs.rm(path.join(root(), id), { recursive: true, force: true }))
        return entry
      }
      const taken = yield* Effect.promise(async () => {
        for (const file of entry.files) if (await exists(file.path)) return file.path
        return undefined
      })
      if (taken) return yield* fail(`${taken} exists again; move it away to restore this`)
      yield* Effect.promise(async () => {
        for (const file of entry.files) await move(path.join(root(), id, file.stored), file.path)
        if (entry.settings) await OperatorProfileStore.restoreProject(entry.project!, entry.settings)
        // A project's own config back from Trash: its copy record and copied deletions with it.
        if (entry.kind === "config" && entry.project && entry.copy)
          await OperatorProjectConfig.giveBack(entry.project, entry.copy)
      })
      if (entry.kind === "config" && entry.project)
        yield* Effect.forEach(
          OperatorNamespaceScope.instancesOf({ project: entry.project }),
          (directory) => reloads.want({ directory }),
          { discard: true },
        )
      if (entry.config) {
        const value = entry.config
        const patch = value.key.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value.value) as Record<
          string,
          unknown
        >
        // A namespace's entry goes back into that namespace's config, whichever project restores it.
        yield* instances
          .provide(
            { directory: entry.project ?? process.cwd() },
            // Restoring into a project without a config of its own gives it a copy of its namespace's.
            config
              .update(value.scope, patch, value.scope === "namespace" ? value.namespace : undefined)
              .pipe(OperatorProjectConfig.consent(true)),
          )
          .pipe(Effect.mapError((error) => fail(error.message)))
      }
      for (const session of entry.archived ?? []) yield* unarchive(session)
      yield* Effect.promise(() => fs.rm(path.join(root(), id), { recursive: true, force: true }))
      return entry
    })

    // A project deleted for good: OpenCode's record of it goes too, when it is this folder's alone (upstream gives
    // clones of one repository the same id) and no session elsewhere still uses it. Deleting the record cascades
    // to what hangs off it (its workspaces, permissions and folders), never to files.
    const forgetRecord = Effect.fnUntraced(function* (folder: string) {
      const rows = (yield* db
        .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .all()
        .pipe(Effect.orDie)).filter((row) => String(row.worktree) === folder)
      for (const row of rows) {
        const others = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.project_id, row.id))
          .all()
          .pipe(Effect.orDie)
        const prefix = folder + path.sep
        if (others.some((item) => item.directory !== folder && !item.directory.startsWith(prefix))) continue
        yield* db.delete(ProjectTable).where(eq(ProjectTable.id, row.id)).run().pipe(Effect.orDie)
      }
    })

    const purge = Effect.fn("OperatorTrash.purge")(function* (id: string) {
      const entry = yield* Effect.promise(() => get(id))
      if (!entry) return yield* fail(`Nothing in Trash with id ${id}`)
      for (const session of entry.sessions ?? []) yield* sessions.remove(SessionID.make(session)).pipe(Effect.ignore)
      if (entry.kind === "project" && entry.project) yield* forgetRecord(entry.project).pipe(Effect.ignore)
      yield* Effect.promise(() => fs.rm(path.join(root(), id), { recursive: true, force: true }))
    })

    const empty = Effect.fn("OperatorTrash.empty")(function* () {
      const entries = yield* Effect.promise(list)
      for (const entry of entries) yield* purge(entry.id).pipe(Effect.ignore)
      return entries.length
    })

    return Service.of({ list: () => Effect.promise(list), project, session, restore, purge, empty })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Session.node, InstanceStore.node, OperatorConfig.node, OperatorReloadWhenIdle.node],
})
