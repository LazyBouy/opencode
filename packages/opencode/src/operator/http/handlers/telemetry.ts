import fs from "fs/promises"
import os from "os"
import { asc, inArray } from "drizzle-orm"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { PartTable } from "@opencode-ai/core/session/sql"
import { Config } from "@/config/config"
import { OperatorConfig } from "@/operator/config"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { OperatorTelemetryExport } from "@/operator/telemetry/export"
import { OperatorTelemetryRetention } from "@/operator/telemetry/retention"
import { OperatorTelemetryViews } from "@/operator/telemetry/views"
import { InstanceStore } from "@/project/instance-store"
import { OperatorTelemetryAlerting } from "@/operator/telemetry/alerting"
import { OperatorTelemetry } from "@/operator/telemetry/telemetry"
import { OperatorTelemetryMetrics } from "@/operator/telemetry/metrics"
import { OperatorTelemetryQuery } from "@/operator/telemetry/query"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorRootApi } from "../groups/overview"
import { ApiTelemetryAlertError, ApiTelemetryInvalidError, ApiTelemetryNotFoundError } from "../groups/telemetry"

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

const invalid = (error: { message: string }) =>
  new ApiTelemetryAlertError({ name: "OperatorTelemetryAlertError", data: { message: error.message } })
const alertError = (error: OperatorTelemetryAlerting.AlertError) =>
  error.missing ? notFound(error.message) : invalid(error)

const badInput = (message: string) =>
  new ApiTelemetryInvalidError({ name: "OperatorTelemetryInvalidError", data: { message } })

const LABEL = 120

export const operatorTelemetryHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorTelemetry", (handlers) =>
  Effect.gen(function* () {
    const telemetry = yield* OperatorTelemetry.Service
    const alerting = yield* OperatorTelemetryAlerting.Service
    const config = yield* Config.Service
    const operatorConfig = yield* OperatorConfig.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const instances = yield* InstanceStore.Service
    // Who saved a view: the config's username (one shared password, no accounts).
    const username = Effect.fnUntraced(function* () {
      const global = yield* config.getGlobal().pipe(Effect.orElseSucceed(() => undefined))
      return global?.username || os.userInfo().username || "user"
    })
    const profiles = yield* OperatorProfileStore.Service
    const db = (yield* Database.Service).db
    const store = () => OperatorTelemetryStore.store()

    // The namespaces' projects as the project records have them now (§4.2): a moved project brings its history.
    const context = Effect.fnUntraced(function* () {
      return OperatorTelemetryQuery.contextOf(yield* profiles.projects(), {
        now: Date.now(),
        stuckMinutes: telemetry.settings().stuckMinutes,
      })
    })
    // Observability settings (§15) as they are now: the global config's, with call recording.
    const settingsNow = Effect.fnUntraced(function* () {
      const global = yield* config.getGlobal().pipe(Effect.orElseSucceed(() => undefined))
      const value = OperatorTelemetry.settingsOf(global as { operatorTelemetry?: Record<string, any> } | undefined)
      return {
        enabled: value.enabled,
        eventsDays: value.eventsDays,
        totalsDays: value.totalsDays,
        logLevel: value.logLevel,
        loops: value.loops,
        dailyBudget: value.dailyBudget ?? null,
        stuckMinutes: value.stuckMinutes,
        queueMinutes: value.queueMinutes,
        recordCalls: (global as { operatorRecordCalls?: boolean } | undefined)?.operatorRecordCalls !== false,
        limits: {
          eventsDays: {
            min: OperatorTelemetryRetention.RANGES.eventsDays.min,
            max: OperatorTelemetryRetention.RANGES.eventsDays.max,
          },
          totalsDays: {
            min: OperatorTelemetryRetention.RANGES.totalsDays.min,
            max: OperatorTelemetryRetention.RANGES.totalsDays.max,
          },
        },
      }
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
      .handle("alertRules", () => alerting.rules())
      .handle("alertRuleCreate", (ctx) => alerting.create(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("alertRuleUpdate", (ctx) => alerting.update(ctx.params.id, ctx.payload).pipe(Effect.mapError(alertError)))
      .handle("alertRuleDelete", (ctx) =>
        alerting.remove(ctx.params.id).pipe(Effect.as(true), Effect.mapError(alertError)),
      )
      .handle("alertRuleMute", (ctx) => alerting.mute(ctx.params.id, ctx.payload.for).pipe(Effect.mapError(alertError)))
      .handle("alertRuleReset", (ctx) => alerting.reset(ctx.params.id).pipe(Effect.mapError(alertError)))
      .handle("alertEvents", (ctx) => {
        const { from, to } = OperatorTelemetryQuery.window(
          { ...ctx.query, from: number(ctx.query.from), to: number(ctx.query.to) } as OperatorTelemetryQuery.Filter,
          Date.now(),
        )
        return alerting.events({
          from,
          to,
          firing: ctx.query.firing === "1",
          ...(number(ctx.query.limit) !== undefined ? { limit: number(ctx.query.limit) } : {}),
        })
      })
      .handle("alertAck", (ctx) =>
        alerting.acknowledge(ctx.params.id).pipe(Effect.mapError((error) => notFound(error.message))),
      )
      .handle("views", () => Effect.promise(() => OperatorTelemetryViews.list()))
      .handle("viewCreate", (ctx) =>
        Effect.gen(function* () {
          const name = ctx.payload.name.trim()
          if (!name) return yield* badInput("A view needs a name")
          const now = Date.now()
          const createdBy = yield* username()
          return yield* Effect.promise(() =>
            OperatorTelemetryViews.write({
              id: OperatorTelemetryViews.newId(),
              name,
              ...(ctx.payload.description?.trim() ? { description: ctx.payload.description.trim() } : {}),
              state: ctx.payload.state as OperatorTelemetryViews.State,
              createdBy,
              createdAt: now,
              updatedAt: now,
            }),
          )
        }),
      )
      .handle("viewUpdate", (ctx) =>
        Effect.gen(function* () {
          const view = yield* Effect.promise(() => OperatorTelemetryViews.get(ctx.params.id))
          if (!view) return yield* notFound(`No view ${ctx.params.id}`)
          if (view.builtin) return yield* badInput("Built-in views can't change; Save as makes a copy")
          const name = ctx.payload.name?.trim()
          if (ctx.payload.name !== undefined && !name) return yield* badInput("A view needs a name")
          return yield* Effect.promise(() =>
            OperatorTelemetryViews.write({
              ...view,
              ...(name ? { name } : {}),
              ...(ctx.payload.description !== undefined ? { description: ctx.payload.description.trim() } : {}),
              ...(ctx.payload.state ? { state: ctx.payload.state as OperatorTelemetryViews.State } : {}),
              updatedAt: Date.now(),
            }),
          )
        }),
      )
      .handle("viewDelete", (ctx) =>
        Effect.gen(function* () {
          const view = yield* Effect.promise(() => OperatorTelemetryViews.get(ctx.params.id))
          if (!view) return yield* notFound(`No view ${ctx.params.id}`)
          if (view.builtin) return yield* badInput("Built-in views can't be deleted")
          yield* Effect.promise(() => OperatorTelemetryViews.trash(view))
          return true
        }),
      )
      .handle("settings", () => settingsNow())
      .handle("settingsUpdate", (ctx) =>
        Effect.gen(function* () {
          const input = ctx.payload
          const { min: eventsMin, max: eventsMax } = OperatorTelemetryRetention.RANGES.eventsDays
          const { min: totalsMin, max: totalsMax } = OperatorTelemetryRetention.RANGES.totalsDays
          if (!Number.isInteger(input.eventsDays) || input.eventsDays < eventsMin || input.eventsDays > eventsMax)
            return yield* badInput(`Keep detailed events for ${eventsMin} to ${eventsMax} days`)
          if (!Number.isInteger(input.totalsDays) || input.totalsDays < totalsMin || input.totalsDays > totalsMax)
            return yield* badInput(`Keep totals for ${totalsMin} to ${totalsMax} days`)
          if (input.totalsDays < input.eventsDays) return yield* badInput("Totals are kept at least as long as events")
          const whole = (value: number) => Number.isInteger(value) && value > 0
          if (!Object.values(input.loops).every(whole)) return yield* badInput("Loop rules are whole numbers above 0")
          if (!whole(input.stuckMinutes) || !whole(input.queueMinutes))
            return yield* badInput("The Dashboard's thresholds are whole minutes above 0")
          if (input.dailyBudget !== null && !(input.dailyBudget > 0)) return yield* badInput("A budget is more than $0")
          const before = yield* settingsNow()
          const value = {
            enabled: input.enabled,
            eventsDays: input.eventsDays,
            totalsDays: input.totalsDays,
            logLevel: input.logLevel,
            loops: input.loops,
            // null removes the key: no budget.
            dailyBudget: input.dailyBudget,
            dashboard: { stuckMinutes: input.stuckMinutes, queueMinutes: input.queueMinutes },
          }
          const patch = { operatorTelemetry: value, operatorRecordCalls: input.recordCalls }
          const directory =
            (yield* profiles.defaultProject(OperatorProfile.OPENCODE).pipe(Effect.orElseSucceed(() => undefined))) ??
            Global.Path.config
          yield* instances
            .provide({ directory }, operatorConfig.update("global", patch))
            .pipe(Effect.mapError((error) => badInput(error.message)))
          // Telemetry applies them now; the cached global config is read again next time.
          yield* config.invalidate()
          telemetry.apply(
            OperatorTelemetry.settingsOf({
              operatorTelemetry: { ...value, dailyBudget: input.dailyBudget ?? undefined },
            }),
          )
          // Call recording is read by each project's config: it applies when they reload.
          const reload = before.recordCalls !== input.recordCalls ? yield* reloads.want("global") : undefined
          return { settings: yield* settingsNow(), ...(reload ? { reload } : {}) }
        }),
      )
      .handle("clear", () => telemetry.clear().pipe(Effect.map((entry) => ({ trash: entry.id }))))
      .handle("exportCount", (ctx) =>
        Effect.gen(function* () {
          const { tab, sort: _sort, ...rest } = ctx.query
          const rows = OperatorTelemetryExport.count(store(), {
            tab,
            filter: filterOf(rest) as OperatorTelemetryExport.Input["filter"],
            context: yield* context(),
          })
          return { rows, limit: OperatorTelemetryExport.LIMIT }
        }),
      )
      .handleRaw("export", (ctx) =>
        Effect.gen(function* () {
          const { tab, sort, format, cols, tz, ...rest } = ctx.query
          const now = yield* context()
          const filter = filterOf(rest) as OperatorTelemetryExport.Input["filter"]
          const input = { tab, filter, context: now, ...(sort ? { sort } : {}) }
          const rows = OperatorTelemetryExport.count(store(), input)
          if (rows > OperatorTelemetryExport.LIMIT)
            return yield* badInput(
              `${rows} rows match; the limit is ${OperatorTelemetryExport.LIMIT}. Narrow the range or the filters.`,
            )
          const offset = Number(tz)
          const minutes = Number.isFinite(offset) ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(offset))) : 0
          const lines = OperatorTelemetryExport.lines(store(), {
            ...input,
            format,
            ...(cols ? { columns: cols.split(",") } : {}),
            offset: minutes,
          })
          const range = OperatorTelemetryQuery.window(filter, now.now)
          const name = OperatorTelemetryExport.filename(tab, format, range, minutes)
          return HttpServerResponse.stream(Stream.fromIterable(lines).pipe(Stream.encodeText), {
            contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
            headers: { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
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
