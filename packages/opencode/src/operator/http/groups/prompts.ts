import { OperatorPrompts } from "@/operator/prompts"
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

export const OperatorPromptPaths = {
  catalog: "/operator/prompt",
  preview: "/operator/prompt/preview",
} as const

export class ApiPromptNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorPromptNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorPromptNotFoundError")(
  { name: Schema.Literal("OperatorPromptNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export const OperatorPromptApi = HttpApi.make("operator-prompt")
  .add(
    HttpApiGroup.make("operatorPrompt")
      .add(
        HttpApiEndpoint.get("catalog", OperatorPromptPaths.catalog, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorPrompts.Catalog, "The project's tools"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.catalog",
            summary: "List tool descriptions",
            description:
              "This project's tools with their own descriptions (the built-in Tool Group layers). Every other prompt text is in a namespace's catalog, GET /operator/namespaces/{ns}/catalog.",
          }),
        ),
        HttpApiEndpoint.get("preview", OperatorPromptPaths.preview, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            agent: Schema.String,
            provider: Schema.optional(Schema.String),
            model: Schema.optional(Schema.String),
            profile: Schema.optional(Schema.String).annotate({
              description: "Preview this profile on the agent instead of its own (without its override)",
            }),
          }),
          success: described(OperatorPrompts.Preview, "The system prompt for an agent and model"),
          error: ApiPromptNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.preview",
            summary: "Preview a system prompt",
            description:
              "The system prompt an agent of this project sends with a model: its namespace, the profile it uses and why, the slots its override changed, and each section's group type and layer, with Purpose marked automatic. The model defaults to the agent's, then the configured default.",
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
