import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// A namespace's config, and Global's (global_and_opencode_namespaces_spec.md §8): edited only here
// (Settings → Namespaces → a namespace → Config), never from a project page. Server-wide, part of
// OperatorRootApi.
export const OperatorNamespaceConfigPaths = {
  config: "/operator/namespace/:id/config",
} as const

export class ApiNamespaceConfigError extends Schema.ErrorClass<{
  readonly name: "OperatorNamespaceConfigError"
  readonly data: { readonly message: string; readonly path: string }
}>("OperatorNamespaceConfigError")(
  {
    name: Schema.Literal("OperatorNamespaceConfigError"),
    data: Schema.Struct({ message: Schema.String, path: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const NamespaceConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  global: Schema.Boolean.annotate({ description: "Global (or, with a blank working directory, Global · OpenCode)" }),
  file: Schema.String,
  text: Schema.String,
  exists: Schema.Boolean.annotate({ description: "false: the namespace has no config yet; saving creates it" }),
  using: Schema.Array(Schema.Struct({ project: Schema.String, name: Schema.String })).annotate({
    description: "The namespace's projects that use this config (they have none of their own)",
  }),
  own: Schema.Array(Schema.Struct({ project: Schema.String, name: Schema.String })).annotate({
    description: "The namespace's projects with their own config: changes here don't reach them",
  }),
  inheriting: Schema.Array(Schema.String).annotate({
    description: "Global: the namespaces that inherit its capabilities (its other settings reach every namespace)",
  }),
  reload: Schema.optional(Schema.Literals(["now", "when-idle"])),
}).annotate({ identifier: "OperatorNamespaceConfig" })

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorNamespaceConfigGroup = HttpApiGroup.make("operatorNamespaceConfig")
  .add(
    HttpApiEndpoint.get("get", OperatorNamespaceConfigPaths.config, {
      params: { id: Schema.String },
      success: described(NamespaceConfig, "The namespace's config and who uses it"),
      error: ApiNamespaceConfigError,
    }).annotateMerge(
      doc(
        "operator.namespaceConfig.get",
        "A namespace's config",
        "A namespace's config file (`global` for Global's own) and text, the namespace's projects that use it and those with their own config, and, for Global, the namespaces that inherit it.",
      ),
    ),
    HttpApiEndpoint.put("save", OperatorNamespaceConfigPaths.config, {
      params: { id: Schema.String },
      payload: Schema.Struct({ text: Schema.String }),
      success: described(NamespaceConfig, "The namespace's config after the save"),
      error: ApiNamespaceConfigError,
    }).annotateMerge(
      doc(
        "operator.namespaceConfig.save",
        "Save a namespace's config",
        "Replaces a namespace's config file (created when missing) with the given JSONC text, checked first. The projects that use it reload when idle; for Global, every project.",
      ),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "operator namespace config", description: "A namespace's and Global's config." }),
  )
