import { OperatorCalls } from "@/operator/calls"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
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

// Under /operator/agent (the API's agent routes), never the app's /operator/agents pages.
export const OperatorToolPromptPaths = {
  prompt: "/operator/agent/:name/tool-prompt",
  draft: "/operator/agent/:name/tool-prompt/draft",
  last: "/operator/agent/:name/tool-prompt/last",
} as const

export class ApiToolPromptNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorToolPromptNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorToolPromptNotFoundError")(
  { name: Schema.Literal("OperatorToolPromptNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

const Context = {
  model: Schema.optional(Schema.String).annotate({ description: "provider/model; the agent's model by default" }),
  runsAs: Schema.optional(OperatorToolPrompt.RunsAs),
  parent: Schema.optional(Schema.String).annotate({
    description:
      "Runs as Subagent: the session that starts it. Its deny and external_directory rules pass to the subagent, as `task` passes them, and its agent's locks apply when the subagent inherits them",
  }),
}

export const OperatorToolPromptApi = HttpApi.make("operator-tool-prompt")
  .add(
    HttpApiGroup.make("operatorToolPrompt")
      .add(
        HttpApiEndpoint.get("prompt", OperatorToolPromptPaths.prompt, {
          params: { name: Schema.String },
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            ...Context,
            session: Schema.optional(Schema.String).annotate({
              description: "Build it for one of the agent's sessions, with that session's own rules",
            }),
          }),
          success: described(OperatorToolPrompt.ToolPrompt, "The tool prompt"),
          error: ApiToolPromptNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.toolPrompt.get",
            summary: "An agent's tool prompt",
            description:
              "The tools an agent's request sends with a model, each with its description and schema as sent, the version of its description, its size and the rules for its permission, and the tools not sent with the reason. Built live from the current settings.",
          }),
        ),
        HttpApiEndpoint.post("draft", OperatorToolPromptPaths.draft, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            ...Context,
            agentRules: Schema.optional(PermissionV1.Ruleset).annotate({
              description: "Unsaved rules in place of the agent's own",
            }),
            sessionID: Schema.optional(Schema.String),
            sessionRules: Schema.optional(PermissionV1.Ruleset).annotate({
              description: "Unsaved rules in place of the session's own",
            }),
          }),
          success: described(OperatorToolPrompt.Drafted, "The tool prompt with the draft rules, and its diff"),
          error: ApiToolPromptNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.toolPrompt.draft",
            summary: "Preview a tool prompt with unsaved rules",
            description:
              "The tool prompt built from unsaved permission rules (the agent's own, or a session's), and what changes against the saved rules: tools added or removed (with the rule that caused it), descriptions changed, and the total size.",
          }),
        ),
        HttpApiEndpoint.get("last", OperatorToolPromptPaths.last, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorCalls.Last, "The agent's last request's tools"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.toolPrompt.last",
            summary: "The tools an agent last sent",
            description:
              "The `tools` value of this agent's most recent recorded request in this project, byte for byte, with its time, model, format and session; or not captured yet.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator tool prompt", description: "Tool prompt routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator tool prompt HttpApi",
      version: "0.0.1",
      description: "Tool prompt routes.",
    }),
  )
