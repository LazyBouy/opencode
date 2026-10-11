import { OperatorCapabilities } from "@/operator/capabilities"
import { OperatorToolPatterns } from "@/operator/tool-patterns"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ApiProjectConfigCopyError, ConfirmCopyField } from "./project-config"

export const OperatorCapabilityPaths = {
  list: "/operator/capability",
  override: "/operator/capability/override",
  disable: "/operator/capability/disable",
  revert: "/operator/capability/revert",
  remove: "/operator/capability/remove",
  create: "/operator/capability/create",
  copy: "/operator/capability/copy",
  source: "/operator/capability/source",
  take: "/operator/capability/take-opencode",
  seed: "/operator/capability/seed",
  toolPatterns: "/operator/capability/tool-patterns",
  toolPattern: "/operator/capability/tool-pattern",
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
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: target,
          success: described(OperatorCapabilities.Item, "The capability, now the project's own"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
        }).annotateMerge(
          doc(
            "operator.capability.override",
            "Override an inherited capability in the project",
            "Copy an inherited capability into the project to edit there: its file into the project's .opencode, or its config entry into the project's config. The copy wins; the source is unchanged.",
          ),
        ),
        HttpApiEndpoint.post("disable", OperatorCapabilityPaths.disable, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: target,
          success: described(OperatorCapabilities.Item, "The capability, now turned off"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
        }).annotateMerge(
          doc(
            "operator.capability.disable",
            "Turn an inherited capability off in the project",
            "MCP servers get enabled: false, agents disable: true, tools a deny permission, skills a deny skill permission, commands and plugins config capabilities.disabled; all in the project's config.",
          ),
        ),
        HttpApiEndpoint.post("revert", OperatorCapabilityPaths.revert, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: target,
          success: described(OperatorCapabilities.Item, "The capability as inherited"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
        }).annotateMerge(
          doc(
            "operator.capability.revert",
            "Revert to the inherited capability",
            "Remove the project's switch, or its override (to Trash), so the inherited capability applies again.",
          ),
        ),
        HttpApiEndpoint.post("remove", OperatorCapabilityPaths.remove, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: target,
          success: described(Schema.Boolean, "Moved to Trash"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
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
        HttpApiEndpoint.get("toolPatterns", OperatorCapabilityPaths.toolPatterns, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(OperatorToolPatterns.Pattern), "Each tool's permission pattern"),
        }).annotateMerge(
          doc(
            "operator.capability.toolPatterns",
            "List tools' permission patterns",
            "How each tool of the project asks for permission (memory_spec.md §9): the permission its rules use, its verbs, what the pattern is matched against, examples, and the rules that apply by default. OpenCode's tools from their code; MCP tools always `*`; a custom tool's as written for it.",
          ),
        ),
        HttpApiEndpoint.put("saveToolPattern", OperatorCapabilityPaths.toolPattern, {
          query: WorkspaceRoutingQuery,
          payload: OperatorToolPatterns.Input,
          success: described(OperatorToolPatterns.Pattern, "The tool's permission pattern"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.saveToolPattern",
            "Save a custom tool's permission pattern",
            "Writes how a custom tool asks for permission (its permission, verbs, pattern and examples). OpenCode's and MCP tools' come from their code.",
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
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: Schema.Struct({
            kind: OperatorCapabilities.Kind,
            name: Schema.String,
            namespace: Schema.optional(Schema.String),
            text: Schema.String,
          }),
          success: described(OperatorCapabilities.Item, "The capability"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
        }).annotateMerge(
          doc(
            "operator.capability.edit",
            "Edit a capability's definition",
            "Replace the file (or the config entry) of a capability the project (or the namespace) defines itself.",
          ),
        ),
        HttpApiEndpoint.post("takeOpenCode", OperatorCapabilityPaths.take, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: target,
          success: described(OperatorCapabilities.Item, "The copy, with OpenCode's current text"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
        }).annotateMerge(
          doc(
            "operator.capability.takeOpenCode",
            "Take OpenCode's version of a copied built-in",
            "A copy of one of OpenCode's built-ins (init, review, build, plan, general, explore, customize-opencode) takes OpenCode's current text, when an OpenCode release changed it.",
          ),
        ),
        HttpApiEndpoint.post("seed", OperatorCapabilityPaths.seed, {
          query: WorkspaceRoutingQuery,
          payload: OperatorCapabilities.SeedInput,
          success: described(Schema.Array(OperatorCapabilities.Item), "The copies"),
          error: ApiCapabilityError,
        }).annotateMerge(
          doc(
            "operator.capability.seed",
            "Give a new namespace its starting capabilities",
            "Copy the chosen capabilities of a source namespace's own layer (with OpenCode's copyable built-ins when the source is OpenCode) and the chosen keys of its config into another namespace's layer. MCP logins are not copied.",
          ),
        ),
        HttpApiEndpoint.post("create", OperatorCapabilityPaths.create, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: OperatorCapabilities.CreateInput,
          success: described(OperatorCapabilities.Item, "The new capability"),
          error: [ApiCapabilityError, ApiProjectConfigCopyError],
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
