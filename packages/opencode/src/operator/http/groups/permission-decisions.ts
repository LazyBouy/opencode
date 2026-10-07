import { OperatorPermissionDecide } from "@/operator/permission-decide"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Replying to permission requests with the reply card's four choices, and every decision recorded
// (fixes_spec.md §3, §4.3). Server-wide: a request is found by its id in whichever project raised it.
export const OperatorPermissionDecisionPaths = {
  decide: "/operator/permission/:requestID/decide",
  decisions: "/operator/permission/decision",
} as const

export class ApiPermissionGoneError extends Schema.ErrorClass<{
  readonly name: "OperatorPermissionGoneError"
  readonly data: { readonly message: string }
}>("OperatorPermissionGoneError")(
  { name: Schema.Literal("OperatorPermissionGoneError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 409 },
) {}

export class ApiPermissionRefusedError extends Schema.ErrorClass<{
  readonly name: "OperatorPermissionRefusedError"
  readonly data: { readonly message: string }
}>("OperatorPermissionRefusedError")(
  { name: Schema.Literal("OperatorPermissionRefusedError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const DecisionQuery = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})

export const OperatorPermissionDecisionGroup = HttpApiGroup.make("operatorPermissionDecisions")
  .add(
    HttpApiEndpoint.post("decide", OperatorPermissionDecisionPaths.decide, {
      params: { requestID: Schema.String },
      payload: OperatorPermissionDecide.Input,
      success: described(OperatorPermissionDecide.Result, "What was written and answered"),
      error: [ApiPermissionGoneError, ApiPermissionRefusedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.permission.decide",
        summary: "Decide a permission request",
        description:
          "Allow it once, allow it for the session (a session rule) or for the agent (the agent's own rule, applied at once; its project reloads when none of its sessions is running), or deny it with an optional note to the agent. A rule also answers the other waiting requests it covers. The decision is recorded with where it was made.",
      }),
    ),
    HttpApiEndpoint.get("decisions", OperatorPermissionDecisionPaths.decisions, {
      query: DecisionQuery,
      success: described(Schema.Array(OperatorPermissionDecisions.Decided), "Decisions, newest first"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.permission.decisions",
        summary: "List permission decisions",
        description:
          "Every decision on a permission request (from the web UI, the TUI or an API client) and the requests that ended without one, newest first; for one session, agent or project.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "operator permission decisions", description: "Permission decision routes." }),
  )
