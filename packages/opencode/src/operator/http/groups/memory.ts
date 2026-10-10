import { OperatorMemory } from "@/operator/memory"
import { OperatorMemoryFolders } from "@/operator/memory-folders"
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

export const OperatorMemoryPaths = {
  overview: "/operator/memory/overview",
  file: "/operator/memory/file",
  settings: "/operator/memory/settings",
} as const

export class ApiMemoryNotAllowedError extends Schema.ErrorClass<{
  readonly name: "OperatorMemoryNotAllowedError"
  readonly data: { readonly message: string }
}>("OperatorMemoryNotAllowedError")(
  { name: Schema.Literal("OperatorMemoryNotAllowedError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 403 },
) {}

export const OperatorMemoryApi = HttpApi.make("operator-memory")
  .add(
    HttpApiGroup.make("operatorMemory")
      .add(
        HttpApiEndpoint.get("overview", OperatorMemoryPaths.overview, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorMemory.Overview, "Memory files and database"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.overview",
            summary: "Get memory",
            description:
              "What OpenCode keeps for this project: the files it adds to prompts (instruction files, nested AGENTS.md, skills, identity layers, prompt overrides) and its database (path, size, rows per table, recent compaction summaries).",
          }),
        ),
        HttpApiEndpoint.get("read", OperatorMemoryPaths.file, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, path: Schema.String }),
          success: described(Schema.Struct({ path: Schema.String, text: Schema.String }), "The file"),
          error: ApiMemoryNotAllowedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.read",
            summary: "Read a memory file",
            description: "Read a file the memory overview lists.",
          }),
        ),
        HttpApiEndpoint.put("write", OperatorMemoryPaths.file, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ path: Schema.String, text: Schema.String }),
          success: described(Schema.Boolean, "Saved"),
          error: ApiMemoryNotAllowedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.write",
            summary: "Write a memory file",
            description:
              "Write a file the memory overview lists, or create AGENTS.md at the project root or in the global config folder.",
          }),
        ),
        HttpApiEndpoint.get("settings", OperatorMemoryPaths.settings, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorMemoryFolders.SettingsView, "Memory settings"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.settings",
            summary: "Get memory settings",
            description:
              "Whether .memory folders are committed to git (the default and each project's choice, with its repository's state), and how much of each level's index prompts show.",
          }),
        ),
        HttpApiEndpoint.put("saveSettings", OperatorMemoryPaths.settings, {
          query: WorkspaceRoutingQuery,
          payload: OperatorMemoryFolders.SettingsInput,
          success: described(OperatorMemoryFolders.SettingsView, "Memory settings"),
          error: ApiMemoryNotAllowedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.saveSettings",
            summary: "Save memory settings",
            description:
              "Change the commit default, a project's own choice (null: use the default) or the index limits. Repositories' .git/info/exclude follow at once; .gitignore is never edited.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator memory", description: "Memory routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "opencode operator memory HttpApi", version: "0.0.1", description: "Memory routes." }),
  )
