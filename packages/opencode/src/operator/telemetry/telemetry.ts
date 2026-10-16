export * as OperatorTelemetry from "./telemetry"

import path from "path"
import { asc, eq, gte, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schedule, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { InstanceStore } from "@/project/instance-store"
import { OperatorCallStore } from "../call-store"
import { OperatorHelperAgents } from "../helper-agents"
import { OperatorPermissionDecisions } from "../permission-decisions"
import { OperatorProjects } from "../projects"
import { OperatorQueueStore } from "../queue-store"
import { OperatorRegistry } from "../registry"
import { OperatorTelemetryBackfill } from "./backfill"
import { OperatorTelemetryBatch } from "./batch"
import { OperatorTelemetryCalls } from "./calls"
import { OperatorTelemetryDerive } from "./derive"
import { OperatorTelemetryIngest } from "./ingest"
import { OperatorTelemetryLogs } from "./logs"
import { OperatorTelemetryNames } from "./names"
import { OperatorTelemetryRetention } from "./retention"
import { OperatorTelemetryStore } from "./store"
import { OperatorTelemetryWriter } from "./writer"

// Observability's recorder (observability_spec.md §4–§5): a server-wide service that turns GlobalBus events, decision
// records, helper runs and Trash moves into spans (ingest.ts), and writes them to the telemetry store about once a
// second, or every 500 rows, in one transaction (§5.6). After each write it works out what depends on the rows
// (derive.ts), and announces the highest `seq` with `operator.telemetry.written`, at most once a second, for the live
// tail. It also tails the server log (§5.8) and samples approvals, running sessions, the queue and MCP servers every
// 60 s (§5.9). Spans left running by a server that stopped become `interrupted` at startup (§5.7). Nothing here can
// delay or fail a session: handlers only queue rows, and errors go to the log at WARN with service=operator-telemetry.

export const WRITTEN = "operator.telemetry.written"
const SERVICE = "operator-telemetry"
const FLUSH_ROWS = 500
const FLUSH_MS = 1_000
const MCP_ACTIVE_MS = 15 * 60 * 1000

export type Settings = {
  enabled: boolean
  loops: OperatorTelemetryDerive.Loops
  logLevel: OperatorTelemetryLogs.Level
  eventsDays: number
  totalsDays: number
  dailyBudget: number | undefined
  stuckMinutes: number
  queueMinutes: number
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  loops: OperatorTelemetryDerive.DEFAULT_LOOPS,
  logLevel: "warn",
  ...OperatorTelemetryRetention.days({}),
  dailyBudget: undefined,
  stuckMinutes: 10,
  queueMinutes: 10,
}

/** The settings in a config's `operatorTelemetry`, with defaults. */
export function settingsOf(config: { operatorTelemetry?: Record<string, any> } | undefined): Settings {
  const value = config?.operatorTelemetry ?? {}
  const loops = value.loops ?? {}
  const positive = (number: unknown, fallback: number) =>
    typeof number === "number" && Number.isFinite(number) && number > 0 ? number : fallback
  return {
    enabled: value.enabled !== false,
    loops: {
      sameCallSameResult: positive(loops.sameCallSameResult, DEFAULT_SETTINGS.loops.sameCallSameResult),
      sameCall: positive(loops.sameCall, DEFAULT_SETTINGS.loops.sameCall),
      toolCalls: positive(loops.toolCalls, DEFAULT_SETTINGS.loops.toolCalls),
      modelCalls: positive(loops.modelCalls, DEFAULT_SETTINGS.loops.modelCalls),
    },
    logLevel: value.logLevel === "error" || value.logLevel === "info" ? value.logLevel : "warn",
    ...OperatorTelemetryRetention.days(value),
    dailyBudget: typeof value.dailyBudget === "number" && value.dailyBudget > 0 ? value.dailyBudget : undefined,
    stuckMinutes: positive(value.dashboard?.stuckMinutes, DEFAULT_SETTINGS.stuckMinutes),
    queueMinutes: positive(value.dashboard?.queueMinutes, DEFAULT_SETTINGS.queueMinutes),
  }
}

/** Whether the recorder's own loops run (flushing, the log tail, the sampler). Off in tests, which call them. */
export function loopOn(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCODE_TELEMETRY === "on") return true
  if (env.OPENCODE_TELEMETRY === "off") return false
  return !env.OPENCODE_TEST_HOME
}

export interface Interface {
  /** Writes what is waiting now. */
  readonly flush: () => Effect.Effect<void>
  /** Reads new server log lines. */
  readonly tail: () => Effect.Effect<void>
  /** Takes one round of samples. */
  readonly sample: () => Effect.Effect<void>
  /** The event handler's state (tests feed it). */
  readonly ingest: OperatorTelemetryIngest.Ingest
  /** Rows dropped because the backlog was full (§5.6). */
  readonly dropped: () => number
  /** Builds history from the stored sessions (§5.11), in the background of whoever runs it. */
  readonly backfill: (input?: { log?: boolean }) => Effect.Effect<void>
  /** Starts building history again in the background (Rebuild from history); its progress at once. */
  readonly rebuild: () => Effect.Effect<OperatorTelemetryBackfill.Progress>
  readonly progress: () => OperatorTelemetryBackfill.Progress
  readonly settings: () => Settings
  /** Purges what retention no longer keeps (§6.1). */
  readonly purge: () => Effect.Effect<OperatorTelemetryRetention.Purged>
  /** Recomputes the hourly totals of hours whose spans changed (§6.2). */
  readonly totals: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorTelemetry") {}

// The latest service is the one that records (tests build several).
let current: object | undefined

type SessionContext = OperatorTelemetryDerive.Context

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const config = yield* Config.Service
    const instances = yield* InstanceStore.Service
    const mcp = yield* MCP.Service
    const scope = yield* Scope.Scope
    const token = {}
    const store = OperatorTelemetryStore.store()
    const started = Date.now() - Math.round(process.uptime() * 1000)
    let settings = DEFAULT_SETTINGS
    let batch = new OperatorTelemetryBatch.Batch()
    // While a flush reads recorded calls, what they replace goes into the batch being written.
    let writing: OperatorTelemetryBatch.Batch | undefined
    let dropped = Number(store.meta("dropped") ?? 0)
    let failures = 0
    // The MCP servers of each folder, from the last sample, and their last status.
    const servers = new Map<string, string[]>()
    const statuses = new Map<string, string>()

    const ingest = new OperatorTelemetryIngest.Ingest(() => writing ?? batch, {
      secret: store.meta("secret") ?? "",
      mcpServerOf: (directory, tool) => {
        if (!directory) return undefined
        return servers.get(directory)?.find((server) => tool.startsWith(McpCatalog.toolName(server, "")))
      },
    })

    const warn = (message: string, cause: unknown) =>
      Effect.logWarning(message, { service: SERVICE, error: cause instanceof Error ? cause.message : String(cause) })

    // ---- the sessions' context: title, agent, project, parent and root ----

    const contexts = new Map<string, SessionContext>()
    const lookup = Effect.fnUntraced(function* (missing: ReadonlyArray<string>) {
      const rows = yield* db
        .select({
          id: SessionTable.id,
          directory: SessionTable.directory,
          project: SessionTable.project_id,
          parent: SessionTable.parent_id,
          title: SessionTable.title,
          agent: SessionTable.agent,
        })
        .from(SessionTable)
        .where(inArray(SessionTable.id, missing as never[]))
        .all()
        .pipe(Effect.orDie)
      const projectIDs = [...new Set(rows.map((row) => row.project))]
      const projects = projectIDs.length
        ? yield* db
            .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
            .from(ProjectTable)
            .where(inArray(ProjectTable.id, projectIDs as never[]))
            .all()
            .pipe(Effect.orDie)
        : []
      const worktrees = new Map(projects.map((row) => [String(row.id), row.worktree]))
      for (const row of rows) {
        const key = yield* Effect.promise(() =>
          OperatorProjects.keyOf({ directory: row.directory, worktree: worktrees.get(String(row.project)) ?? "/" }),
        )
        contexts.set(row.id, {
          title: row.title,
          ...(row.agent ? { agent: row.agent } : {}),
          agentType: row.parent ? "subagent" : row.agent?.startsWith(OperatorHelperAgents.PREFIX) ? "helper" : "usual",
          projectKey: key,
          directory: row.directory,
          ...(row.parent ? { parentID: row.parent } : {}),
          trashed: store.session(row.id)?.trashed === 1,
        })
      }
      // Not in the database (yet): what its events said.
      for (const id of missing.filter((id) => !contexts.has(id))) {
        const info = ingest.infos.get(id)
        contexts.set(id, {
          ...(info?.title ? { title: info.title } : {}),
          ...(info?.directory ? { directory: info.directory } : {}),
          ...(info?.parentID ? { parentID: info.parentID } : {}),
          agentType: info?.parentID ? "subagent" : "usual",
          trashed: store.session(id)?.trashed === 1,
        })
      }
    })
    // The sessions' context, and their parents' up to the root.
    const resolve = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
      let wanted = [...new Set(ids)]
      for (let depth = 0; depth < 32 && wanted.length; depth++) {
        const missing = wanted.filter((id) => !contexts.has(id))
        if (missing.length) yield* lookup(missing)
        wanted = wanted
          .map((id) => contexts.get(id)?.parentID)
          .filter((id): id is string => !!id && !contexts.get(id)?.rootID)
      }
      for (const id of ids) {
        const found = contexts.get(id)
        if (!found || found.rootID) continue
        let root = id
        const seen = new Set<string>()
        while (contexts.get(root)?.parentID && !seen.has(root)) {
          seen.add(root)
          root = contexts.get(root)!.parentID!
        }
        found.rootID = root
      }
    })
    const contextOf = (id: string): SessionContext => {
      const found = contexts.get(id) ?? {}
      const title = ingest.infos.get(id)?.title
      return title ? { ...found, title } : found
    }

    // ---- writing ----

    const queueSpan = (item: OperatorQueueStore.Item): OperatorTelemetryStore.SpanWrite => {
      const done = item.status !== "queued"
      const end = item.deliveredAt ?? (done ? Date.now() : undefined)
      return {
        id: `queue:${item.id}`,
        kind: "queue_item",
        name: OperatorTelemetryNames.name("queue_item", item.agent),
        ...(item.deliveredTo ? { session_id: item.deliveredTo } : {}),
        project_key: item.project,
        directory: item.project,
        agent: item.agent,
        status:
          item.status === "queued"
            ? "running"
            : item.status === "delivered"
              ? "ok"
              : item.status === "failed"
                ? "error"
                : "cancelled",
        ...(item.status === "failed" ? { error_type: "delivery_failed" } : {}),
        ...(item.error ? { error_message: item.error.slice(0, 500) } : {}),
        start_ms: item.createdAt,
        ...(end
          ? { end_ms: end, duration_ms: Math.max(0, end - item.createdAt), wait_ms: Math.max(0, end - item.createdAt) }
          : {}),
        source: "queue",
        attrs: JSON.stringify({ priority: item.priority, steer: item.steer, target: item.target }),
      }
    }

    let lastFlush = 0
    let lastEmit = 0
    let emitted = store.lastSeq()
    const write = Effect.fnUntraced(function* () {
      const taken = batch
      batch = new OperatorTelemetryBatch.Batch()
      lastFlush = Date.now()
      dropped += taken.dropped
      if (taken.empty() && !taken.dropped) return
      // Recorded calls replace their messages' rows, in this batch.
      writing = taken
      try {
        for (const sessionID of taken.calls) {
          const calls = yield* Effect.promise(() => OperatorCallStore.list(sessionID).catch(() => []))
          for (const span of OperatorTelemetryCalls.spans({ sessionID, calls, ingest })) taken.span(span)
        }
      } finally {
        writing = undefined
      }
      for (const id of taken.queue) {
        const item = OperatorQueueStore.store().get(id)
        if (item) taken.span(queueSpan(item))
      }
      const ids = new Set<string>([...taken.sessions, ...taken.trash.keys()])
      for (const span of taken.spans.values()) if (span.session_id) ids.add(span.session_id)
      for (const id of taken.deletedSessions) ids.delete(id)
      yield* resolve([...ids])
      for (const [id, trashed] of taken.trash) {
        const found = contexts.get(id)
        if (found) found.trashed = trashed
      }
      for (const span of taken.spans.values()) {
        const context = span.session_id ? contexts.get(span.session_id) : undefined
        if (!context) continue
        span.root_session_id ??= context.rootID ?? span.session_id
        if (context.projectKey) span.project_key ??= context.projectKey
        if (context.directory) span.directory ??= context.directory
        if (context.agentType) span.agent_type ??= context.agentType
      }
      OperatorTelemetryWriter.apply(store, taken, {
        sessions: ids,
        contextOf,
        loops: settings.loops,
        dropped,
        now: Date.now(),
      })
      if (store.lastSeq() !== emitted && Date.now() - lastEmit >= FLUSH_MS) {
        emitted = store.lastSeq()
        lastEmit = Date.now()
        GlobalBus.emit("event", { payload: { type: WRITTEN, properties: { seq: emitted } } })
      }
    })
    const flush = () =>
      write().pipe(
        Effect.catchCause((cause) => {
          failures += 1
          return warn("telemetry write failed", cause)
        }),
      )

    const logFile = path.join(Global.Path.log, "opencode.log")

    // ---- building history (§5.11) ----

    let progress: OperatorTelemetryBackfill.Progress =
      (() => {
        try {
          const stored = store.meta("backfill")
          const value = stored ? (JSON.parse(stored) as OperatorTelemetryBackfill.Progress) : undefined
          // One a stopped server left running starts again.
          return value?.state === "running" ? { ...value, state: "failed" as const, error: "server stopped" } : value
        } catch {
          return undefined
        }
      })() ?? OperatorTelemetryBackfill.IDLE
    const firstStart = !store.meta("backfill")
    const save = (next: OperatorTelemetryBackfill.Progress) => {
      progress = next
      store.setMeta("backfill", JSON.stringify(next))
    }

    const run = (input: { log?: boolean } = {}) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const startSeq = store.lastSeq()
        const since = startedAt - settings.eventsDays * OperatorTelemetryRetention.DAY
        const sessions = yield* db
          .select({
            id: SessionTable.id,
            parent: SessionTable.parent_id,
            title: SessionTable.title,
            directory: SessionTable.directory,
          })
          .from(SessionTable)
          .where(gte(SessionTable.time_updated, since))
          .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
          .all()
          .pipe(Effect.orDie)
        save({ state: "running", done: 0, total: sessions.length, startedAt })
        let clock = startedAt
        let pending = new OperatorTelemetryBatch.Batch()
        const replayer = new OperatorTelemetryIngest.Ingest(() => pending, {
          secret: store.meta("secret") ?? "",
          backfill: true,
          now: () => clock,
        })
        // A batch to the store; a row a live event wrote since the backfill started wins (§5.11).
        const commit = Effect.fnUntraced(function* () {
          const taken = pending
          pending = new OperatorTelemetryBatch.Batch()
          for (const [id] of taken.spans) {
            const existing = store.span(id)
            if (existing && existing.seq > startSeq && existing.source !== "backfill") taken.spans.delete(id)
          }
          const ids = new Set<string>(taken.sessions)
          for (const span of taken.spans.values()) if (span.session_id) ids.add(span.session_id)
          yield* resolve([...ids])
          for (const span of taken.spans.values()) {
            const context = span.session_id ? contexts.get(span.session_id) : undefined
            if (!context) continue
            span.root_session_id ??= context.rootID ?? span.session_id
            if (context.projectKey) span.project_key ??= context.projectKey
            if (context.directory) span.directory ??= context.directory
            if (context.agentType) span.agent_type ??= context.agentType
          }
          OperatorTelemetryWriter.apply(store, taken, {
            sessions: ids,
            contextOf,
            loops: settings.loops,
            now: Date.now(),
          })
          yield* Effect.sleep(`${OperatorTelemetryBackfill.PAUSE_MS} millis`)
        })
        let done = 0
        for (const session of sessions) {
          const [messages, parts] = yield* Effect.all([
            db
              .select({ id: MessageTable.id, data: MessageTable.data })
              .from(MessageTable)
              .where(eq(MessageTable.session_id, session.id))
              .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
              .all()
              .pipe(Effect.orDie),
            db
              .select({ id: PartTable.id, message_id: PartTable.message_id, data: PartTable.data })
              .from(PartTable)
              .where(eq(PartTable.session_id, session.id))
              .orderBy(asc(PartTable.message_id), asc(PartTable.id))
              .all()
              .pipe(Effect.orDie),
          ])
          OperatorTelemetryBackfill.replay(
            replayer,
            session,
            messages as unknown as OperatorTelemetryBackfill.Message[],
            parts as unknown as OperatorTelemetryBackfill.Part[],
            (time) => {
              clock = time
            },
          )
          const calls = yield* Effect.promise(() => OperatorCallStore.list(session.id).catch(() => []))
          for (const span of OperatorTelemetryCalls.spans({ sessionID: session.id, calls, ingest: replayer }))
            pending.span({ ...span, source: "backfill" })
          const decisions = yield* Effect.promise(() =>
            OperatorPermissionDecisions.read({ sessionID: session.id, limit: 100_000 }).catch(() => []),
          )
          for (const record of decisions.toSorted((a, b) => a.askedAt - b.askedAt)) replayer.decision(record)
          done += 1
          if (pending.size() >= OperatorTelemetryBackfill.BATCH) {
            yield* commit()
            save({ ...progress, done })
          }
        }
        for (const item of OperatorQueueStore.store().list({ limit: 100_000 }))
          if (item.createdAt >= since) pending.span({ ...queueSpan(item), source: "backfill" })
        // The server log's last part, on a first backfill.
        if (input.log) {
          let at: OperatorTelemetryLogs.Position | undefined
          for (let step = 0; step < 20; step++) {
            const read = yield* Effect.promise(() =>
              OperatorTelemetryLogs.read({
                file: logFile,
                position: at,
                level: settings.logLevel,
                fromStart: OperatorTelemetryBackfill.LOG_BYTES,
              }),
            )
            for (const entry of read.entries) pending.log(entry)
            if (!read.position || (at && read.position.offset === at.offset)) break
            at = read.position
            if (pending.size() >= OperatorTelemetryBackfill.BATCH) yield* commit()
          }
        }
        yield* commit()
        save({ state: "done", done, total: sessions.length, startedAt, finishedAt: Date.now() })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            save({ ...progress, state: "failed", finishedAt: Date.now(), error: String(cause).slice(0, 500) }),
          ).pipe(Effect.andThen(warn("telemetry backfill failed", cause))),
        ),
      )

    const backfill = (input: { log?: boolean } = {}) =>
      Effect.suspend(() => (progress.state === "running" ? Effect.void : run(input)))
    const rebuild = () =>
      Effect.gen(function* () {
        if (progress.state === "running") return progress
        save({ state: "running", done: 0, total: 0, startedAt: Date.now() })
        yield* run().pipe(Effect.forkIn(scope))
        return progress
      })

    // ---- retention and totals (§6) ----

    const purge = () =>
      Effect.sync(() => {
        const result = OperatorTelemetryRetention.purge(store, {
          eventsDays: settings.eventsDays,
          totalsDays: settings.totalsDays,
          now: Date.now(),
        })
        // Sessions that lost spans but keep some: their summary from what is left.
        if (result.touched.size)
          store.transaction(() => {
            for (const id of result.touched) {
              const row = store.session(id)
              if (row) OperatorTelemetryDerive.session(store, id, OperatorTelemetryWriter.contextOf(row), Date.now())
            }
          })
        const { touched, ...counts } = result
        return counts
      }).pipe(
        Effect.catchCause((cause) =>
          warn("telemetry purge failed", cause).pipe(
            Effect.as({ spans: 0, logs: 0, samples: 0, mcp: 0, sessions: 0, totals: 0 }),
          ),
        ),
      )
    const totals = () =>
      Effect.sync(() => OperatorTelemetryWriter.totals(store)).pipe(
        Effect.catchCause((cause) => warn("telemetry totals failed", cause).pipe(Effect.as(0))),
      )

    // ---- the server log ----

    let position: OperatorTelemetryLogs.Position | undefined = (() => {
      try {
        const stored = store.meta("log_position")
        return stored ? (JSON.parse(stored) as OperatorTelemetryLogs.Position) : undefined
      } catch {
        return undefined
      }
    })()
    const tail = () =>
      Effect.promise(() => OperatorTelemetryLogs.read({ file: logFile, position, level: settings.logLevel })).pipe(
        Effect.map((result) => {
          for (const entry of result.entries) batch.log(entry)
          const moved =
            result.position &&
            (result.position.inode !== position?.inode || result.position.offset !== position?.offset)
          position = result.position
          if (moved) batch.logPosition = result.position
        }),
        Effect.catchCause((cause) => warn("telemetry log tail failed", cause)),
      )

    // ---- samples ----

    const sample = () =>
      Effect.gen(function* () {
        settings = settingsOf(yield* config.getGlobal().pipe(Effect.orElseSucceed(() => undefined as never)))
        const now = Date.now()
        const snap = ingest.snapshot()
        batch.sample({ time_ms: now, name: "approvals_pending", dims: null, value: snap.pending })
        batch.sample({ time_ms: now, name: "approvals_oldest_ms", dims: null, value: snap.oldestPendingMs })
        batch.sample({ time_ms: now, name: "sessions_running", dims: null, value: snap.running })
        batch.sample({ time_ms: now, name: "sessions_waiting", dims: null, value: snap.waitingSessions })
        const queued = OperatorQueueStore.store().list({ status: "queued", limit: 100_000 })
        const byProject = new Map<string, { count: number; oldest: number }>()
        for (const item of queued) {
          const found = byProject.get(item.project) ?? { count: 0, oldest: item.createdAt }
          byProject.set(item.project, { count: found.count + 1, oldest: Math.min(found.oldest, item.createdAt) })
        }
        for (const [project, value] of byProject) {
          const dims = JSON.stringify({ project })
          batch.sample({ time_ms: now, name: "queue_depth", dims, value: value.count })
          batch.sample({ time_ms: now, name: "queue_oldest_ms", dims, value: now - value.oldest })
        }
        // MCP servers only in folders with activity in the last 15 minutes: their instance is loaded, and none is
        // started to read a status (§5.9).
        const counts = new Map<string, number>()
        for (const [directory, time] of ingest.folders) {
          if (now - time > MCP_ACTIVE_MS) continue
          const found = yield* instances.provide({ directory }, mcp.status()).pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => undefined),
          )
          if (!found) continue
          servers.set(directory, Object.keys(found))
          for (const [server, status] of Object.entries(found)) {
            counts.set(status.status, (counts.get(status.status) ?? 0) + 1)
            const key = `${directory}\u0000${server}`
            if (statuses.get(key) === status.status) continue
            statuses.set(key, status.status)
            batch.mcpStatus({
              time_ms: now,
              directory,
              server,
              status: status.status,
              error: "error" in status && typeof status.error === "string" ? status.error.slice(0, 500) : null,
            })
          }
        }
        for (const [status, value] of counts)
          batch.sample({ time_ms: now, name: "mcp_servers", dims: JSON.stringify({ status }), value })
        ingest.sweep()
      }).pipe(Effect.catchCause((cause) => warn("telemetry sample failed", cause)))

    // ---- a server that stopped mid-span (§5.7) ----

    OperatorTelemetryWriter.interrupt(store, { started, loops: settings.loops, now: Date.now() })

    // ---- hooks ----

    const guarded = (work: () => void) => {
      if (current !== token || !settings.enabled) return
      try {
        work()
      } catch {
        failures += 1
      }
    }
    const onEvent = (event: GlobalEvent) => guarded(() => ingest.handle(event))
    const hooks: typeof OperatorRegistry.telemetry = {
      decision: (record) => guarded(() => ingest.decision(record as OperatorTelemetryIngest.Decision)),
      helper: (run) => guarded(() => ingest.helper(run as OperatorTelemetryIngest.HelperRun)),
      trash: (ids, trashed) => guarded(() => ingest.trash(ids, trashed)),
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        current = token
        // One more of the server's own listeners: not a leak (Node warns past 10).
        const limit = GlobalBus.getMaxListeners()
        if (limit && GlobalBus.listenerCount("event") >= limit) GlobalBus.setMaxListeners(limit + 1)
        GlobalBus.on("event", onEvent)
        Object.assign(OperatorRegistry.telemetry, hooks)
      }),
      () =>
        Effect.sync(() => {
          GlobalBus.off("event", onEvent)
          if (current !== token) return
          current = undefined
          for (const key of Object.keys(hooks) as Array<keyof typeof hooks>)
            if (OperatorRegistry.telemetry[key] === hooks[key]) delete OperatorRegistry.telemetry[key]
        }),
    )

    if (loopOn()) {
      settings = settingsOf(yield* config.getGlobal().pipe(Effect.orElseSucceed(() => undefined as never)))
      const tick = Effect.suspend(() =>
        batch.size() >= FLUSH_ROWS || (Date.now() - lastFlush >= FLUSH_MS && !batch.empty()) ? flush() : Effect.void,
      )
      yield* tick.pipe(Effect.repeat(Schedule.spaced("250 millis")), Effect.forkIn(scope))
      yield* tail().pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkIn(scope))
      yield* sample().pipe(
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.delay("10 seconds"),
        Effect.forkIn(scope),
      )
      yield* totals().pipe(
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.delay("15 seconds"),
        Effect.forkIn(scope),
      )
      yield* purge().pipe(Effect.repeat(Schedule.spaced("6 hours")), Effect.delay("30 seconds"), Effect.forkIn(scope))
      // The store's first start builds history (§5.11).
      if (firstStart) yield* backfill({ log: true }).pipe(Effect.delay("5 seconds"), Effect.forkIn(scope))
      // What is left at shutdown is written.
      yield* Effect.addFinalizer(() => flush())
      // Failures are reported, not thrown.
      yield* Effect.gen(function* () {
        if (!failures) return
        const count = failures
        failures = 0
        yield* warn("telemetry events failed", `${count} events could not be recorded`)
      }).pipe(Effect.repeat(Schedule.spaced("60 seconds")), Effect.forkIn(scope))
    }

    return Service.of({
      flush,
      tail,
      sample,
      ingest,
      dropped: () => dropped,
      backfill,
      rebuild,
      progress: () => progress,
      settings: () => settings,
      purge,
      totals,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Config.node, InstanceStore.node, MCP.node],
})
