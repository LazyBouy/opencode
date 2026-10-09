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
import { ApiProjectConfigCopyError, ConfirmCopyField } from "./project-config"

export const OperatorConfigPaths = {
  layers: "/operator/config/layer",
  update: "/operator/config",
  schema: "/operator/config/schema",
  resolved: "/operator/config/resolved",
  project: "/operator/config/project",
  revert: "/operator/config/project/revert",
  compare: "/operator/config/compare",
} as const

// The config a project uses (global_and_opencode_namespaces_spec.md §7.2).
export const Resolved = Schema.Struct({
  mode: Schema.Literals(["own", "namespace"]).annotate({
    description: "own: the project's own config; namespace: its namespace's (it has none of its own)",
  }),
  project: Schema.String,
  file: Schema.String.annotate({ description: "The file the project uses" }),
  text: Schema.String,
  namespace: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    global: Schema.Boolean,
    file: Schema.String,
    exists: Schema.Boolean,
  }),
  copy: Schema.optional(
    Schema.Struct({
      namespace: Schema.String,
      name: Schema.String,
      copiedAt: Schema.Finite,
      changedSince: Schema.Boolean.annotate({ description: "The namespace's config changed after the copy" }),
    }),
  ).annotate({ description: "When the console made the project's config, as a copy of its namespace's" }),
  ownFiles: Schema.Array(Schema.String).annotate({
    description: "Every config file of the project's own, in the order OpenCode merges them",
  }),
  subfolderFiles: Schema.Array(Schema.String).annotate({
    description: "Config files below the project folder: they apply only to sessions in those subfolders",
  }),
  tracked: Schema.Boolean.annotate({ description: "The own file is tracked by git: edited, never removed" }),
  target: Schema.String.annotate({ description: "Where a copy is written" }),
}).annotate({ identifier: "OperatorProjectConfigResolved" })

export const Compare = Schema.Struct({
  project: Schema.Struct({ file: Schema.String, text: Schema.String }),
  namespace: Schema.Struct({ id: Schema.String, name: Schema.String, file: Schema.String, text: Schema.String }),
}).annotate({ identifier: "OperatorProjectConfigCompare" })

export const Reverted = Schema.Struct({
  trash: Schema.String.annotate({ description: "The Trash entry holding the project's config files" }),
  reload: Schema.Literals(["now", "when-idle"]),
}).annotate({ identifier: "OperatorProjectConfigReverted" })

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
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, namespace: Schema.optional(Schema.String) }),
          success: described(OperatorConfig.Layers, "Config sources and write targets"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.layers",
            summary: "List config layers",
            description:
              "List the config files that apply to this project, in load order, and the file a global, namespace or project write goes to. The namespace scope is the project's namespace unless `namespace` names another.",
          }),
        ),
        HttpApiEndpoint.patch("update", OperatorConfigPaths.update, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            scope: OperatorConfig.WriteScope,
            namespace: Schema.optional(Schema.String),
            ...ConfirmCopyField,
          }),
          payload: Schema.Record(Schema.String, Schema.Unknown),
          success: described(OperatorConfig.UpdateResult, "Written file"),
          error: [ApiOperatorConfigInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.update",
            summary: "Update config at a scope",
            description:
              "Merge a patch into the global, namespace or project config file, keeping comments. A null value removes the key so the inherited value applies. The result is validated before it is written. The project scope is copy-on-write: a project without a config of its own gets a copy of its namespace's, which needs confirmCopy.",
          }),
        ),
        HttpApiEndpoint.get("resolved", OperatorConfigPaths.resolved, {
          query: WorkspaceRoutingQuery,
          success: described(Resolved, "The config the project uses"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.resolved",
            summary: "The project's config",
            description:
              "The config this project uses: its own (own) or its namespace's (namespace), its file and text, the copy record and whether the namespace's config changed since, every own file, and files in subfolders.",
          }),
        ),
        HttpApiEndpoint.put("project", OperatorConfigPaths.project, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ...ConfirmCopyField }),
          payload: Schema.Struct({ text: Schema.String }),
          success: described(OperatorConfig.UpdateResult, "Written file"),
          error: [ApiOperatorConfigInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.project",
            summary: "Save the project's config",
            description:
              "Saves the project's config text, checked first. A project without a config of its own gets one at <project>/.opencode/opencode.jsonc (its namespace's config isn't changed): that needs confirmCopy, and lines the namespace locks are left out of it.",
          }),
        ),
        HttpApiEndpoint.post("revert", OperatorConfigPaths.revert, {
          query: WorkspaceRoutingQuery,
          success: described(Reverted, "Where the project's config went"),
          error: ApiOperatorConfigInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.revert",
            summary: "Use the namespace's config again",
            description:
              "Moves the project's own config files to Trash (restorable), so the project uses its namespace's config again. Refused for a file git tracks.",
          }),
        ),
        HttpApiEndpoint.get("compare", OperatorConfigPaths.compare, {
          query: WorkspaceRoutingQuery,
          success: described(Compare, "The project's and the namespace's config texts"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.config.compare",
            summary: "Compare with the namespace's config",
            description:
              "The project's own config text and its namespace's current config text, for a side-by-side diff.",
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
