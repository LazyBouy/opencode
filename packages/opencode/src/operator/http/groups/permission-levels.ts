import { OperatorPermissionLevels } from "@/operator/permission-levels"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ApiProjectConfigCopyError, ConfirmCopyField } from "./project-config"

// A namespace's or project's permission level (tool_prompt_from_permission.md §3, §7).
export const OperatorPermissionLevelPaths = {
  level: "/operator/permission/level/:level",
} as const

const levelError = <Name extends string, Status extends number>(name: Name, status: Status) =>
  Schema.ErrorClass<{ readonly name: Name; readonly data: { readonly message: string } }>(name)(
    { name: Schema.Literal(name), data: Schema.Struct({ message: Schema.String }) },
    { httpApiStatus: status },
  )
export class ApiPermissionLevelInvalidError extends levelError("OperatorPermissionLevelInvalidError", 400) {}
export class ApiPermissionLevelLockedError extends levelError("OperatorPermissionLevelLockedError", 409) {}

const query = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  namespace: Schema.optional(Schema.String).annotate({
    description: "The namespace level: this namespace (by id) instead of the project's",
  }),
})

export const OperatorPermissionLevelApi = HttpApi.make("operator-permission-levels")
  .add(
    HttpApiGroup.make("operatorPermissionLevels")
      .add(
        HttpApiEndpoint.get("get", OperatorPermissionLevelPaths.level, {
          params: { level: OperatorPermissionLevels.LevelName },
          query,
          success: described(OperatorPermissionLevels.View, "The level's permissions"),
          error: ApiPermissionLevelInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.permissionLevel.get",
            summary: "A namespace's or project's permissions",
            description:
              "The lines in force at the level (OpenCode's, global's if inherited, the namespace's, and for a project its own), each with its level and lock; the level's own lines as written in its config file; the inherited lines it deletes; its locks; and what a lock above sets aside.",
          }),
        ),
        HttpApiEndpoint.put("save", OperatorPermissionLevelPaths.level, {
          params: { level: OperatorPermissionLevels.LevelName },
          query: Schema.Struct({ ...query.fields, ...ConfirmCopyField }),
          payload: OperatorPermissionLevels.SaveInput,
          success: described(OperatorPermissionLevels.View, "The level's permissions after the save"),
          error: [ApiPermissionLevelInvalidError, ApiPermissionLevelLockedError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.permissionLevel.save",
            summary: "Save a namespace's or project's permissions",
            description:
              "Writes the level's lines to its config file's `permission` and its deletions and locks to the fork's store. Refused when a lock above covers a line or a deletion, or when it deletes OpenCode's own lines in the OpenCode namespace. Applies at once; the projects reload to read the file when none of their sessions is running.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "operator permission levels",
          description: "Namespace and project permission routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator permission levels HttpApi",
      version: "0.0.1",
      description: "Namespace and project permission routes.",
    }),
  )
