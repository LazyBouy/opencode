export * as OperatorOverview from "./overview"

import { and, count, desc, eq, gte, inArray, isNull, like, lt, max, sql, sum, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Session } from "@/session/session"

export const Status = Schema.Struct({
  version: Schema.String,
  startedAt: Schema.Finite,
  platform: Schema.String,
  arch: Schema.String,
}).annotate({ identifier: "OperatorStatus" })

const Totals = Schema.Struct({
  sessions: Schema.Finite,
  projects: Schema.Finite,
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
  }),
})

export const Stats = Schema.Struct({
  all: Totals.annotate({ description: "Every session, including archived ones" }),
  range: Totals.annotate({ description: "Sessions started within the requested number of days" }),
  activeToday: Schema.Finite.annotate({ description: "Sessions updated since the start of today" }),
  agents: Schema.Array(
    Schema.Struct({ agent: Schema.String, sessions: Schema.Finite, cost: Schema.Finite, lastUsed: Schema.Finite }),
  ).annotate({ description: "Sessions started within the range, by agent" }),
  days: Schema.Array(
    Schema.Struct({ day: Schema.String, sessions: Schema.Finite, cost: Schema.Finite, tokens: Schema.Finite }),
  ).annotate({ description: "One entry per day of the range, oldest first, including empty days" }),
}).annotate({ identifier: "OperatorStats" })
export type Stats = typeof Stats.Type

export interface SessionInput {
  readonly directory?: string
  readonly agent?: string
  readonly search?: string
  readonly roots?: boolean
  readonly archived?: boolean
  readonly cursor?: number
  readonly limit?: number
}

export interface StatsInput {
  readonly days: number
  /** Minutes to add to UTC to get the viewer's local time, used to bucket days. */
  readonly offset: number
}

export interface Interface {
  readonly status: () => typeof Status.Type
  readonly sessions: (input: SessionInput) => Effect.Effect<Session.GlobalInfo[]>
  readonly stats: (input: StatsInput) => Effect.Effect<Stats>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorOverview") {}

const startedAt = Date.now() - Math.round(process.uptime() * 1000)
const DAY = 24 * 60 * 60 * 1000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    // Like Session.listGlobal, with an agent filter, since the operator pages browse sessions by agent.
    const sessions = Effect.fn("OperatorOverview.sessions")(function* (input: SessionInput) {
      const conditions = [
        input.directory ? eq(SessionTable.directory, input.directory) : undefined,
        input.agent ? eq(SessionTable.agent, input.agent) : undefined,
        input.search ? like(SessionTable.title, `%${input.search}%`) : undefined,
        input.roots ? isNull(SessionTable.parent_id) : undefined,
        input.archived ? undefined : isNull(SessionTable.time_archived),
        input.cursor ? lt(SessionTable.time_updated, input.cursor) : undefined,
      ].filter((condition): condition is SQL => condition !== undefined)
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(Math.min(input.limit ?? 50, 500))
        .all()
        .pipe(Effect.orDie)
      const ids = [...new Set(rows.map((row) => row.project_id))]
      const projects = ids.length
        ? yield* db
            .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
            .from(ProjectTable)
            .where(inArray(ProjectTable.id, ids))
            .all()
            .pipe(Effect.orDie)
        : []
      const byID = new Map(
        projects.map((project) => [project.id, { id: project.id, name: project.name ?? undefined, worktree: project.worktree }]),
      )
      return rows.map((row) => ({ ...Session.fromRow(row), project: byID.get(row.project_id) ?? null }))
    })

    const totals = (since?: number) =>
      db
        .select({
          sessions: count(),
          projects: sql<number>`count(distinct ${SessionTable.project_id})`,
          cost: sum(SessionTable.cost),
          input: sum(SessionTable.tokens_input),
          output: sum(SessionTable.tokens_output),
          reasoning: sum(SessionTable.tokens_reasoning),
          cacheRead: sum(SessionTable.tokens_cache_read),
          cacheWrite: sum(SessionTable.tokens_cache_write),
        })
        .from(SessionTable)
        .where(since === undefined ? undefined : gte(SessionTable.time_created, since))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => ({
            sessions: row?.sessions ?? 0,
            projects: Number(row?.projects ?? 0),
            cost: Number(row?.cost ?? 0),
            tokens: {
              input: Number(row?.input ?? 0),
              output: Number(row?.output ?? 0),
              reasoning: Number(row?.reasoning ?? 0),
              cacheRead: Number(row?.cacheRead ?? 0),
              cacheWrite: Number(row?.cacheWrite ?? 0),
            },
          })),
        )

    const stats = Effect.fn("OperatorOverview.stats")(function* (input: StatsInput) {
      const days = Math.max(1, Math.min(Math.round(input.days), 366))
      const shift = input.offset * 60 * 1000
      const today = Math.floor((Date.now() + shift) / DAY) * DAY - shift
      const since = today - (days - 1) * DAY
      const day = sql<string>`strftime('%Y-%m-%d', (${SessionTable.time_created} + ${shift}) / 1000, 'unixepoch')`

      const agents = yield* db
        .select({
          agent: SessionTable.agent,
          sessions: count(),
          cost: sum(SessionTable.cost),
          lastUsed: max(SessionTable.time_updated),
        })
        .from(SessionTable)
        .where(gte(SessionTable.time_created, since))
        .groupBy(SessionTable.agent)
        .orderBy(desc(count()))
        .all()
        .pipe(Effect.orDie)
      const buckets = yield* db
        .select({
          day,
          sessions: count(),
          cost: sum(SessionTable.cost),
          tokens: sql<number>`sum(${SessionTable.tokens_input} + ${SessionTable.tokens_output})`,
        })
        .from(SessionTable)
        .where(gte(SessionTable.time_created, since))
        .groupBy(day)
        .all()
        .pipe(Effect.orDie)
      const active = yield* db
        .select({ sessions: count() })
        .from(SessionTable)
        .where(gte(SessionTable.time_updated, today))
        .get()
        .pipe(Effect.orDie)

      const found = new Map(buckets.map((bucket) => [bucket.day, bucket]))
      return {
        all: yield* totals(),
        range: yield* totals(since),
        activeToday: active?.sessions ?? 0,
        agents: agents.map((row) => ({
          agent: row.agent ?? "",
          sessions: row.sessions,
          cost: Number(row.cost ?? 0),
          lastUsed: Number(row.lastUsed ?? 0),
        })),
        days: Array.from({ length: days }, (_, index) => {
          const key = new Date(since + shift + index * DAY).toISOString().slice(0, 10)
          const bucket = found.get(key)
          return {
            day: key,
            sessions: bucket?.sessions ?? 0,
            cost: Number(bucket?.cost ?? 0),
            tokens: Number(bucket?.tokens ?? 0),
          }
        }),
      }
    })

    return Service.of({
      status: () => ({ version: InstallationVersion, startedAt, platform: process.platform, arch: process.arch }),
      sessions,
      stats,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
