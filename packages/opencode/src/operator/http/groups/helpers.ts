import { OperatorHelpers } from "@/operator/helpers"
import { OperatorTrash } from "@/operator/trash"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Helpers: namespace resources (agent_types_spec.md §4.2). Server-wide: keyed by namespace.
export const OperatorHelperPaths = {
  list: "/operator/helper",
  namespace: "/operator/helper/:ns",
  helper: "/operator/helper/:ns/:name",
} as const

export class ApiHelperError extends Schema.ErrorClass<{
  readonly name: "OperatorHelperError"
  readonly data: { readonly message: string }
}>("OperatorHelperError")(
  { name: Schema.Literal("OperatorHelperError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorHelperGroup = HttpApiGroup.make("operatorHelpers")
  .add(
    HttpApiEndpoint.get("list", OperatorHelperPaths.list, {
      query: Schema.Struct({
        ns: Schema.optional(Schema.String).annotate({ description: "One namespace; without it, every namespace" }),
      }),
      success: described(Schema.Array(OperatorHelpers.Info), "Helpers, built-ins first in each namespace"),
      error: ApiHelperError,
    }).annotateMerge(
      doc(
        "operator.helper.list",
        "List helpers",
        "A namespace's helpers: the built-in ones (OpenCode's title, summary, compaction and agent generator, the fork's purpose and Dynamic generators), read-only, each with its role, and the namespace's own, each with its text (its helper profile's layer), model and limits.",
      ),
    ),
    HttpApiEndpoint.post("create", OperatorHelperPaths.namespace, {
      params: { ns: Schema.String },
      payload: Schema.Struct(OperatorHelpers.Create.fields),
      success: described(OperatorHelpers.Info, "The new helper"),
      error: ApiHelperError,
    }).annotateMerge(
      doc(
        "operator.helper.create",
        "Create a helper",
        "A new helper in a namespace, usable by every project of it. Its text becomes a helper profile holding one helper layer in the namespace's catalog. Model: small (the default), default or pick. Step limit 1–20 (default 5), time limit 10–600 seconds (default 120).",
      ),
    ),
    HttpApiEndpoint.patch("update", OperatorHelperPaths.helper, {
      params: { ns: Schema.String, name: Schema.String },
      payload: Schema.Struct(OperatorHelpers.Patch.fields),
      success: described(OperatorHelpers.Info, "The helper"),
      error: ApiHelperError,
    }).annotateMerge(
      doc(
        "operator.helper.update",
        "Update a helper",
        "Change a helper's description, model, limits or text (written into its helper layer). Built-in helpers are read-only; their text is edited on the Prompts page.",
      ),
    ),
    HttpApiEndpoint.delete("remove", OperatorHelperPaths.helper, {
      params: { ns: Schema.String, name: Schema.String },
      success: described(OperatorTrash.Entry, "The Trash entry"),
      error: ApiHelperError,
    }).annotateMerge(
      doc(
        "operator.helper.remove",
        "Move a helper to Trash",
        "Move a helper, with its helper profile and layer, to Trash, from where it can be restored. Built-in helpers can't be deleted.",
      ),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator helpers", description: "Helper routes." }))
