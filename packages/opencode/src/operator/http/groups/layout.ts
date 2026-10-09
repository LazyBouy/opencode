import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { OperatorLayoutMove } from "@/operator/layout-move"

// Where namespaces and projects live (global_and_opencode_namespaces_spec.md §4, §5, §9, §14).
// Server-wide, part of OperatorRootApi.
export const OperatorLayoutPaths = {
  layout: "/operator/layout",
  workingDir: "/operator/layout/working-dir",
  plan: "/operator/layout/plan",
  move: "/operator/layout/move",
  report: "/operator/layout/move/:id",
  later: "/operator/layout/upgrade/later",
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
  upgrade: Schema.Struct({
    waiting: Schema.Boolean.annotate({
      description: "The upgrade's moves wait for a confirmation (shown once per server start, until confirmed)",
    }),
    namespaces: Schema.Finite,
    projects: Schema.Finite,
    needsWorkingDir: Schema.Boolean.annotate({
      description: "Other namespaces exist but the working directory is blank: it is asked for first",
    }),
    suggested: Schema.optional(Schema.String).annotate({ description: "The folder the namespaces' folders share" }),
  }).annotate({ identifier: "OperatorLayoutUpgrade" }),
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
  .add(
    HttpApiEndpoint.post("plan", OperatorLayoutPaths.plan, {
      payload: OperatorLayoutMove.PlanInput,
      success: described(OperatorLayoutMove.Plan, "What would move, and what blocks it"),
      error: ApiLayoutError,
    }).annotateMerge(
      doc(
        "operator.layout.plan",
        "Plan a move",
        "A plan for moving a project into a namespace's folder (Move to namespace…, Move into OpenCode's folder), or a namespace into place: each item from → to, its size and sessions, and what blocks it (the target exists, the move crosses file systems, linked git worktrees, running sessions, open terminals, protected folders). Nothing moves.",
      ),
    ),
    HttpApiEndpoint.post("move", OperatorLayoutPaths.move, {
      payload: OperatorLayoutMove.MoveInput,
      success: described(OperatorLayoutMove.Report, "What moved, what was skipped, and files to update by hand"),
      error: ApiLayoutError,
    }).annotateMerge(
      doc(
        "operator.layout.move",
        "Move folders",
        "Moves a plan's chosen items, one by one, with a journal: their instances stop, the folder is renamed, and every stored path is rewritten (database, namespace store, operator stores, snapshots); a failure rolls the item back. Progress comes as operator.layout.move events on the global stream. Config files that name the old folder aren't rewritten: the report lists them.",
      ),
    ),
    HttpApiEndpoint.post("later", OperatorLayoutPaths.later, {
      success: described(Schema.Boolean, "true"),
    }).annotateMerge(
      doc(
        "operator.layout.later",
        "Not now",
        "The upgrade's confirmation isn't shown again until the server starts again; nothing moves.",
      ),
    ),
    HttpApiEndpoint.get("report", OperatorLayoutPaths.report, {
      params: { id: Schema.String },
      success: described(OperatorLayoutMove.Report, "A move's report"),
      error: ApiLayoutError,
    }).annotateMerge(doc("operator.layout.moveReport", "A move's report", "What a move did, by its id.")),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator layout", description: "Where namespaces and projects live." }))
