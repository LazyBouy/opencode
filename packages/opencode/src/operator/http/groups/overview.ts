import { OperatorInbox } from "@/operator/inbox"
import { OperatorOverview } from "@/operator/overview"
import { Session } from "@/session/session"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { QueryBoolean } from "@/server/routes/instance/httpapi/groups/query"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { SchemaErrorMiddleware } from "@/server/routes/instance/httpapi/middleware/schema-error"

export const OperatorOverviewPaths = {
  status: "/operator/status",
  sessions: "/operator/session",
  stats: "/operator/stats",
  permissions: "/operator/permission",
} as const

export const SessionQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  archived: Schema.optional(QueryBoolean),
  cursor: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
})

export const StatsQuery = Schema.Struct({
  days: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
})

// Server-wide operator routes (no project context needed). Mounted beside upstream's RootHttpApi
// rather than inside it, so upstream tests that assemble RootHttpApi keep working.
export const OperatorRootApi = HttpApi.make("operator-root")
  .add(
    HttpApiGroup.make("operatorOverview")
      .add(
        HttpApiEndpoint.get("status", OperatorOverviewPaths.status, {
          success: described(OperatorOverview.Status, "Server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.status",
            summary: "Get server status",
            description: "The server's version, start time and platform.",
          }),
        ),
        HttpApiEndpoint.get("sessions", OperatorOverviewPaths.sessions, {
          query: SessionQuery,
          success: described(Schema.Array(Session.GlobalInfo), "Sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.session.list",
            summary: "List sessions across projects",
            description:
              "Sessions from every project, most recently updated first, filtered by directory, agent, title search or archive state. Page with `cursor` (the last row's update time).",
          }),
        ),
        HttpApiEndpoint.get("stats", OperatorOverviewPaths.stats, {
          query: StatsQuery,
          success: described(OperatorOverview.Stats, "Usage statistics"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.stats",
            summary: "Get usage statistics",
            description:
              "Session, token and cost totals, usage by agent, and a per-day series for the last `days` days (default 14). `offset` is the viewer's UTC offset in minutes, used to group days.",
          }),
        ),
        HttpApiEndpoint.get("permissions", OperatorOverviewPaths.permissions, {
          success: described(Schema.Array(OperatorInbox.Pending), "Pending permission requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.permission.pending",
            summary: "List pending permission requests",
            description:
              "Permission requests waiting for a reply in every project, oldest first. Reply with POST /permission/{requestID}/reply and the request's directory.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator", description: "Server-wide operator routes." })),
  )
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator HttpApi",
      version: "0.0.1",
      description: "Server-wide operator routes.",
    }),
  )
