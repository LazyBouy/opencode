export * as OperatorHelperTriggers from "./helper-triggers"

import fs from "fs/promises"
import path from "path"
import { and, asc, eq, gt, isNull, like, lte, not, or } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schedule, Schema, Scope, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { OperatorFolderSql } from "./folder-sql"
import { OperatorHelperAgents } from "./helper-agents"
import { OperatorHelperFiles } from "./helper-files"
import { OperatorHelperRuns } from "./helper-runs"
import { OperatorHelperTriggerRules as Rules } from "./helper-trigger-rules"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"

// Helper triggers (agent_types_spec.md §4.9; the user's choices of 2026-10-13): what starts a helper on its own.
// - Schedules (hourly, daily, weekly, cron), in the time zone saved with them (the browser's when they were set).
//   Checked every 30 seconds; a schedule due while the server was down runs once when it is back. A trigger that
//   is off, changed or paused starts afresh: what it missed doesn't run.
// - Sessions untouched for N days: checked hourly; one run gets the namespace's sessions that crossed N days since
//   the last check (50 at most, the rest at the next check).
// - An agent finished a turn (`session.idle`): one run per turn, in the session's project. Helper runs and
//   subagent sessions never fire it.
// - A project was created (the console recorded it, profile-store.ts): one run, in the new project.
// A run of a schedule or of untouched sessions is in the namespace's default project. Each trigger runs one at a
// time and at most its runs an hour (20 by default); more starts are skipped and counted. "Pause all triggers"
// (Helper settings) stops them all; Run now starts a schedule or the untouched check by hand, paused or not.
// What a trigger fired, when, and why it failed is kept in <data>/operator/helper-runs/triggers.json.

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const BATCH = 50

export const Status = Schema.Struct({
  id: Schema.String,
  next: Schema.optional(Schema.Finite).annotate({ description: "A schedule's next start (ms); before now: due" }),
  lastFired: Schema.optional(Schema.Finite),
  running: Schema.Boolean.annotate({ description: "A run it started is running or waiting for the previous one" }),
  skipped: Schema.optional(Schema.Finite).annotate({
    description: "Starts skipped in the last hour: it had reached its runs an hour",
  }),
  error: Schema.optional(Schema.String).annotate({ description: "Why its last start or run failed" }),
}).annotate({ identifier: "OperatorHelperTriggerStatus" })
export type Status = typeof Status.Type

export class TriggerError extends Schema.TaggedErrorClass<TriggerError>()("OperatorHelperTriggerError", {
  message: Schema.String,
}) {}

type State = {
  /** Schedules: a due time after this starts it. */
  base?: number
  /** Schedules: the schedule `base` was set for. */
  signature?: string
  /** Untouched sessions: the last check, and the newest last use reported. */
  checkedAt?: number
  reported?: number
  /** The last check found more than one run takes. */
  more?: boolean
  lastFired?: number
  /** Starts in the last hour (its runs an hour), and starts skipped. */
  fired?: number[]
  skipped?: number[]
  error?: string
}

type Entry = { namespace: string; helper: OperatorHelperFiles.Stored; trigger: OperatorHelperFiles.Trigger }

const stateFile = () => path.join(Global.Path.data, "operator", "helper-runs", "triggers.json")
const keyOf = (entry: { namespace: string; name: string; id: string }) =>
  `${entry.namespace}\n${entry.name}\n${entry.id}`
const recent = (times: ReadonlyArray<number> | undefined, now: number) => (times ?? []).filter((at) => now - at < HOUR)

async function readState(): Promise<Record<string, State>> {
  const data = await Bun.file(stateFile())
    .json()
    .catch(() => undefined)
  return data && typeof data === "object" ? (data as Record<string, State>) : {}
}

export interface Interface {
  /** Starts what is due now: schedules, and the untouched sessions' check. */
  readonly check: (now?: number) => Effect.Effect<void>
  /** Starts a schedule or the untouched check now (Run now), paused or not; one run at a time still. */
  readonly fire: (input: { namespace: string; name: string; id: string }) => Effect.Effect<boolean, TriggerError>
  /** A helper's triggers: next start, last start, skipped starts and the last error. */
  readonly status: (namespace: string, name: string) => Effect.Effect<Status[]>
  /** An agent finished a turn in this session. */
  readonly turn: (sessionID: string) => Effect.Effect<void>
  /** Waits until the events received so far are handled and the runs started have ended. */
  readonly idle: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorHelperTriggers") {}

// Events start runs through the service built last: another still alive (being released) would start them twice.
let current: object | undefined

/** The scheduler runs on its own unless this is a test run (tests call `check`); OPENCODE_HELPER_TRIGGERS=on|off. */
export function loopOn(env: NodeJS.ProcessEnv = process.env) {
  return (env.OPENCODE_HELPER_TRIGGERS ?? (env.OPENCODE_TEST_HOME ? "off" : "on")) !== "off"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const db = (yield* Database.Service).db
    const store = yield* OperatorProfileStore.Service
    const runs = yield* OperatorHelperRuns.Service
    const instances = yield* InstanceStore.Service
    const bridge = yield* EffectBridge.make()
    const fail = (message: string) => new TriggerError({ message })

    const state: Record<string, State> = yield* Effect.promise(readState)
    const stateOf = (key: string) => (state[key] ??= {})
    // Written in turn, and only when it changed.
    let written = JSON.stringify(state, null, 2)
    let writing = Promise.resolve()
    const save = () =>
      Effect.promise(() => {
        writing = writing.then(async () => {
          const text = JSON.stringify(state, null, 2)
          if (text === written) return
          written = text
          await fs.mkdir(path.dirname(stateFile()), { recursive: true })
          await Bun.write(stateFile(), text)
        })
        // A failed write is tried again at the next change.
        writing = writing.catch(() => {
          written = ""
        })
        return writing
      })

    // Every trigger of every namespace's helpers.
    const entries = Effect.fnUntraced(function* () {
      const found: Entry[] = []
      for (const item of yield* store.namespaces()) {
        const helpers = yield* Effect.promise(() => OperatorHelperFiles.read(item.namespace.id))
        for (const helper of helpers)
          for (const trigger of helper.triggers ?? []) found.push({ namespace: item.namespace.id, helper, trigger })
      }
      return found
    })
    // Kept for events: read again when a helper changes, or after 30 seconds.
    let cached: { at: number; revision: number; entries: Entry[] } | undefined
    const eventEntries = Effect.fnUntraced(function* (on: OperatorHelperFiles.Trigger["on"]) {
      const revision = OperatorHelperFiles.helperRevision()
      if (!cached || cached.revision !== revision || Date.now() - cached.at > 30_000)
        cached = { at: Date.now(), revision, entries: yield* entries() }
      return cached.entries.filter((entry) => entry.trigger.enabled && entry.trigger.on === on)
    })

    const projectsOf = Effect.fnUntraced(function* (ns: string) {
      return (yield* store.projects()).filter((item) => item.namespace === ns).map((item) => item.key)
    })

    // Runs, one at a time per trigger; `inFlight` counts the runs started and not ended.
    const locks = new Map<string, Semaphore.Semaphore>()
    const running = new Map<string, number>()
    let inFlight = 0

    // Starts a run of the entry's helper in `project`, unless paused or over its runs an hour (by hand: always).
    // Whether it started.
    const start = Effect.fnUntraced(function* (
      entry: Entry,
      input: { project: string | undefined; text: string; manual?: boolean },
    ) {
      const key = keyOf({ namespace: entry.namespace, name: entry.helper.name, id: entry.trigger.id })
      const found = stateOf(key)
      const now = Date.now()
      if (!input.manual && (yield* runs.settings()).triggersPaused) return false
      if (!input.project) {
        found.error = "This namespace has no project to run in"
        yield* save()
        return false
      }
      const fired = recent(found.fired, now)
      if (!input.manual && fired.length >= (entry.trigger.maxPerHour ?? Rules.MAX_PER_HOUR.default)) {
        found.skipped = [...recent(found.skipped, now), now].slice(-1000)
        found.fired = fired
        yield* save()
        return false
      }
      found.fired = [...fired, now]
      found.lastFired = now
      yield* save()
      const lock = locks.get(key) ?? Semaphore.makeUnsafe(1)
      locks.set(key, lock)
      running.set(key, (running.get(key) ?? 0) + 1)
      inFlight++
      const project = input.project
      const run = instances.provide(
        { directory: project },
        runs.run({
          namespace: entry.namespace,
          name: entry.helper.name,
          input: input.text,
          startedBy: { kind: "trigger", trigger: entry.trigger.id, event: Rules.describe(entry.trigger) },
        }),
      )
      yield* lock
        .withPermits(1)(run)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              delete stateOf(key).error
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const error = Cause.squash(cause)
              stateOf(key).error = error instanceof Error ? error.message : String(error)
            }),
          ),
          Effect.ensuring(
            Effect.andThen(
              Effect.sync(() => {
                running.set(key, (running.get(key) ?? 1) - 1)
                inFlight--
              }),
              save(),
            ),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      return true
    })

    const header = (entry: Entry, manual?: boolean) =>
      manual
        ? `Started by hand (Run now) for its trigger: ${Rules.describe(entry.trigger)}.`
        : `Started by its trigger: ${Rules.describe(entry.trigger)}.`
    const withInput = (entry: Entry, lines: ReadonlyArray<string>) =>
      [...lines, ...(entry.trigger.input ? ["", entry.trigger.input] : [])].join("\n")

    // A schedule: due after its base, it starts once (missed starts included) in the namespace's default project.
    const schedule = Effect.fnUntraced(function* (entry: Entry, now: number, manual?: boolean) {
      const key = keyOf({ namespace: entry.namespace, name: entry.helper.name, id: entry.trigger.id })
      const found = stateOf(key)
      const signature = Rules.signature(entry.trigger)
      if (!manual) {
        if (!entry.trigger.enabled || found.signature !== signature || found.base === undefined) {
          found.base = now
          found.signature = signature
          return false
        }
        const due = Rules.nextAt(entry.trigger, found.base)
        if (due === undefined) {
          found.error = "Its schedule can't be read"
          return false
        }
        if (due > now) return false
        found.base = now
      }
      const project = yield* store.defaultProject(entry.namespace)
      return yield* start(entry, {
        project,
        manual,
        text: withInput(entry, [`${header(entry, manual)} It is ${new Date(now).toISOString()}.`]),
      })
    })

    // Sessions untouched for N days: those that crossed N days since the last check, oldest first, in one run.
    const untouched = Effect.fnUntraced(function* (entry: Entry, now: number, manual?: boolean) {
      const key = keyOf({ namespace: entry.namespace, name: entry.helper.name, id: entry.trigger.id })
      const found = stateOf(key)
      if (!manual) {
        if (!entry.trigger.enabled) return false
        if (found.checkedAt !== undefined && now - found.checkedAt < HOUR && !found.more) return false
        found.checkedAt = now
      }
      const days = entry.trigger.days ?? Rules.UNTOUCHED_DAYS.min
      const keys = yield* projectsOf(entry.namespace)
      // By hand: every untouched session (the first 50), and what was reported stays.
      const after = manual ? 0 : (found.reported ?? 0)
      const rows = keys.length
        ? yield* db
            .select({
              id: SessionTable.id,
              title: SessionTable.title,
              agent: SessionTable.agent,
              directory: SessionTable.directory,
              updated: SessionTable.time_updated,
            })
            .from(SessionTable)
            .where(
              and(
                or(...keys.map((item) => OperatorFolderSql.within(SessionTable.directory, item))),
                isNull(SessionTable.parent_id),
                isNull(SessionTable.time_archived),
                or(isNull(SessionTable.agent), not(like(SessionTable.agent, `${OperatorHelperAgents.PREFIX}%`))),
                gt(SessionTable.time_updated, after),
                lte(SessionTable.time_updated, now - days * DAY),
              ),
            )
            .orderBy(asc(SessionTable.time_updated))
            .limit(BATCH)
            .all()
            .pipe(Effect.orDie)
        : []
      if (!manual) found.more = rows.length === BATCH
      if (!rows.length) return false
      const project = yield* store.defaultProject(entry.namespace)
      const started = yield* start(entry, {
        project,
        manual,
        text: withInput(entry, [
          header(entry, manual),
          `These sessions of this namespace's projects were last used more than ${days} days ago (oldest first):`,
          ...rows.map(
            (row) =>
              `- ${row.id} · ${row.title} · ${row.agent ?? "-"} · ${row.directory} · last used ${new Date(row.updated).toISOString()}`,
          ),
        ]),
      })
      // Reported once started; skipped (paused, or over its runs an hour), they come again at the next check.
      if (started && !manual) found.reported = rows.at(-1)!.updated
      return started
    })

    const checking = Semaphore.makeUnsafe(1)
    const check = (now = Date.now()) =>
      checking
        .withPermits(1)(
          Effect.gen(function* () {
            const all = yield* entries()
            const keys = new Set(
              all.map((entry) => keyOf({ namespace: entry.namespace, name: entry.helper.name, id: entry.trigger.id })),
            )
            // Removed triggers forget their state.
            for (const key of Object.keys(state)) if (!keys.has(key)) delete state[key]
            const paused = (yield* runs.settings()).triggersPaused === true
            for (const entry of all) {
              if (Rules.isSchedule(entry.trigger)) {
                // Paused, a schedule starts afresh when it is resumed.
                if (paused) {
                  const found = stateOf(
                    keyOf({ namespace: entry.namespace, name: entry.helper.name, id: entry.trigger.id }),
                  )
                  found.base = now
                  found.signature = Rules.signature(entry.trigger)
                  continue
                }
                yield* schedule(entry, now)
              } else if (entry.trigger.on === "session.untouched" && !paused) yield* untouched(entry, now)
            }
            yield* save()
          }),
        )
        .pipe(Effect.ignore)

    const fire = Effect.fn("OperatorHelperTriggers.fire")(function* (input: {
      namespace: string
      name: string
      id: string
    }) {
      const helper = yield* Effect.promise(() => OperatorHelperFiles.readOne(input.namespace, input.name))
      const trigger = helper?.triggers?.find((item) => item.id === input.id)
      if (!helper || !trigger) return yield* fail(`No trigger ${input.id} on helper "${input.name}"`)
      const entry: Entry = { namespace: input.namespace, helper, trigger }
      if (Rules.isSchedule(trigger)) return yield* schedule(entry, Date.now(), true)
      if (trigger.on === "session.untouched") return yield* untouched(entry, Date.now(), true)
      return yield* fail("Run now starts a schedule or the untouched sessions' check; this trigger waits for its event")
    })

    const status = Effect.fn("OperatorHelperTriggers.status")(function* (namespace: string, name: string) {
      const helper = yield* Effect.promise(() => OperatorHelperFiles.readOne(namespace, name))
      const paused = (yield* runs.settings()).triggersPaused === true
      const now = Date.now()
      return (helper?.triggers ?? []).map((trigger): Status => {
        const key = keyOf({ namespace, name, id: trigger.id })
        const found = state[key] ?? {}
        const fresh = found.signature !== Rules.signature(trigger)
        const next =
          Rules.isSchedule(trigger) && trigger.enabled && !paused
            ? Rules.nextAt(trigger, fresh ? now : (found.base ?? now))
            : undefined
        const skipped = recent(found.skipped, now).length
        return {
          id: trigger.id,
          ...(next !== undefined ? { next } : {}),
          ...(found.lastFired !== undefined ? { lastFired: found.lastFired } : {}),
          running: (running.get(key) ?? 0) > 0,
          ...(skipped ? { skipped } : {}),
          ...(found.error ? { error: found.error } : {}),
        }
      })
    })

    // An agent finished a turn: the triggers of the session's project's namespace, in that project.
    const seen = new Map<string, number>()
    const turn = Effect.fn("OperatorHelperTriggers.turn")(function* (sessionID: string) {
      const now = Date.now()
      // session.idle and session.status (idle) both come: once.
      if (now - (seen.get(sessionID) ?? 0) < 5_000) return
      seen.set(sessionID, now)
      if (seen.size > 1000) for (const [id, at] of seen) if (now - at > 60_000) seen.delete(id)
      const watched = yield* eventEntries("session.turn")
      if (!watched.length) return
      const row = yield* db
        .select({
          id: SessionTable.id,
          title: SessionTable.title,
          agent: SessionTable.agent,
          directory: SessionTable.directory,
          parent: SessionTable.parent_id,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(sessionID)))
        .get()
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!row || row.parent || (row.agent && OperatorHelperAgents.isHelper(row.agent))) return
      const project = yield* Effect.promise(() => OperatorProjects.projectOf(row.directory))
      if (!project) return
      const namespace = (yield* store.projects()).find((item) => item.key === project.key)?.namespace
      for (const entry of watched.filter((item) => item.namespace === namespace))
        yield* start(entry, {
          project: project.key,
          text: withInput(entry, [
            header(entry),
            `Session: ${row.id} · ${row.title} · agent ${row.agent ?? "-"} · project ${project.key}`,
          ]),
        })
    })

    const created = Effect.fnUntraced(function* (project: OperatorProfileStore.CreatedProject) {
      for (const entry of (yield* eventEntries("project.created")).filter(
        (item) => item.namespace === project.namespace,
      ))
        yield* start(entry, {
          project: project.key,
          text: withInput(entry, [
            header(entry),
            `Project: ${project.name} · id ${project.id} · ${project.key} · namespace ${project.namespace}`,
          ]),
        })
    })

    // Events being handled (a turn, a new project): idle waits for them too.
    let handling = 0
    const handle = (effect: Effect.Effect<void>) => {
      handling++
      bridge.fork(effect.pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => handling--))))
    }
    const idle = () =>
      Effect.gen(function* () {
        while (inFlight > 0 || handling > 0) yield* Effect.sleep("20 millis")
      })

    const token = {}
    const onEvent = (event: GlobalEvent) => {
      if (current !== token) return
      const payload = event.payload as
        | { type?: string; properties?: { sessionID?: string; status?: { type?: string } } }
        | undefined
      const finished =
        payload?.type === "session.idle" ||
        (payload?.type === "session.status" && payload.properties?.status?.type === "idle")
      const id = payload?.properties?.sessionID
      if (finished && id) handle(turn(id))
    }
    const onCreated = (project: OperatorProfileStore.CreatedProject) => {
      if (current === token) handle(created(project))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        current = token
        GlobalBus.on("event", onEvent)
        OperatorProfileStore.projectCreated.add(onCreated)
      }),
      () =>
        Effect.sync(() => {
          if (current === token) current = undefined
          GlobalBus.off("event", onEvent)
          OperatorProfileStore.projectCreated.delete(onCreated)
        }),
    )
    if (loopOn())
      yield* check().pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.delay("5 seconds"), Effect.forkIn(scope))

    return Service.of({ check, fire, status, turn, idle })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, OperatorProfileStore.node, OperatorHelperRuns.node, InstanceStore.node],
})
