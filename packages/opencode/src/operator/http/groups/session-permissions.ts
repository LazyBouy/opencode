import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Under /operator/session (the API's session routes), never the app's /operator/sessions pages.
export const OperatorSessionPermissionPaths = {
  session: "/operator/session/:sessionID/permissions",
} as const

export class ApiSessionPermissionsNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorSessionPermissionsNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorSessionPermissionsNotFoundError")(
  { name: Schema.Literal("OperatorSessionPermissionsNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export class ApiSessionPermissionsLockedError extends Schema.ErrorClass<{
  readonly name: "OperatorSessionPermissionsLockedError"
  readonly data: { readonly message: string }
}>("OperatorSessionPermissionsLockedError")(
  { name: Schema.Literal("OperatorSessionPermissionsLockedError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export const OperatorSessionPermissionApi = HttpApi.make("operator-session-permissions")
  .add(
    HttpApiGroup.make("operatorSessionPermissions")
      .add(
        HttpApiEndpoint.get("get", OperatorSessionPermissionPaths.session, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorSessionPermissions.Info, "The session's permissions for the editor"),
          error: ApiSessionPermissionsNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.sessionPermissions.get",
            summary: "A session's permissions, with where each rule comes from",
            description:
              "The session's agent's full list, then the session's own rules, in evaluation order, each with where it comes from (for session rules: set by you, Always allow, added by task, a client's tool switch, and when).",
          }),
        ),
        HttpApiEndpoint.put("save", OperatorSessionPermissionPaths.session, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            rules: PermissionV1.Ruleset.annotate({ description: "The session's own rules; none resets" }),
            deleted: Schema.optional(
              Schema.Array(Schema.Struct({ permission: Schema.String, pattern: Schema.String })),
            ).annotate({ description: "Inherited lines the session deletes (unchanged when absent)" }),
          }),
          success: described(OperatorSessionPermissions.Info, "The session's permissions after the save"),
          error: [ApiSessionPermissionsNotFoundError, ApiSessionPermissionsLockedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.sessionPermissions.save",
            summary: "Replace a session's own permission rules",
            description:
              "Replace the session's own rules (applied at once, after its agent's) and record where each came from. An empty list resets the session to its agent. A rule that would change a rule the agent locks is refused.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "operator session permissions", description: "Session permission routes." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator session permissions HttpApi",
      version: "0.0.1",
      description: "Session permission routes.",
    }),
  )
