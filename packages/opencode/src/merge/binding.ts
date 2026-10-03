import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMergeBindingTable } from "@opencode-ai/core/session/sql"
import { SessionMerge } from "@opencode-ai/schema/session-merge"
import { and, desc, eq, inArray, ne } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SessionID } from "@/session/schema"

export const Event = SessionMerge.Event

export class AlreadyBound extends Schema.TaggedErrorClass<AlreadyBound>()("MergeAlreadyBound", {
  message: Schema.String,
}) {}

export class ExternalInUse extends Schema.TaggedErrorClass<ExternalInUse>()("MergeExternalInUse", {
  message: Schema.String,
}) {}

export type ParentModel = { providerID: string; modelID: string; variant?: string }

export interface Entry {
  readonly binding: SessionMerge.Binding
  readonly parentModel?: ParentModel
  readonly pid?: number
}

export interface CreateInput {
  readonly sessionID: SessionID
  readonly adapter: string
  readonly transport: SessionMerge.Transport
  readonly externalSessionID: string
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly status: "starting" | "live"
  readonly parentModel?: ParentModel
}

export interface Interface {
  /** The binding currently driving the session (`starting` or `live`), if any. */
  readonly active: (sessionID: SessionID) => Effect.Effect<Entry | undefined>
  /** The most recent binding for the session in any status, for status display. */
  readonly latest: (sessionID: SessionID) => Effect.Effect<SessionMerge.Binding | undefined>
  readonly list: (sessionID: SessionID) => Effect.Effect<SessionMerge.Binding[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionMerge.Binding, AlreadyBound | ExternalInUse>
  readonly update: (
    id: SessionMerge.ID,
    patch: {
      status?: SessionMerge.Status
      externalSessionID?: string
      error?: string
      parentModel?: ParentModel
    },
  ) => Effect.Effect<void>
  readonly detach: (sessionID: SessionID) => Effect.Effect<SessionMerge.Binding | undefined>
  readonly touch: (id: SessionMerge.ID) => Effect.Effect<void>
  readonly setProcess: (id: SessionMerge.ID, pid: number | undefined) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MergeBinding") {}

const LIVE: SessionMerge.Status[] = ["starting", "live"]
const TOUCH_INTERVAL = 5_000

type Row = typeof SessionMergeBindingTable.$inferSelect

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const state = yield* InstanceState.make(
      Effect.fn("MergeBinding.state")(() =>
        Effect.succeed({
          processes: new Map<SessionMerge.ID, { pid: number; started: number }>(),
          touched: new Map<SessionMerge.ID, number>(),
        }),
      ),
    )

    const toBinding = Effect.fnUntraced(function* (row: Row) {
      const process = (yield* InstanceState.get(state)).processes.get(row.id)
      return {
        id: row.id,
        sessionID: row.session_id,
        adapter: row.adapter,
        transport: row.transport,
        externalSessionID: row.external_session_id ?? undefined,
        cwd: row.cwd,
        status: row.status,
        args: row.args,
        error: row.error ?? undefined,
        time: {
          created: row.time_created,
          updated: row.time_updated,
          lastEvent: row.time_last_event ?? undefined,
          detached: row.time_detached ?? undefined,
        },
        process,
      } satisfies SessionMerge.Binding
    })

    const row = (id: SessionMerge.ID) =>
      db.select().from(SessionMergeBindingTable).where(eq(SessionMergeBindingTable.id, id)).get().pipe(Effect.orDie)

    const publish = Effect.fnUntraced(function* (sessionID: SessionID, id: SessionMerge.ID) {
      const current = yield* row(id)
      yield* events.publish(Event.Updated, { sessionID, binding: current ? yield* toBinding(current) : null })
    })

    const active = Effect.fn("MergeBinding.active")(function* (sessionID: SessionID) {
      const current = yield* db
        .select()
        .from(SessionMergeBindingTable)
        .where(and(eq(SessionMergeBindingTable.session_id, sessionID), inArray(SessionMergeBindingTable.status, LIVE)))
        .get()
        .pipe(Effect.orDie)
      if (!current) return undefined
      return {
        binding: yield* toBinding(current),
        parentModel: current.parent_model ?? undefined,
        pid: current.process_pid ?? undefined,
      } satisfies Entry
    })

    const latest = Effect.fn("MergeBinding.latest")(function* (sessionID: SessionID) {
      const current = yield* db
        .select()
        .from(SessionMergeBindingTable)
        .where(eq(SessionMergeBindingTable.session_id, sessionID))
        .orderBy(desc(SessionMergeBindingTable.time_created))
        .get()
        .pipe(Effect.orDie)
      return current ? yield* toBinding(current) : undefined
    })

    const list = Effect.fn("MergeBinding.list")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(SessionMergeBindingTable)
        .where(eq(SessionMergeBindingTable.session_id, sessionID))
        .orderBy(SessionMergeBindingTable.time_created)
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.forEach(rows, toBinding)
    })

    const create = Effect.fn("MergeBinding.create")(function* (input: CreateInput) {
      const id = SessionMerge.ID.create()
      const conflict = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const bound = yield* tx
              .select({ id: SessionMergeBindingTable.id })
              .from(SessionMergeBindingTable)
              .where(
                and(
                  eq(SessionMergeBindingTable.session_id, input.sessionID),
                  inArray(SessionMergeBindingTable.status, LIVE),
                ),
              )
              .get()
            if (bound) return "bound" as const
            const elsewhere = yield* tx
              .select({ id: SessionMergeBindingTable.id })
              .from(SessionMergeBindingTable)
              .where(
                and(
                  eq(SessionMergeBindingTable.adapter, input.adapter),
                  eq(SessionMergeBindingTable.external_session_id, input.externalSessionID),
                  inArray(SessionMergeBindingTable.status, LIVE),
                  ne(SessionMergeBindingTable.session_id, input.sessionID),
                ),
              )
              .get()
            if (elsewhere) return "external" as const
            yield* tx
              .insert(SessionMergeBindingTable)
              .values({
                id,
                session_id: input.sessionID,
                adapter: input.adapter,
                transport: input.transport,
                external_session_id: input.externalSessionID,
                cwd: input.cwd,
                status: input.status,
                args: [...input.args],
                parent_model: input.parentModel,
              })
              .run()
            return undefined
          }),
        )
        .pipe(Effect.orDie)
      if (conflict === "bound")
        return yield* new AlreadyBound({
          message: "This session is already merged. Run `/merge detach` first.",
        })
      if (conflict === "external")
        return yield* new ExternalInUse({
          message: `${input.adapter} session ${input.externalSessionID} is already merged into another OpenCode session`,
        })
      yield* publish(input.sessionID, id)
      const created = yield* row(id)
      if (!created) return yield* Effect.die(new Error(`merge binding ${id} vanished after insert`))
      return yield* toBinding(created)
    })

    const update = Effect.fn("MergeBinding.update")(function* (
      id: SessionMerge.ID,
      patch: { status?: SessionMerge.Status; externalSessionID?: string; error?: string; parentModel?: ParentModel },
    ) {
      const current = yield* row(id)
      if (!current) return
      yield* db
        .update(SessionMergeBindingTable)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.externalSessionID ? { external_session_id: patch.externalSessionID } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.parentModel ? { parent_model: patch.parentModel } : {}),
          time_updated: Date.now(),
        })
        .where(eq(SessionMergeBindingTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* publish(current.session_id, id)
    })

    const detach = Effect.fn("MergeBinding.detach")(function* (sessionID: SessionID) {
      const current = yield* active(sessionID)
      if (!current) return undefined
      const now = Date.now()
      yield* db
        .update(SessionMergeBindingTable)
        .set({ status: "detached", time_detached: now, time_updated: now, process_pid: null })
        .where(eq(SessionMergeBindingTable.id, current.binding.id))
        .run()
        .pipe(Effect.orDie)
      yield* publish(sessionID, current.binding.id)
      return yield* latest(sessionID)
    })

    const touch = Effect.fn("MergeBinding.touch")(function* (id: SessionMerge.ID) {
      const touched = (yield* InstanceState.get(state)).touched
      const now = Date.now()
      if (now - (touched.get(id) ?? 0) < TOUCH_INTERVAL) return
      touched.set(id, now)
      yield* db
        .update(SessionMergeBindingTable)
        .set({ time_last_event: now })
        .where(eq(SessionMergeBindingTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })

    const setProcess = Effect.fn("MergeBinding.setProcess")(function* (id: SessionMerge.ID, pid: number | undefined) {
      const processes = (yield* InstanceState.get(state)).processes
      void (pid === undefined ? processes.delete(id) : processes.set(id, { pid, started: Date.now() }))
      const current = yield* row(id)
      if (!current) return
      yield* db
        .update(SessionMergeBindingTable)
        .set({ process_pid: pid ?? null, time_last_event: Date.now() })
        .where(eq(SessionMergeBindingTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* publish(current.session_id, id)
    })

    return Service.of({ active, latest, list, create, update, detach, touch, setProcess })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as MergeBinding from "./binding"
