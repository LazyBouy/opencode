import { OperatorTrash } from "@/operator/trash"
import { OperatorTrashItems } from "@/operator/trash-items"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const OperatorTrashPaths = {
  list: "/operator/trash",
  project: "/operator/trash/project",
  session: "/operator/trash/session",
  item: "/operator/trash/item",
  entry: "/operator/trash/:id",
  restore: "/operator/trash/:id/restore",
} as const

export class ApiTrashError extends Schema.ErrorClass<{
  readonly name: "OperatorTrashError"
  readonly data: { readonly message: string }
}>("OperatorTrashError")(
  { name: Schema.Literal("OperatorTrashError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const doc = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

// Server-wide: Trash itself, and moving projects and sessions to it. Part of OperatorRootApi.
export const OperatorTrashGroup = HttpApiGroup.make("operatorTrash")
  .add(
    HttpApiEndpoint.get("list", OperatorTrashPaths.list, {
      success: described(Schema.Array(OperatorTrash.Entry), "What is in Trash"),
    }).annotateMerge(
      doc("operator.trash.list", "List Trash", "Everything deleted from the operator pages, newest first."),
    ),
    HttpApiEndpoint.post("project", OperatorTrashPaths.project, {
      payload: Schema.Struct({ key: Schema.String.annotate({ description: "The project's folder" }) }),
      success: described(OperatorTrash.Entry, "The Trash entry"),
      error: ApiTrashError,
    }).annotateMerge(
      doc(
        "operator.trash.project",
        "Move a project to Trash",
        "Move a project to Trash: its whole folder, its prompt and agent settings, and its sessions (archived). Restore puts them back; deleting it from Trash deletes them for good.",
      ),
    ),
    HttpApiEndpoint.post("session", OperatorTrashPaths.session, {
      payload: Schema.Struct({ sessionID: Schema.String }),
      success: described(OperatorTrash.Entry, "The Trash entry"),
      error: ApiTrashError,
    }).annotateMerge(
      doc(
        "operator.trash.session",
        "Move a session to Trash",
        "Move a session, with its subagents' sessions, to Trash: archived until restored, deleted for good with the entry.",
      ),
    ),
    HttpApiEndpoint.post("restore", OperatorTrashPaths.restore, {
      params: { id: Schema.String },
      success: described(OperatorTrash.Entry, "The restored entry"),
      error: ApiTrashError,
    }).annotateMerge(
      doc(
        "operator.trash.restore",
        "Restore from Trash",
        "Put an entry back where it was. Refused if something is there again.",
      ),
    ),
    HttpApiEndpoint.delete("purge", OperatorTrashPaths.entry, {
      params: { id: Schema.String },
      success: described(Schema.Boolean, "Deleted"),
      error: ApiTrashError,
    }).annotateMerge(
      doc(
        "operator.trash.purge",
        "Delete permanently",
        "Delete an entry for good, with its files and sessions. This cannot be undone.",
      ),
    ),
    HttpApiEndpoint.delete("empty", OperatorTrashPaths.list, {
      success: described(
        Schema.Struct({ purged: Schema.Finite }).annotate({ identifier: "OperatorTrashEmptied" }),
        "Emptied",
      ),
    }).annotateMerge(
      doc("operator.trash.empty", "Empty Trash", "Delete everything in Trash for good. This cannot be undone."),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator trash", description: "Trash routes." }))

// Per project: its own skills, commands, custom tools, MCP servers and memory files.
export const OperatorTrashItemApi = HttpApi.make("operator-trash-item")
  .add(
    HttpApiGroup.make("operatorTrashItem")
      .add(
        HttpApiEndpoint.post("remove", OperatorTrashPaths.item, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ kind: OperatorTrashItems.ItemKind, name: Schema.String }),
          success: described(OperatorTrash.Entry, "The Trash entry"),
          error: ApiTrashError,
        }).annotateMerge(
          doc(
            "operator.trash.item",
            "Move a project's item to Trash",
            "Move a skill (its folder), a command or custom tool (its file), an MCP server or a command defined in config (its entry), or a memory file to Trash. OpenCode's built-in items, and items from plugins or other folders, cannot be deleted.",
          ),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator trash items", description: "Trash routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "opencode operator trash HttpApi", version: "0.0.1", description: "Trash routes." }),
  )
