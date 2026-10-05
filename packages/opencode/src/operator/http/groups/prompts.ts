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
  sample: "/operator/prompt/sample",
  purpose: "/operator/prompt/purpose",
} as const

export class ApiPromptNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorPromptNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorPromptNotFoundError")(
  { name: Schema.Literal("OperatorPromptNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export class ApiPromptGenerateError extends Schema.ErrorClass<{
  readonly name: "OperatorPromptGenerateError"
  readonly data: { readonly message: string }
}>("OperatorPromptGenerateError")(
  { name: Schema.Literal("OperatorPromptGenerateError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 502 },
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
        HttpApiEndpoint.get("sample", OperatorPromptPaths.sample, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            agent: Schema.String,
            layer: Schema.String,
            provider: Schema.optional(Schema.String),
            model: Schema.optional(Schema.String),
          }),
          success: described(OperatorPrompts.Sample, "What the layer fills in"),
          error: [ApiPromptNotFoundError, ApiPromptGenerateError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.sample",
            summary: "Sample a layer",
            description:
              "What one layer fills in for an agent of this project and a model: a Dynamic layer's text (the agent's prompt, the base prompt for the model, the environment, skills, MCP instructions, instruction files; your Dynamic layers are written by the dynamic generator), or a fixed layer's text.",
          }),
        ),
        HttpApiEndpoint.post("purpose", OperatorPromptPaths.purpose, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            kind: Schema.Literals(["org", "project"]),
            ns: Schema.optional(Schema.String).annotate({
              description: "The namespace whose org purpose is drafted; the project's by default",
            }),
            brief: Schema.optional(Schema.String).annotate({ description: "What the purpose should say" }),
          }),
          success: described(
            Schema.Struct({ text: Schema.String }).annotate({ identifier: "OperatorPurposeDraft" }),
            "The draft",
          ),
          error: ApiPromptGenerateError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.prompt.purpose",
            summary: "Draft a purpose",
            description:
              "Ask the purpose generator (a helper agent) for a draft project purpose, from this project's files, or org purpose, from the namespace's projects, following an optional brief. Nothing is saved.",
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
