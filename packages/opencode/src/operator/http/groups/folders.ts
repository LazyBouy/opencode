import { OperatorFolders } from "@/operator/folders"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const OperatorFolderPaths = {
  roots: "/operator/folder/roots",
  list: "/operator/folder",
  init: "/operator/folder/init",
} as const

const folderError = <Name extends string, Status extends number>(name: Name, status: Status) =>
  Schema.ErrorClass<{ readonly name: Name; readonly data: { readonly message: string } }>(name)(
    { name: Schema.Literal(name), data: Schema.Struct({ message: Schema.String }) },
    { httpApiStatus: status },
  )
export class ApiFolderOutsideError extends folderError("OperatorFolderOutsideError", 403) {}
export class ApiFolderInvalidError extends folderError("OperatorFolderInvalidError", 400) {}

const Created = Schema.Struct({ path: Schema.String }).annotate({ identifier: "OperatorFolderCreated" })
const errors = [ApiFolderOutsideError, ApiFolderInvalidError]

// Browse and create folders in the server's workspace roots, so a new project can live anywhere in
// the mounted file system. Server-wide, part of OperatorRootApi.
export const OperatorFolderGroup = HttpApiGroup.make("operatorFolder")
  .add(
    HttpApiEndpoint.get("roots", OperatorFolderPaths.roots, {
      success: described(Schema.Array(Schema.String), "Workspace roots"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.folder.roots",
        summary: "List workspace roots",
        description:
          "The folders projects can be created in: OPENCODE_WORKSPACE_ROOTS on the server, or the server user's home folder.",
      }),
    ),
    HttpApiEndpoint.get("list", OperatorFolderPaths.list, {
      query: Schema.Struct({ path: Schema.optional(Schema.String) }),
      success: described(OperatorFolders.Listing, "The folder and its sub-folders"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.folder.list",
        summary: "List sub-folders",
        description:
          "The sub-folders of `path` (the first workspace root when left out), with which are git repositories. Hidden folders are left out.",
      }),
    ),
    HttpApiEndpoint.post("create", OperatorFolderPaths.list, {
      payload: Schema.Struct({
        parent: Schema.String,
        name: Schema.String,
        git: Schema.optional(Schema.Boolean).annotate({
          description:
            "Make it a git repository with an empty first commit, so it becomes its own project (default true)",
        }),
      }),
      success: described(Created, "Created"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.folder.create",
        summary: "Create a folder",
        description: "Create a folder inside a workspace root, by default as a git repository so it can be a project.",
      }),
    ),
    HttpApiEndpoint.post("init", OperatorFolderPaths.init, {
      payload: Schema.Struct({ path: Schema.String }),
      success: described(Created, "Initialized"),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "operator.folder.init",
        summary: "Make a folder a git repository",
        description:
          "Run git init and an empty first commit in an existing folder, so OpenCode treats it as its own project.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "operator folders", description: "Workspace folder routes." }))
