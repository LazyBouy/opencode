export * as OperatorProjectSessions from "./project-sessions"

import path from "path"
import { and, asc, eq, inArray, isNull, like, or } from "drizzle-orm"
import { Context, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

// Sessions are records in the database, tied to a folder and its project; the files they changed
// stay where they are. Here they are copied into a new project, moved from a folder that is not a
// project into one, or archived.

export type Moved = { moved: number; archived: number }

export interface Interface {
  /** Copies a project's sessions (not archived ones, nor subagent sessions) into another project's folder. */
  readonly copy: (source: string, target: string) => Effect.Effect<number>
  /** Moves the sessions that ran in a folder, with their subagent sessions, to a project's folder. */
  readonly move: (folder: string, target: string) => Effect.Effect<Moved>
  /** Archives the sessions that ran in a folder. */
  readonly archive: (folder: string) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorProjectSessions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* Session.Service
    const store = yield* InstanceStore.Service
    const events = yield* EventV2Bridge.Service

    // A folder's sessions with their subagent sessions, wherever those ran.
    const inFolder = Effect.fn("OperatorProjectSessions.inFolder")(function* (folder: string) {
      const rows = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, folder))
        .all()
        .pipe(Effect.orDie)
      const found = new Set(rows.map((row) => row.id))
      let parents = [...found]
      while (parents.length) {
        const children = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(inArray(SessionTable.parent_id, parents))
          .all()
          .pipe(Effect.orDie)
        parents = children.map((row) => row.id).filter((id) => !found.has(id))
        for (const id of parents) found.add(id)
      }
      return [...found]
    })

    // A copy is a fork made in the target's instance, so it belongs to the target project; the
    // original is only read. The copy keeps the original's title, agent and model.
    const copy = Effect.fn("OperatorProjectSessions.copy")(function* (source: string, target: string) {
      const prefix = source.endsWith(path.sep) ? source : source + path.sep
      const rows = yield* db
        .select({ id: SessionTable.id, directory: SessionTable.directory })
        .from(SessionTable)
        .where(
          and(
            isNull(SessionTable.parent_id),
            isNull(SessionTable.time_archived),
            or(eq(SessionTable.directory, source), like(SessionTable.directory, `${source}%`)),
          ),
        )
        .orderBy(asc(SessionTable.time_created))
        .all()
        .pipe(Effect.orDie)
      const own = rows.filter((row) => row.directory === source || row.directory.startsWith(prefix))
      const copied = yield* store.provide(
        { directory: target },
        Effect.forEach(own, (row) =>
          Effect.gen(function* () {
            const original = yield* sessions.get(row.id)
            const made = yield* sessions.fork({ sessionID: row.id })
            yield* sessions.setTitle({ sessionID: made.id, title: original.title })
            if (made.workspaceID) yield* sessions.setWorkspace({ sessionID: made.id, workspaceID: undefined })
            if (original.agent && original.model)
              yield* sessions.setAgentModel({
                sessionID: made.id,
                agent: original.agent,
                model: original.model,
                time: Date.now(),
              })
            return 1
          }).pipe(Effect.catch(() => Effect.succeed(0))),
        ),
      )
      return copied.reduce((sum, item) => sum + item, 0)
    })

    // Upstream's move-session keeps a session in its project, so a move to another project points
    // the session's record at the target's project and folder itself. A session that cannot be
    // moved is archived instead.
    const move = Effect.fn("OperatorProjectSessions.move")(function* (folder: string, target: string) {
      const ids = yield* inFolder(folder)
      return yield* store.provide(
        { directory: target },
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const result: Moved = { moved: 0, archived: 0 }
          for (const id of ids) {
            const sessionID = SessionID.make(id)
            const exit = yield* Effect.exit(
              Effect.gen(function* () {
                const current = yield* sessions.get(sessionID)
                yield* events.publish(SessionV1.Event.Updated, {
                  sessionID,
                  info: {
                    ...current,
                    projectID: ctx.project.id,
                    directory: ctx.directory,
                    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
                    workspaceID: undefined,
                    time: { ...current.time, updated: Date.now() },
                  },
                })
              }),
            )
            if (Exit.isSuccess(exit)) {
              result.moved++
              continue
            }
            yield* sessions.setArchived({ sessionID, time: Date.now() })
            result.archived++
          }
          return result
        }),
      )
    })

    const archive = Effect.fn("OperatorProjectSessions.archive")(function* (folder: string) {
      const ids = yield* inFolder(folder)
      const open = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(and(inArray(SessionTable.id, ids), isNull(SessionTable.time_archived)))
        .all()
        .pipe(Effect.orDie)
      const time = Date.now()
      for (const row of open) yield* sessions.setArchived({ sessionID: SessionID.make(row.id), time })
      return open.length
    })

    return Service.of({ copy, move, archive })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Session.node, InstanceStore.node, EventV2Bridge.node],
})
