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
  list: "/operator/capability",
  override: "/operator/capability/override",
  disable: "/operator/capability/disable",
  revert: "/operator/capability/revert",
  remove: "/operator/capability/remove",
  create: "/operator/capability/create",
  copy: "/operator/capability/copy",
  source: "/operator/capability/source",
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

const target = Schema.Struct({
  kind: OperatorCapabilities.Kind,
  name: Schema.String,
  namespace: Schema.optional(Schema.String).annotate({
    description: "Act in this namespace's layer (over Global) instead of the project",
  }),
})

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
        HttpApiEndpoint.post("remove", OperatorCapabilityPaths.remove, {
          query: WorkspaceRoutingQuery,
          payload: target,
          success: described(Schema.Boolean, "Moved to Trash"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.remove",
            "Delete a capability defined at the scope",
            "Move a capability the project (or the namespace) defines itself to Trash: its file or folder, or its config entry. OpenCode's built-ins and capabilities from farther scopes can't be deleted here; disable them instead.",
          ),
        ),
        HttpApiEndpoint.post("copy", OperatorCapabilityPaths.copy, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            kind: OperatorCapabilities.Kind,
            name: Schema.String,
            namespace: Schema.String,
            to: Schema.String.annotate({ description: "The namespace that gets the copy" }),
          }),
          success: described(OperatorCapabilities.Item, "The copy, in the other namespace"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.copy",
            "Copy a namespace's capability to another namespace",
            "Copy a capability of a namespace (its file, or its config entry) into another namespace's layer, as that namespace's own. The copies are independent.",
          ),
        ),
        HttpApiEndpoint.get("source", OperatorCapabilityPaths.source, {
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            kind: OperatorCapabilities.Kind,
            name: Schema.String,
            namespace: Schema.optional(Schema.String),
          }),
          success: described(
            Schema.Struct({ location: Schema.String, text: Schema.String }),
            "Its file's text, or its config entry as JSON",
          ),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.source",
            "Read a capability's definition",
            "The text of a capability the project (or the namespace) defines itself, to edit: its file, or its config entry as JSON.",
          ),
        ),
        HttpApiEndpoint.put("edit", OperatorCapabilityPaths.source, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            kind: OperatorCapabilities.Kind,
            name: Schema.String,
            namespace: Schema.optional(Schema.String),
            text: Schema.String,
          }),
          success: described(OperatorCapabilities.Item, "The capability"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.edit",
            "Edit a capability's definition",
            "Replace the file (or the config entry) of a capability the project (or the namespace) defines itself.",
          ),
        ),
        HttpApiEndpoint.post("create", OperatorCapabilityPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: OperatorCapabilities.CreateInput,
          success: described(OperatorCapabilities.Item, "The new capability"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.create",
            "Create a capability at a scope",
            "Write a new command, skill, tool or plugin file under the project's (or the namespace's) .opencode, or an MCP server entry into its config. Agents are created with the agent form.",
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
