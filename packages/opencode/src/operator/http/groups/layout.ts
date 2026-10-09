import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Where namespaces and projects live (global_and_opencode_namespaces_spec.md §4, §5, §9, §14).
// Server-wide, part of OperatorRootApi.
export const OperatorLayoutPaths = {
  layout: "/operator/layout",
  workingDir: "/operator/layout/working-dir",
} as const

export class ApiLayoutError extends Schema.ErrorClass<{
  readonly name: "OperatorLayoutError"
  readonly data: { readonly message: string }
}>("OperatorLayoutError")(
  { name: Schema.Literal("OperatorLayoutError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export const LayoutNamespace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  folder: Schema.String.annotate({ description: "The folder it uses now" }),
  target: Schema.String.annotate({ description: "Where it belongs: Global's folder, or <working dir>/<id>" }),
  inPlace: Schema.Boolean,
  global: Schema.Boolean.annotate({ description: "Global (or, with a blank working directory, Global · OpenCode)" }),
  configFile: Schema.String,
  inheritGlobal: Schema.Boolean,
}).annotate({ identifier: "OperatorLayoutNamespace" })

export const LayoutFlagged = Schema.Struct({
  project: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
  flag: Schema.Literals(["outside-opencode", "not-in-place"]),
}).annotate({ identifier: "OperatorLayoutFlagged" })

export const Layout = Schema.Struct({
  workingDir: Schema.optional(Schema.String).annotate({ description: "Absent: blank (Global and OpenCode are one)" }),
  merged: Schema.Boolean.annotate({
    description: "The working directory is blank: Global and OpenCode are one namespace",
  }),
  namespaces: Schema.Array(LayoutNamespace),
  flagged: Schema.Array(LayoutFlagged).annotate({
    description: "Projects outside OpenCode's folder, and projects not yet in their namespace's folder",
  }),
}).annotate({ identifier: "OperatorLayout" })

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const OperatorLayoutGroup = HttpApiGroup.make("operatorLayout")
  .add(
    HttpApiEndpoint.get("get", OperatorLayoutPaths.layout, {
      success: described(Layout, "The working directory, each namespace's folder, and the flagged projects"),
    }).annotateMerge(
      doc(
        "operator.layout.get",
        "The layout",
        'The working directory; each namespace (Global\'s included) with its folder, its target, whether it\'s in place, its config file and inheritance; and the projects flagged "Outside OpenCode\'s folder" or "Not in place".',
      ),
    ),
    HttpApiEndpoint.put("workingDir", OperatorLayoutPaths.workingDir, {
      payload: Schema.Struct({ workingDir: Schema.String.annotate({ description: "An absolute folder" }) }),
      success: described(Layout, "The layout with the working directory set"),
      error: ApiLayoutError,
    }).annotateMerge(
      doc(
        "operator.layout.workingDir",
        "Set the working directory",
        "Sets the working directory while it's blank: Global and OpenCode become separate namespaces, OpenCode's folder is <working dir>/opencode, and Global gets its own record. It must be inside the workspace roots, outside Global's folder and outside any git repository; it is created if missing. Changing it once set moves every namespace folder, which comes with the move procedure; clearing it isn't offered.",
      ),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator layout", description: "Where namespaces and projects live." }))
