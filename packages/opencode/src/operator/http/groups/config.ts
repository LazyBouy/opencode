import { OperatorConfig } from "@/operator/config"
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

export const OperatorConfigPaths = {
  layers: "/operator/config/layer",
  update: "/operator/config",
  write: "/operator/config/raw",
  schema: "/operator/config/schema",
} as const

export class ApiOperatorConfigInvalidError extends Schema.ErrorClass<ApiOperatorConfigInvalidError>(
  "OperatorConfigInvalidError",
)(
  {
    name: Schema.Literal("OperatorConfigInvalidError"),
    data: Schema.Struct({ path: Schema.String, message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const OperatorConfigApi = HttpApi.make("operator-config")
  .add(
    HttpApiGroup.make("operatorConfig")
      .add(
        HttpApiEndpoint.get("layers", OperatorConfigPaths.layers, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorConfig.Layers, "Config sources and write targets"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.layers",
            summary: "List config layers",
            description:
              "List the config files that apply to this project, in load order, and the file a global or project write goes to.",
          }),
        ),
        HttpApiEndpoint.patch("update", OperatorConfigPaths.update, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: OperatorConfig.Scope }),
          payload: Schema.Record(Schema.String, Schema.Unknown),
          success: described(OperatorConfig.UpdateResult, "Written file"),
          error: ApiOperatorConfigInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.update",
            summary: "Update config at a scope",
            description:
              "Merge a patch into the global or project config file, keeping comments. A null value removes the key so the inherited value applies. The result is validated before it is written.",
          }),
        ),
        HttpApiEndpoint.put("write", OperatorConfigPaths.write, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: OperatorConfig.Scope }),
          payload: Schema.Struct({ text: Schema.String }),
          success: described(OperatorConfig.UpdateResult, "Written file"),
          error: ApiOperatorConfigInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.write",
            summary: "Replace a config file",
            description:
              "Replace the global or project config file with the given JSONC text. The text is validated before it is written.",
          }),
        ),
        HttpApiEndpoint.get("schema", OperatorConfigPaths.schema, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, Schema.Unknown), "Config JSON schema"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.schema",
            summary: "Get config JSON schema",
            description: "The JSON schema of the config file, for building editors.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator config", description: "Scoped config routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator config HttpApi",
      version: "0.0.1",
      description: "Scoped config routes.",
    }),
  )
