import { OperatorConfig } from "@/operator/config"
import { OperatorPrompts } from "@/operator/prompts"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const OperatorPromptPaths = {
  catalog: "/operator/prompt",
  preview: "/operator/prompt/preview",
  prompt: "/operator/prompt/:id",
} as const

const ScopeQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: OperatorConfig.Scope })

export const OperatorPromptApi = HttpApi.make("operator-prompt")
  .add(
    HttpApiGroup.make("operatorPrompt")
      .add(
        HttpApiEndpoint.get("catalog", OperatorPromptPaths.catalog, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorPrompts.Catalog, "Prompt texts, overrides and switches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.catalog",
            summary: "List prompt texts",
            description:
              "Every prompt text OpenCode adds on its own (base prompts per model family, reminders, notices, the agent generator, tool descriptions), with any global or project overrides, and the switches for generated sections.",
          }),
        ),
        HttpApiEndpoint.get("preview", OperatorPromptPaths.preview, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            agent: Schema.String,
            provider: Schema.optional(Schema.String),
            model: Schema.optional(Schema.String),
          }),
          success: described(OperatorPrompts.Preview, "The system prompt for an agent and model"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.preview",
            summary: "Preview a system prompt",
            description:
              "The system messages an agent sends with a model in this project, split into sections with where each comes from. The model defaults to the agent's, then the configured default.",
          }),
        ),
        HttpApiEndpoint.put("write", OperatorPromptPaths.prompt, {
          params: { id: Schema.String },
          query: ScopeQuery,
          payload: Schema.Struct({ text: Schema.String }),
          success: described(Schema.Boolean, "Saved"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.write",
            summary: "Override a prompt text",
            description:
              "Write the global or project override for a prompt text (`tool.<id>` for a tool description). An empty text turns it off. Applies from the next request.",
          }),
        ),
        HttpApiEndpoint.delete("remove", OperatorPromptPaths.prompt, {
          params: { id: Schema.String },
          query: ScopeQuery,
          success: described(Schema.Boolean, "Removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.remove",
            summary: "Remove a prompt override",
            description: "Delete the scope's override so OpenCode's own text (or the global override) applies again.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator prompts", description: "Prompt text routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator prompt HttpApi",
      version: "0.0.1",
      description: "Prompt text routes.",
    }),
  )
