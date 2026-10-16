import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { OperatorTelemetrySchema as T } from "@/operator/telemetry/schema"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Observability's API (observability_spec.md §7): server-wide, part of OperatorRootApi. Every read takes the shared
// filter (§7.2). No path equals a page's (`/operator/observability` is the page; these are under `/operator/telemetry/`).

export const OperatorTelemetryPaths = {
  sessions: "/operator/telemetry/sessions",
  session: "/operator/telemetry/session/:id",
  turn: "/operator/telemetry/session/:id/turn/:turnID",
  keep: "/operator/telemetry/session/:id/keep",
  span: "/operator/telemetry/span/:id",
  events: "/operator/telemetry/events",
  logs: "/operator/telemetry/logs",
  facets: "/operator/telemetry/facets",
  backfill: "/operator/telemetry/backfill",
  storage: "/operator/telemetry/storage",
} as const

export class ApiTelemetryNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorTelemetryNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorTelemetryNotFoundError")(
  { name: Schema.Literal("OperatorTelemetryNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

const paging = {
  sort: Schema.optional(Schema.String).annotate({ description: "A column, with :asc or :desc" }),
  cursor: Schema.optional(Schema.String).annotate({ description: "The previous page's nextCursor" }),
  limit: Schema.optional(Schema.String),
}

const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorTelemetryGroup = HttpApiGroup.make("operatorTelemetry")
  .add(
    HttpApiEndpoint.get("sessions", OperatorTelemetryPaths.sessions, {
      query: Schema.Struct({ ...T.FilterQuery, ...paging }),
      success: described(T.SessionPage, "Sessions with activity in the range"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.sessions",
        "List sessions",
        "Sessions with activity in the range, matching the filter: their summary rows, sorted on any column (lastActivity, turnStart, cost, …), paged with a cursor.",
      ),
    ),
    HttpApiEndpoint.get("session", OperatorTelemetryPaths.session, {
      params: { id: Schema.String },
      query: Schema.Struct({
        turns: Schema.optional(Schema.Literals(["latest", "all"])).annotate({
          description: "latest: the last 20 (default)",
        }),
        before: Schema.optional(Schema.String).annotate({
          description: "Turns that started before this time (ms): page back",
        }),
      }),
      success: described(T.SessionDetail, "The session's summary and turns"),
      error: ApiTelemetryNotFoundError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.session",
        "Get a session",
        "One session's summary row and its turns, newest last, each with its prompt's first line read from the session.",
      ),
    ),
    HttpApiEndpoint.get("turn", OperatorTelemetryPaths.turn, {
      params: { id: Schema.String, turnID: Schema.String },
      success: described(T.TurnTree, "The turn's spans"),
      error: ApiTelemetryNotFoundError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.turn",
        "Get a turn's spans",
        "Every span under a turn, in start order, for its tree and timeline. A subagent's own turns are read from its session.",
      ),
    ),
    HttpApiEndpoint.post("keep", OperatorTelemetryPaths.keep, {
      params: { id: Schema.String },
      success: described(Schema.Boolean, "Kept"),
      error: ApiTelemetryNotFoundError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.keep",
        "Keep a session beyond retention",
        "Its spans and log lines are never purged until it is let go or deleted.",
      ),
    ),
    HttpApiEndpoint.delete("unkeep", OperatorTelemetryPaths.keep, {
      params: { id: Schema.String },
      success: described(Schema.Boolean, "Let go"),
    }).annotateMerge(
      annotations("operator.telemetry.unkeep", "Let a kept session go", "Retention purges it again as it does others."),
    ),
    HttpApiEndpoint.get("span", OperatorTelemetryPaths.span, {
      params: { id: Schema.String },
      success: described(T.SpanDetail, "The span"),
      error: ApiTelemetryNotFoundError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.span",
        "Get a span",
        "One span with all its fields, and links to its session, recorded call, decision record and part.",
      ),
    ),
    HttpApiEndpoint.get("events", OperatorTelemetryPaths.events, {
      query: Schema.Struct({
        ...T.FilterQuery,
        ...paging,
        after: Schema.optional(Schema.String).annotate({
          description: "Live tail: only rows inserted or updated after this seq, oldest first",
        }),
      }),
      success: described(T.SpanPage, "Spans"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.events",
        "List events",
        "Every span matching the filter, newest first by default; `after` gives the rows written since a seq, for the live tail.",
      ),
    ),
    HttpApiEndpoint.get("logs", OperatorTelemetryPaths.logs, {
      query: Schema.Struct({
        range: T.FilterQuery.range,
        from: T.FilterQuery.from,
        to: T.FilterQuery.to,
        level: Schema.optional(Schema.String).annotate({ description: "The lowest level: error, warn, info" }),
        q: T.FilterQuery.q,
        session: T.FilterQuery.session,
        service: Schema.optional(Schema.String),
        cursor: paging.cursor,
        limit: paging.limit,
        after: Schema.optional(Schema.String),
      }),
      success: described(T.LogPage, "Log lines"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.logs",
        "List server log lines",
        "Server log lines kept from the log file, newest first; `after` for the live tail.",
      ),
    ),
    HttpApiEndpoint.get("facets", OperatorTelemetryPaths.facets, {
      query: Schema.Struct({
        ...T.FilterQuery,
        scope: Schema.Literals(["events", "sessions", "logs"]),
        field: Schema.String.annotate({
          description: "The field: kind, status, agent, model, tool, dir, sessionStatus, …",
        }),
        level: Schema.optional(Schema.String),
        service: Schema.optional(Schema.String),
      }),
      success: described(Schema.Array(T.Facet), "Values with counts"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.facets",
        "Count a field's values",
        "Up to 20 values of a field with their counts under the filter, leaving that field's own filter out.",
      ),
    ),
    HttpApiEndpoint.get("backfillStatus", OperatorTelemetryPaths.backfill, {
      success: described(T.Progress, "Progress"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.backfillStatus",
        "Building history",
        "How far building history from the stored sessions is.",
      ),
    ),
    HttpApiEndpoint.post("backfill", OperatorTelemetryPaths.backfill, {
      success: described(T.Progress, "Started"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.backfill",
        "Rebuild from history",
        "Builds history again from the stored sessions, recorded calls, decision records and the queue, in the background. Safe to repeat.",
      ),
    ),
    HttpApiEndpoint.get("storage", OperatorTelemetryPaths.storage, {
      success: described(T.Storage, "The store"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.storage",
        "Telemetry storage",
        "The store's size, rows, oldest span, dropped events, kept sessions, last purge and retention.",
      ),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator telemetry", description: "Observability routes." }))
