import fs from "fs/promises"
import { asc, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorTelemetry } from "@/operator/telemetry/telemetry"
import { OperatorTelemetryMetrics } from "@/operator/telemetry/metrics"
import { OperatorTelemetryQuery } from "@/operator/telemetry/query"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorRootApi } from "../groups/overview"
import { ApiTelemetryNotFoundError } from "../groups/telemetry"

const notFound = (message: string) =>
  new ApiTelemetryNotFoundError({ name: "OperatorTelemetryNotFoundError", data: { message } })

const number = (value: string | undefined) => {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The filter from query parameters: numbers parsed, the rest as given. */
function filterOf(query: Record<string, string | undefined>): OperatorTelemetryQuery.Filter {
  return {
    ...query,
    from: number(query.from),
    to: number(query.to),
    minCost: number(query.minCost),
    maxCost: number(query.maxCost),
    minDuration: number(query.minDuration),
    maxDuration: number(query.maxDuration),
    minTokens: number(query.minTokens),
  } as OperatorTelemetryQuery.Filter
}

const LABEL = 120

export const operatorTelemetryHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorTelemetry", (handlers) =>
  Effect.gen(function* () {
    const telemetry = yield* OperatorTelemetry.Service
    const profiles = yield* OperatorProfileStore.Service
    const db = (yield* Database.Service).db
    const store = () => OperatorTelemetryStore.store()

    // The namespaces' projects as the project records have them now (§4.2): a moved project brings its history.
    const context = Effect.fnUntraced(function* () {
      const projects = yield* profiles.projects()
      return {
        now: Date.now(),
        known: projects.map((project) => project.key),
        stuckMinutes: telemetry.settings().stuckMinutes,
        projectsOf: (ns: string) => ({
          keys: projects.filter((project) => project.namespace === ns).map((project) => project.key),
          rest: ns === "opencode",
        }),
      } satisfies OperatorTelemetryQuery.Context
    })
    const kept = () =>
      new Set(
        (store().db.query("SELECT session_id FROM kept_session").all() as Array<{ session_id: string }>).map(
          (row) => row.session_id,
        ),
      )
    const withKept = <Row extends OperatorTelemetryStore.SessionRow>(row: Row, set: Set<string>) => ({
      ...row,
      kept: set.has(row.id),
    })

    // Each turn's label: the first line of its prompt, read from the session (§10.2; never stored).
    const labels = Effect.fnUntraced(function* (messageIDs: ReadonlyArray<string>) {
      if (!messageIDs.length) return new Map<string, string>()
      const parts = yield* db
        .select({ message: PartTable.message_id, data: PartTable.data })
        .from(PartTable)
        .where(inArray(PartTable.message_id, messageIDs as never[]))
        .orderBy(asc(PartTable.id))
        .all()
        .pipe(Effect.orElseSucceed(() => []))
      const out = new Map<string, string>()
      for (const part of parts) {
        const data = part.data as { type?: string; text?: string; synthetic?: boolean }
        if (out.has(part.message) || data.type !== "text" || data.synthetic || !data.text?.trim()) continue
        const line = data.text.trim().split("\n")[0]!.trim()
        out.set(part.message, line.length > LABEL ? `${line.slice(0, LABEL - 1)}…` : line)
      }
      return out
    })

    return handlers
      .handle("sessions", (ctx) =>
        Effect.gen(function* () {
          const page = OperatorTelemetryQuery.sessions(store(), filterOf(ctx.query), yield* context(), {
            ...(ctx.query.sort ? { sort: ctx.query.sort } : {}),
            ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
            ...(number(ctx.query.limit) !== undefined ? { limit: number(ctx.query.limit) } : {}),
          })
          const set = kept()
          return { ...page, rows: page.rows.map((row) => withKept(row, set)) }
        }),
      )
      .handle("session", (ctx) =>
        Effect.gen(function* () {
          const row = store().session(ctx.params.id)
          if (!row) return yield* notFound(`No telemetry for session ${ctx.params.id}`)
          const { turns: shown, earlier } = OperatorTelemetryQuery.turns(store(), ctx.params.id, {
            all: ctx.query.turns === "all",
            ...(number(ctx.query.before) !== undefined ? { before: number(ctx.query.before) } : {}),
          })
          const found = yield* labels(shown.map((item) => item.span.message_id).filter((id): id is string => !!id))
          return {
            session: withKept(row, kept()),
            turns: shown.map((item) => {
              const label = item.span.message_id ? found.get(item.span.message_id) : undefined
              return { ...item, ...(label ? { label } : {}) }
            }),
            earlier,
          }
        }),
      )
      .handle("turn", (ctx) =>
        Effect.gen(function* () {
          const turn = store().span(ctx.params.turnID)
          if (!turn || turn.kind !== "turn" || turn.session_id !== ctx.params.id)
            return yield* notFound(`No turn ${ctx.params.turnID} in session ${ctx.params.id}`)
          return { turn, spans: store().spansOfTurn(turn.id) }
        }),
      )
      .handle("keep", (ctx) =>
        Effect.gen(function* () {
          if (!store().session(ctx.params.id)) return yield* notFound(`No telemetry for session ${ctx.params.id}`)
          store()
            .db.query("INSERT OR REPLACE INTO kept_session (session_id, time_ms) VALUES (?, ?)")
            .run(ctx.params.id, Date.now())
          return true
        }),
      )
      .handle("unkeep", (ctx) =>
        Effect.sync(
          () => store().db.query("DELETE FROM kept_session WHERE session_id = ?").run(ctx.params.id).changes > 0,
        ),
      )
      .handle("span", (ctx) =>
        Effect.gen(function* () {
          const span = store().span(ctx.params.id)
          if (!span) return yield* notFound(`No span ${ctx.params.id}`)
          const child = span.kind === "subagent" ? span.id.slice("sub:".length) : undefined
          return {
            span,
            links: {
              ...(span.session_id ? { session: span.session_id } : {}),
              ...(span.turn_id ? { turn: span.turn_id } : {}),
              ...(span.kind === "model_call" && span.source !== "message" && span.call_id
                ? { call: span.call_id }
                : {}),
              ...(span.request_id ? { decision: span.request_id } : {}),
              ...(span.message_id ? { message: span.message_id } : {}),
              ...(span.part_id ? { part: span.part_id } : {}),
              ...(child ? { child } : {}),
            },
          }
        }),
      )
      .handle("events", (ctx) =>
        Effect.gen(function* () {
          const page = OperatorTelemetryQuery.events(store(), filterOf(ctx.query), yield* context(), {
            ...(ctx.query.sort ? { sort: ctx.query.sort } : {}),
            ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
            ...(number(ctx.query.limit) !== undefined ? { limit: number(ctx.query.limit) } : {}),
            ...(number(ctx.query.after) !== undefined ? { after: number(ctx.query.after) } : {}),
          })
          // The sessions' titles, for the rows to name them.
          const ids = [...new Set(page.rows.map((row) => row.session_id).filter((id): id is string => !!id))]
          const titles = ids.length
            ? Object.fromEntries(
                (
                  store()
                    .db.query(`SELECT id, title FROM session_row WHERE id IN (${ids.map(() => "?").join(", ")})`)
                    .all(...ids) as Array<{ id: string; title: string | null }>
                )
                  .filter((row) => row.title)
                  .map((row) => [row.id, row.title!]),
              )
            : {}
          return {
            rows: page.rows,
            seq: page.seq,
            titles,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          }
        }),
      )
      .handle("logs", (ctx) =>
        Effect.sync(() => {
          const page = OperatorTelemetryQuery.logs(
            store(),
            {
              ...ctx.query,
              from: number(ctx.query.from),
              to: number(ctx.query.to),
            },
            { now: Date.now() },
            {
              ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
              ...(number(ctx.query.limit) !== undefined ? { limit: number(ctx.query.limit) } : {}),
              ...(number(ctx.query.after) !== undefined ? { after: number(ctx.query.after) } : {}),
            },
          )
          return { rows: page.rows, seq: page.seq, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
        }),
      )
      .handle("facets", (ctx) =>
        Effect.gen(function* () {
          const { scope, field, ...rest } = ctx.query
          return OperatorTelemetryQuery.facet(store(), filterOf(rest), yield* context(), { scope, field })
        }),
      )
      .handle("metrics", (ctx) =>
        Effect.gen(function* () {
          const { metric, groupBy, step, ...rest } = ctx.query
          if (!(OperatorTelemetryMetrics.IDS as ReadonlyArray<string>).includes(metric))
            return yield* notFound(`No metric ${metric}`)
          const size = step === "auto" ? undefined : number(step)
          return OperatorTelemetryMetrics.compute(store(), {
            metric: metric as OperatorTelemetryMetrics.Metric,
            ...(groupBy ? { groupBy } : {}),
            ...(size !== undefined && size > 0 ? { step: size } : {}),
            filter: filterOf(rest),
            context: yield* context(),
            eventsDays: telemetry.settings().eventsDays,
          })
        }),
      )
      .handle("backfillStatus", () => Effect.sync(() => telemetry.progress()))
      .handle("backfill", () => telemetry.rebuild())
      .handle("storage", () =>
        Effect.gen(function* () {
          const db = store()
          const sizes = yield* Effect.promise(() =>
            Promise.all(
              [db.file, `${db.file}-wal`].map((file) =>
                fs
                  .stat(file)
                  .then((stat) => stat.size)
                  .catch(() => 0),
              ),
            ),
          )
          const count = (sql: string) => (db.db.query(sql).get() as { n: number | null }).n ?? 0
          const oldest = (db.db.query("SELECT min(start_ms) AS n FROM span").get() as { n: number | null }).n
          const oldestLog = (db.db.query("SELECT min(time_ms) AS n FROM log_entry").get() as { n: number | null }).n
          const lastPurge = Number(db.meta("last_purge") ?? 0)
          const settings = telemetry.settings()
          return {
            path: db.file,
            bytes: sizes.reduce((sum, size) => sum + size, 0),
            spans: count("SELECT count(*) AS n FROM span"),
            logs: count("SELECT count(*) AS n FROM log_entry"),
            sessions: count("SELECT count(*) AS n FROM session_row"),
            ...(oldest !== null ? { oldestSpan: oldest } : {}),
            dropped: telemetry.dropped(),
            kept: count("SELECT count(*) AS n FROM kept_session"),
            ...(lastPurge ? { lastPurge } : {}),
            eventsDays: settings.eventsDays,
            totalsDays: settings.totalsDays,
            logPath: OperatorTelemetry.logFile(),
            logLevel: settings.logLevel,
            ...(oldestLog !== null ? { oldestLog } : {}),
          }
        }),
      )
  }),
)
