import { OperatorConfig } from "@/operator/config"
import { OperatorIdentity } from "@/operator/identity"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const OperatorIdentityPaths = {
  list: "/operator/identity",
  layer: "/operator/identity/layer",
  reorder: "/operator/identity/reorder",
  preview: "/operator/identity/preview",
} as const

export const OperatorIdentityApi = HttpApi.make("operator-identity")
  .add(
    HttpApiGroup.make("operatorIdentity")
      .add(
        HttpApiEndpoint.get("list", OperatorIdentityPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(OperatorIdentity.Info), "Identity layers in prompt order"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.identity.list",
            summary: "List identity layers",
            description:
              "The global and project identity layers, in the order they are added to system prompts: org, user, project, then priority.",
          }),
        ),
        HttpApiEndpoint.put("save", OperatorIdentityPaths.layer, {
          query: WorkspaceRoutingQuery,
          payload: OperatorIdentity.SaveInput,
          success: described(OperatorIdentity.Info, "The saved layer"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.identity.save",
            summary: "Save an identity layer",
            description: "Create or replace an identity layer file. Changes apply from the next request.",
          }),
        ),
        HttpApiEndpoint.delete("remove", OperatorIdentityPaths.layer, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: OperatorConfig.Scope, file: Schema.String }),
          success: described(Schema.Boolean, "Deleted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.identity.remove",
            summary: "Delete an identity layer",
            description: "Delete an identity layer file.",
          }),
        ),
        HttpApiEndpoint.post("reorder", OperatorIdentityPaths.reorder, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ scope: OperatorConfig.Scope, files: Schema.Array(Schema.String) }),
          success: described(Schema.Array(OperatorIdentity.Info), "Identity layers in prompt order"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.identity.reorder",
            summary: "Reorder identity layers",
            description: "Set a scope's layer order by rewriting their priorities (10, 20, 30, …).",
          }),
        ),
        HttpApiEndpoint.get("preview", OperatorIdentityPaths.preview, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, agent: Schema.optional(Schema.String) }),
          success: described(Schema.Struct({ text: Schema.String }), "Identity text"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.identity.preview",
            summary: "Preview an agent's identity",
            description: "The identity text added to the given agent's system prompt.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator identity", description: "Identity layer routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator identity HttpApi",
      version: "0.0.1",
      description: "Identity layer routes.",
    }),
  )
