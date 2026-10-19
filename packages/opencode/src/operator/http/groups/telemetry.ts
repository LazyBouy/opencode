import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
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
  metrics: "/operator/telemetry/metrics",
  rules: "/operator/telemetry/alert/rule",
  rule: "/operator/telemetry/alert/rule/:id",
  mute: "/operator/telemetry/alert/rule/:id/mute",
  reset: "/operator/telemetry/alert/rule/:id/reset",
  alerts: "/operator/telemetry/alert/event",
  ack: "/operator/telemetry/alert/event/:id/ack",
  views: "/operator/telemetry/view",
  view: "/operator/telemetry/view/:id",
  settings: "/operator/telemetry/settings",
  clear: "/operator/telemetry/clear",
  export: "/operator/telemetry/export",
  exportCount: "/operator/telemetry/export/count",
  attention: "/operator/telemetry/attention",
  tiles: "/operator/telemetry/tiles",
  breakdown: "/operator/telemetry/breakdown",
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

export class ApiTelemetryAlertError extends Schema.ErrorClass<{
  readonly name: "OperatorTelemetryAlertError"
  readonly data: { readonly message: string }
}>("OperatorTelemetryAlertError")(
  { name: Schema.Literal("OperatorTelemetryAlertError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export class ApiTelemetryInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorTelemetryInvalidError"
  readonly data: { readonly message: string }
}>("OperatorTelemetryInvalidError")(
  { name: Schema.Literal("OperatorTelemetryInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const exportQuery = {
  ...T.FilterQuery,
  tab: Schema.Literals(["sessions", "events", "logs"]),
  sort: Schema.optional(Schema.String),
  level: Schema.optional(Schema.String).annotate({ description: "Logs: the lowest level" }),
  service: Schema.optional(Schema.String).annotate({ description: "Logs: services" }),
}

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
    HttpApiEndpoint.get("metrics", OperatorTelemetryPaths.metrics, {
      query: Schema.Struct({
        ...T.FilterQuery,
        metric: Schema.String.annotate({ description: "A metric id (observability_spec.md §12.3)" }),
        groupBy: Schema.optional(Schema.String).annotate({
          description: "One the metric's section offers: agent, project, model, provider or kind",
        }),
        step: Schema.optional(Schema.String).annotate({ description: "auto (default, §12.2) or ms" }),
      }),
      success: described(T.Metric, "The metric's series"),
      error: ApiTelemetryNotFoundError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.metrics",
        "Get a metric",
        "One chart's series under the filter: from spans inside the detailed window, from hourly totals (≈) past it. A split shows the top 5 values and Other.",
      ),
    ),
    HttpApiEndpoint.get("alertRules", OperatorTelemetryPaths.rules, {
      success: described(Schema.Array(T.AlertRuleView), "Alert rules with their state"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertRules",
        "List alert rules",
        "The built-in rules, then the user's, each with its state (OK, not enough data, firing, muted, couldn't evaluate, off).",
      ),
    ),
    HttpApiEndpoint.post("alertRuleCreate", OperatorTelemetryPaths.rules, {
      payload: T.AlertRuleInput,
      success: described(T.AlertRuleView, "Created"),
      error: ApiTelemetryAlertError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertRuleCreate",
        "Create an alert rule",
        "A new rule; it is evaluated every 60 s.",
      ),
    ),
    HttpApiEndpoint.put("alertRuleUpdate", OperatorTelemetryPaths.rule, {
      params: { id: Schema.String },
      payload: T.AlertRuleInput,
      success: described(T.AlertRuleView, "Saved"),
      error: [ApiTelemetryNotFoundError, ApiTelemetryAlertError],
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertRuleUpdate",
        "Update an alert rule",
        "Saves a rule (a built-in rule keeps its id; Reset brings its defaults back). Turning a firing rule off resolves it.",
      ),
    ),
    HttpApiEndpoint.delete("alertRuleDelete", OperatorTelemetryPaths.rule, {
      params: { id: Schema.String },
      success: described(Schema.Boolean, "Moved to Trash"),
      error: [ApiTelemetryNotFoundError, ApiTelemetryAlertError],
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertRuleDelete",
        "Delete an alert rule",
        "Moves a user rule to Trash (restore brings it back). Built-in rules can't be deleted.",
      ),
    ),
    HttpApiEndpoint.post("alertRuleMute", OperatorTelemetryPaths.mute, {
      params: { id: Schema.String },
      payload: Schema.Struct({
        for: Schema.Literals(["1h", "4h", "24h", "always", "off"]).annotate({
          description: "1h, 4h, 24h, always (until turned back on), or off (unmute)",
        }),
      }),
      success: described(T.AlertRuleView, "Muted"),
      error: [ApiTelemetryNotFoundError, ApiTelemetryAlertError],
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertRuleMute",
        "Mute an alert rule",
        "A muted rule doesn't start firing and its alerts leave the badges until the time passes or it is unmuted.",
      ),
    ),
    HttpApiEndpoint.post("alertRuleReset", OperatorTelemetryPaths.reset, {
      params: { id: Schema.String },
      success: described(T.AlertRuleView, "Reset"),
      error: [ApiTelemetryNotFoundError, ApiTelemetryAlertError],
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertRuleReset",
        "Reset a built-in rule",
        "Brings a built-in rule's defaults back.",
      ),
    ),
    HttpApiEndpoint.get("alertEvents", OperatorTelemetryPaths.alerts, {
      query: Schema.Struct({
        range: T.FilterQuery.range,
        from: T.FilterQuery.from,
        to: T.FilterQuery.to,
        firing: Schema.optional(Schema.String).annotate({
          description: "1: only alerts firing now, whatever the range",
        }),
        limit: Schema.optional(Schema.String),
      }),
      success: described(Schema.Array(T.AlertEvent), "Alert events, newest first"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertEvents",
        "List alerts",
        "One event per firing period, in the range (or firing now), newest first, with who acknowledged it.",
      ),
    ),
    HttpApiEndpoint.post("alertAck", OperatorTelemetryPaths.ack, {
      params: { id: Schema.String },
      success: described(T.AlertEvent, "Acknowledged"),
      error: ApiTelemetryNotFoundError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.alertAck",
        "Acknowledge an alert",
        "Records who and when, and takes the alert off the badges. It keeps firing until it resolves.",
      ),
    ),
    HttpApiEndpoint.get("views", OperatorTelemetryPaths.views, {
      success: described(Schema.Array(T.View), "Saved views"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.views",
        "List saved views",
        "The built-in views (read-only), then everyone's saved views on this server.",
      ),
    ),
    HttpApiEndpoint.post("viewCreate", OperatorTelemetryPaths.views, {
      payload: T.ViewInput,
      success: described(T.View, "Saved"),
      error: ApiTelemetryInvalidError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.viewCreate",
        "Save a view",
        "A tab, its filters and sort, the visible columns and the facet panel; never the time range or scope.",
      ),
    ),
    HttpApiEndpoint.put("viewUpdate", OperatorTelemetryPaths.view, {
      params: { id: Schema.String },
      payload: T.ViewPatch,
      success: described(T.View, "Saved"),
      error: [ApiTelemetryNotFoundError, ApiTelemetryInvalidError],
    }).annotateMerge(
      annotations(
        "operator.telemetry.viewUpdate",
        "Update a view",
        "Save (its state) or Rename. Built-in views can't change.",
      ),
    ),
    HttpApiEndpoint.delete("viewDelete", OperatorTelemetryPaths.view, {
      params: { id: Schema.String },
      success: described(Schema.Boolean, "Moved to Trash"),
      error: [ApiTelemetryNotFoundError, ApiTelemetryInvalidError],
    }).annotateMerge(
      annotations(
        "operator.telemetry.viewDelete",
        "Delete a view",
        "Moves a saved view to Trash, where it can be restored.",
      ),
    ),
    HttpApiEndpoint.get("settings", OperatorTelemetryPaths.settings, {
      success: described(T.Settings, "Observability settings"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.settings",
        "Observability settings",
        "Recording, retention, the log level kept, loop rules, the daily budget, the Dashboard's thresholds and call recording.",
      ),
    ),
    HttpApiEndpoint.put("settingsUpdate", OperatorTelemetryPaths.settings, {
      payload: T.SettingsInput,
      success: described(T.SettingsSaved, "Saved"),
      error: ApiTelemetryInvalidError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.settingsUpdate",
        "Save Observability settings",
        "Writes `operatorTelemetry` and `operatorRecordCalls` in the global config. Telemetry applies them at once; call recording when projects reload.",
      ),
    ),
    HttpApiEndpoint.post("clear", OperatorTelemetryPaths.clear, {
      success: described(T.Cleared, "Cleared"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.clear",
        "Clear telemetry",
        "Moves the telemetry store to Trash as one entry and starts an empty one. Restoring it from Trash replaces the store then current, which goes to Trash.",
      ),
    ),
    HttpApiEndpoint.get("exportCount", OperatorTelemetryPaths.exportCount, {
      query: Schema.Struct(exportQuery),
      success: described(T.ExportCount, "Rows matching"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.exportCount",
        "Count an export",
        "How many rows the current filter and range would export, and the limit (100,000).",
      ),
    ),
    HttpApiEndpoint.get("export", OperatorTelemetryPaths.export, {
      query: Schema.Struct({
        ...exportQuery,
        format: Schema.Literals(["csv", "jsonl"]),
        cols: Schema.optional(Schema.String).annotate({ description: "CSV: the visible columns, by id" }),
        tz: Schema.optional(Schema.String).annotate({
          description: "The viewer's offset from UTC in minutes, for times",
        }),
      }),
      success: described(
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv; charset=utf-8" })),
        "The file",
      ),
      error: ApiTelemetryInvalidError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.export",
        "Export",
        "Streams Sessions, Events or Logs under the filter, sort and range: CSV (the visible columns) or JSON Lines (every stored field), up to 100,000 rows. Holds no content.",
      ),
    ),
    HttpApiEndpoint.get("attention", OperatorTelemetryPaths.attention, {
      query: Schema.Struct({ ns: T.FilterQuery.ns, dir: T.FilterQuery.dir }),
      success: described(T.DashboardAttention, "What needs a person now"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.attention",
        "Needs attention",
        "The Dashboard's strip: approvals waiting, alerts firing, sessions with errors, stuck sessions, possible loops, rate limits, MCP servers down, the queue, the budget and telemetry problems, now, in scope. Not cached.",
      ),
    ),
    HttpApiEndpoint.get("tiles", OperatorTelemetryPaths.tiles, {
      query: Schema.Struct({
        range: Schema.optional(Schema.String).annotate({ description: "24h, 7d, 14d (default) or 30d" }),
        from: T.FilterQuery.from,
        to: T.FilterQuery.to,
        ns: T.FilterQuery.ns,
        dir: T.FilterQuery.dir,
      }),
      success: described(T.DashboardTiles, "The six tiles"),
    }).annotateMerge(
      annotations(
        "operator.telemetry.tiles",
        "Dashboard tiles",
        "Turns, turn errors, turn time, approval wait, rate limits and cost over the range, each with its previous period, hint numbers and a sparkline. Cached 30 s per range and scope.",
      ),
    ),
    HttpApiEndpoint.get("breakdown", OperatorTelemetryPaths.breakdown, {
      query: Schema.Struct({
        ...T.FilterQuery,
        by: Schema.String.annotate({
          description: "agent, tool, model or project; several, comma-separated, give a group each",
        }),
        limit: Schema.optional(Schema.String).annotate({ description: "Rows before Other (default 8)" }),
      }),
      success: described(T.DashboardBreakdown, "Rows and Other, per group"),
      error: ApiTelemetryInvalidError,
    }).annotateMerge(
      annotations(
        "operator.telemetry.breakdown",
        "Dashboard breakdown",
        "Agents, tools, models or projects in the range: turns, calls, errors, denials, p95 active time, cost, sessions, last used; the top rows and an Other row with the rest's sums, for each `by` asked. Cached 30 s.",
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
