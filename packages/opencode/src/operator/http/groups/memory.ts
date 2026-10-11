import { OperatorMemory } from "@/operator/memory"
import { OperatorMemoryFolders } from "@/operator/memory-folders"
import { OperatorMemoryPage } from "@/operator/memory-page"
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
  levels: "/operator/memory/levels",
  entry: "/operator/memory/entry",
  index: "/operator/memory/index",
} as const

export class ApiMemoryInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorMemoryInvalidError"
  readonly data: { readonly message: string }
}>("OperatorMemoryInvalidError")(
  { name: Schema.Literal("OperatorMemoryInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const EntryQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  level: OperatorMemoryPage.LevelName,
  file: Schema.String,
  agent: Schema.optional(Schema.String),
})

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
        HttpApiEndpoint.get("levels", OperatorMemoryPaths.levels, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, agent: Schema.optional(Schema.String) }),
          success: described(OperatorMemoryPage.Levels, "The project's memory levels"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.levels",
            summary: "List memory levels",
            description:
              "The project's short-term memory: its namespace's, its own and an agent's (build unless named), each with its folder, entries, lines that are not entries, files no line names, and its size against the prompts' limits.",
          }),
        ),
        HttpApiEndpoint.get("entry", OperatorMemoryPaths.entry, {
          query: EntryQuery,
          success: described(OperatorMemoryPage.Detail, "The memory"),
          error: ApiMemoryInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.entry",
            summary: "Read a memory",
            description: "One memory's file: its title, description, when and by whom it was written, and its text.",
          }),
        ),
        HttpApiEndpoint.put("saveEntry", OperatorMemoryPaths.entry, {
          query: WorkspaceRoutingQuery,
          payload: OperatorMemoryPage.SaveInput,
          success: described(OperatorMemoryPage.Detail, "The memory as saved"),
          error: ApiMemoryInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.saveEntry",
            summary: "Save a memory",
            description:
              "A new memory (no file) or a change to one: its file and its MEMORY.md line, written as the memory tool writes them, by the user.",
          }),
        ),
        HttpApiEndpoint.delete("forgetEntry", OperatorMemoryPaths.entry, {
          query: EntryQuery,
          success: described(Schema.Boolean, "Moved to Trash"),
          error: ApiMemoryInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.forgetEntry",
            summary: "Delete a memory",
            description: "Moves a memory's file to Trash and takes its line out of MEMORY.md.",
          }),
        ),
        HttpApiEndpoint.put("writeIndex", OperatorMemoryPaths.index, {
          query: WorkspaceRoutingQuery,
          payload: OperatorMemoryPage.IndexInput,
          success: described(OperatorMemoryPage.Level, "The level"),
          error: ApiMemoryInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.memory.writeIndex",
            summary: "Write MEMORY.md",
            description:
              "A level's MEMORY.md as text, for a hand fix: lines that are not entries are kept and flagged.",
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
