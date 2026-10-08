import { OperatorCapabilities } from "@/operator/capabilities"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const OperatorCapabilityPaths = {
  list: "/operator/capabilities",
  override: "/operator/capabilities/override",
  disable: "/operator/capabilities/disable",
  revert: "/operator/capabilities/revert",
} as const

export class ApiCapabilityError extends Schema.ErrorClass<{
  readonly name: "OperatorCapabilityError"
  readonly data: { readonly message: string }
}>("OperatorCapabilityError")(
  { name: Schema.Literal("OperatorCapabilityError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

const target = Schema.Struct({ kind: OperatorCapabilities.Kind, name: Schema.String })

// Per project (capability_scopes_spec.md §3, §5): the capabilities in effect with their scope and
// state, and the project's choices for an inherited one: override, disable, revert.
export const OperatorCapabilityApi = HttpApi.make("operator-capabilities")
  .add(
    HttpApiGroup.make("operatorCapabilities")
      .add(
        HttpApiEndpoint.get("list", OperatorCapabilityPaths.list, {
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            namespace: Schema.optional(Schema.String).annotate({
              description:
                "A namespace's own capabilities (its layer, with Global when it inherits it) instead of the project's",
            }),
          }),
          success: described(OperatorCapabilities.Inventory, "The capabilities"),
        }).annotateMerge(
          doc(
            "operator.capability.list",
            "List capabilities by scope",
            "The project's commands, skills, tools, MCP servers, agents and plugins, each with the scope its definition comes from (OpenCode, Global, Namespace, Project), the farther definitions it replaces, and whether it is turned off. With `namespace`, that namespace's own instead.",
          ),
        ),
        HttpApiEndpoint.post("override", OperatorCapabilityPaths.override, {
          query: WorkspaceRoutingQuery,
          payload: target,
          success: described(OperatorCapabilities.Item, "The capability, now the project's own"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.override",
            "Override an inherited capability in the project",
            "Copy an inherited capability into the project to edit there: its file into the project's .opencode, or its config entry into the project's config. The copy wins; the source is unchanged.",
          ),
        ),
        HttpApiEndpoint.post("disable", OperatorCapabilityPaths.disable, {
          query: WorkspaceRoutingQuery,
          payload: target,
          success: described(OperatorCapabilities.Item, "The capability, now turned off"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.disable",
            "Turn an inherited capability off in the project",
            "MCP servers get enabled: false, agents disable: true, tools a deny permission, skills a deny skill permission, commands and plugins config capabilities.disabled; all in the project's config.",
          ),
        ),
        HttpApiEndpoint.post("revert", OperatorCapabilityPaths.revert, {
          query: WorkspaceRoutingQuery,
          payload: target,
          success: described(OperatorCapabilities.Item, "The capability as inherited"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.revert",
            "Revert to the inherited capability",
            "Remove the project's switch, or its override (to Trash), so the inherited capability applies again.",
          ),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator capabilities", description: "Capability routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator capabilities HttpApi",
      version: "0.0.1",
      description: "Capability routes.",
    }),
  )
