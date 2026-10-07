import { OperatorAgentPermissions } from "@/operator/agent-permissions"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorConfig } from "@/operator/config"
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

// Under /operator/agent (the API's agent routes), never the app's /operator/agents pages.
export const OperatorAgentPermissionPaths = {
  agent: "/operator/agent/:name/permissions",
  locks: "/operator/agent/:name/permission-locks",
} as const

const permissionError = <Name extends string, Status extends number>(name: Name, status: Status) =>
  Schema.ErrorClass<{ readonly name: Name; readonly data: { readonly message: string } }>(name)(
    { name: Schema.Literal(name), data: Schema.Struct({ message: Schema.String }) },
    { httpApiStatus: status },
  )
export class ApiAgentPermissionsNotFoundError extends permissionError("OperatorAgentPermissionsNotFoundError", 404) {}
export class ApiAgentPermissionsInvalidError extends permissionError("OperatorAgentPermissionsInvalidError", 400) {}

export const AgentPermissionsWritten = Schema.Struct({
  path: Schema.String,
  reload: Schema.optional(Schema.Literals(["now", "when-idle"])).annotate({
    description:
      "When the project (or, for a global file, every project) reloads to read it: now, or once none of its sessions is running",
  }),
}).annotate({
  identifier: "OperatorAgentPermissionsWritten",
})

export const OperatorAgentPermissionApi = HttpApi.make("operator-agent-permissions")
  .add(
    HttpApiGroup.make("operatorAgentPermissions")
      .add(
        HttpApiEndpoint.get("get", OperatorAgentPermissionPaths.agent, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorAgentPermissions.Info, "The agent's permissions for the editor"),
          error: ApiAgentPermissionsNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentPermissions.get",
            summary: "An agent's permissions, with where each rule comes from",
            description:
              "The agent's full permission list in evaluation order, each rule with where it comes from (OpenCode's code, a config file, the agent's own rules), which rules are the agent's own, those rules as written, the pattern each permission is asked with, and the file a save writes at each scope.",
          }),
        ),
        HttpApiEndpoint.put("save", OperatorAgentPermissionPaths.agent, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            scope: OperatorConfig.Scope,
            rules: PermissionV1.Ruleset.annotate({ description: "The agent's own rules, in order" }),
            confirmOrder: Schema.optional(Schema.Boolean).annotate({
              description: "Save even though grouping the rules by permission changes their order",
            }),
          }),
          success: described(AgentPermissionsWritten, "The file that was written"),
          error: [ApiAgentPermissionsNotFoundError, ApiAgentPermissionsInvalidError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentPermissions.save",
            summary: "Save an agent's own permission rules",
            description:
              "Write the agent's own rules, in order, to its agent file or its `agent.<name>` config entry at the scope (a built-in agent gets an entry). A permission + pattern pair written twice is refused, and so is an order that saving grouped by permission would change the result of, unless confirmed. They apply to the agent's sessions at once; the project reloads to read them when none of its sessions is running.",
          }),
        ),
        HttpApiEndpoint.get("locks", OperatorAgentPermissionPaths.locks, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorPermissionLocks.Info, "The agent's locked rules"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentPermissions.locks",
            summary: "An agent's locked rules",
            description:
              "The rules of the agent's list its sessions may not override (by permission and pattern), and, for a subagent, whether it also checks its parent session's agent's locks.",
          }),
        ),
        HttpApiEndpoint.put("saveLocks", OperatorAgentPermissionPaths.locks, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: OperatorPermissionLocks.Info,
          success: described(OperatorPermissionLocks.Info, "The agent's locked rules"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentPermissions.saveLocks",
            summary: "Lock or unlock an agent's rules",
            description:
              "Set which of the agent's rules its sessions may not override. For every request a locked rule matches, the agent's rule decides, whatever the session's rules say; it applies at once.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "operator agent permissions", description: "Agent permission routes." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator agent permissions HttpApi",
      version: "0.0.1",
      description: "Agent permission routes.",
    }),
  )
