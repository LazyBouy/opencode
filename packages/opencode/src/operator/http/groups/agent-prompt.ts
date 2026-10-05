import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { ApiProfileInvalidError, ApiProfileNotFoundError } from "./namespaces"

// An agent is a project and a name: these routes act on the agent of this request's project.
export const OperatorAgentPromptPaths = {
  agent: "/operator/agent-prompt/:name",
} as const

export const OperatorAgentPromptApi = HttpApi.make("operator-agent-prompt")
  .add(
    HttpApiGroup.make("operatorAgentPrompt")
      .add(
        HttpApiEndpoint.get("get", OperatorAgentPromptPaths.agent, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorProfileStore.AgentPrompt, "The agent's prompt setting"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentPrompt.get",
            summary: "Get an agent's prompt setting",
            description:
              "The profile this project's agent uses and why (its own setting, the helper rule, the project default or the namespace default), and its override.",
          }),
        ),
        HttpApiEndpoint.put("update", OperatorAgentPromptPaths.agent, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            profile: Schema.optional(Schema.String).annotate({
              description: "A profile of the namespace; unset uses the default",
            }),
            override: Schema.optional(OperatorProfile.Override),
          }),
          success: described(OperatorProfile.AgentSetting, "The saved setting"),
          error: [ApiProfileInvalidError, ApiProfileNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentPrompt.update",
            summary: "Set an agent's prompt setting",
            description:
              "Replace the setting of this project's agent: the profile it uses (unset for the default) and an override with the group and slots it changes. Purpose cannot be overridden.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator agent prompts", description: "Agent prompt routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator agent prompt HttpApi",
      version: "0.0.1",
      description: "Agent prompt routes.",
    }),
  )
