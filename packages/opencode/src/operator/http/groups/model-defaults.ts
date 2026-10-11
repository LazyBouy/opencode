import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { OperatorConfig } from "@/operator/config"
import { OperatorModels } from "@/operator/models"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ApiProjectConfigCopyError } from "./project-config"

// The default and small model at each level (default_models_spec.md §11): a namespace's own chain, writing
// Settings', a namespace's or a project's, and where a model is the default. Server-wide, part of
// OperatorRootApi; the per-project chain is `GET /operator/model` (operator.model.defaults). No path here is a
// web page's (the page is /operator/models).
export const OperatorModelDefaultsPaths = {
  namespace: "/operator/model/namespace",
  write: "/operator/model/default",
  defaultFor: "/operator/model/default-for",
} as const

export class ApiModelDefaultError extends Schema.ErrorClass<{
  readonly name: "OperatorModelDefaultError"
  readonly data: { readonly message: string }
}>("OperatorModelDefaultError")(
  { name: Schema.Literal("OperatorModelDefaultError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export const NamespaceModels = Schema.Struct({
  namespace: Schema.optional(Schema.String).annotate({ description: "Absent: Settings alone" }),
  name: Schema.optional(Schema.String),
  settings: Schema.Boolean.annotate({
    description: "Its config is Settings (Global, or Global · OpenCode with a blank working directory): read-only here",
  }),
  path: Schema.String.annotate({ description: "The file its first row writes: the namespace's config, or Settings'" }),
  chain: OperatorModels.Chains,
}).annotate({ identifier: "OperatorNamespaceModels" })

export const WriteInput = Schema.Struct({
  level: Schema.Literals(["settings", "namespace", "project"]),
  namespace: Schema.optional(Schema.String).annotate({ description: "level namespace: the namespace" }),
  directory: Schema.optional(Schema.String).annotate({ description: "level project: the project's folder" }),
  key: Schema.Literals(["model", "small_model"]),
  model: Schema.NullOr(Schema.String).annotate({
    description: "provider/model; null removes the key, so the level inherits (Let OpenCode decide, for Settings)",
  }),
  confirmCopy: Schema.optional(Schema.Boolean).annotate({
    description:
      "level project: when the project has no config of its own, give it a copy of its namespace's config (without the model keys) with this change",
  }),
})

const placeFields = {
  model: Schema.Boolean.annotate({ description: "It is the default model here" }),
  small: Schema.Boolean.annotate({ description: "It is the small model here" }),
  path: Schema.String.annotate({ description: "The config file that sets it" }),
}

export const DefaultFor = Schema.Struct({
  model: Schema.String,
  settings: Schema.optional(Schema.Struct(placeFields).annotate({ identifier: "OperatorModelDefaultForSettings" })),
  namespaces: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, ...placeFields }).annotate({
      identifier: "OperatorModelDefaultForNamespace",
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({ key: Schema.String, name: Schema.String, namespace: Schema.String, ...placeFields }).annotate({
      identifier: "OperatorModelDefaultForProject",
    }),
  ),
}).annotate({ identifier: "OperatorModelDefaultFor" })

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorModelDefaultsGroup = HttpApiGroup.make("operatorModelDefaults")
  .add(
    HttpApiEndpoint.get("namespace", OperatorModelDefaultsPaths.namespace, {
      query: Schema.Struct({ namespace: Schema.optional(Schema.String) }),
      success: described(NamespaceModels, "The namespace's default and small model, and where each comes from"),
      error: ApiModelDefaultError,
    }).annotateMerge(
      doc(
        "operator.model.namespace",
        "A namespace's default and small model",
        "The chain of the default and small model for a namespace without a project (Settings, its config, the environment) and the model in effect. What OpenCode decides is computed in the namespace's default project, else the server's folder. Without `namespace`: Settings' values (Settings → Models).",
      ),
    ),
    HttpApiEndpoint.put("write", OperatorModelDefaultsPaths.write, {
      payload: WriteInput,
      success: described(OperatorConfig.UpdateResult, "The file written, and when the projects reload"),
      error: [ApiModelDefaultError, ApiProjectConfigCopyError],
    }).annotateMerge(
      doc(
        "operator.model.write",
        "Set a default or small model",
        "settings writes Global's config; namespace writes the namespace's config (refused for Global and for Global · OpenCode: use settings); project writes the project's config, copy-on-write (a copy of its namespace's config without its model keys, with confirmCopy). A null model removes the key.",
      ),
    ),
    HttpApiEndpoint.get("defaultFor", OperatorModelDefaultsPaths.defaultFor, {
      query: Schema.Struct({ model: Schema.String }),
      success: described(DefaultFor, "Where the model is set as the default or small model"),
    }).annotateMerge(
      doc(
        "operator.model.defaultFor",
        "Where a model is the default",
        "Settings, the namespaces and the projects whose config sets this model as the default or small model. Levels that only inherit it aren't listed.",
      ),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "operator model defaults",
      description: "The default and small model at each level.",
    }),
  )
