import { OperatorAgents } from "@/operator/agents"
import { OperatorModels } from "@/operator/models"
import { OperatorConfig } from "@/operator/config"
import { OperatorTools } from "@/operator/tools"
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
import { ApiProjectConfigCopyError, ConfirmCopyField } from "./project-config"

export const OperatorProjectPaths = {
  agents: "/operator/agent",
  agent: "/operator/agent/:name",
  tools: "/operator/tool",
  models: "/operator/model",
} as const

const ScopeQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: OperatorConfig.Scope, ...ConfirmCopyField })
const AgentWritten = Schema.Struct({ path: Schema.String }).annotate({ identifier: "OperatorAgentWritten" })

const agentError = <Name extends string, Status extends number>(name: Name, status: Status) =>
  Schema.ErrorClass<{ readonly name: Name; readonly data: { readonly message: string } }>(name)(
    { name: Schema.Literal(name), data: Schema.Struct({ message: Schema.String }) },
    { httpApiStatus: status },
  )
export class ApiAgentNotFoundError extends agentError("OperatorAgentNotFoundError", 404) {}
export class ApiAgentConflictError extends agentError("OperatorAgentConflictError", 409) {}
export class ApiAgentInvalidError extends agentError("OperatorAgentInvalidError", 400) {}

export const OperatorProjectApi = HttpApi.make("operator-project")
  .add(
    HttpApiGroup.make("operatorProject")
      .add(
        HttpApiEndpoint.get("agents", OperatorProjectPaths.agents, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(OperatorAgents.Info), "Agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agent.list",
            summary: "List agents with their source",
            description:
              "Every agent in this project, including hidden ones, with where it is defined (built-in, config or a markdown file) and how many of the project's sessions use it.",
          }),
        ),
        HttpApiEndpoint.post("agentCreate", OperatorProjectPaths.agents, {
          query: ScopeQuery,
          payload: Schema.Struct({
            name: Schema.String,
            format: Schema.optional(OperatorAgents.Format).annotate({
              description:
                "file (default): an agent file, `agents/<name>.md`; config: `agent.<name>` in the config file",
            }),
            ...OperatorAgents.Patch.fields,
          }),
          success: described(AgentWritten, "The agent file or config file that was written"),
          error: [ApiAgentNotFoundError, ApiAgentConflictError, ApiAgentInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agent.create",
            summary: "Create an agent",
            description:
              "Write a new agent at the global or project scope: a markdown file in the `agents` folder, or `agent.<name>` in the config file. The project reloads so the agent can be used.",
          }),
        ),
        HttpApiEndpoint.patch("agentUpdate", OperatorProjectPaths.agent, {
          params: { name: Schema.String },
          query: ScopeQuery,
          payload: OperatorAgents.Patch,
          success: described(AgentWritten, "The file that was written"),
          error: [ApiAgentNotFoundError, ApiAgentConflictError, ApiAgentInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agent.update",
            summary: "Edit an agent",
            description:
              "Change an agent's settings. A markdown agent's own file is edited; built-in and config agents get `agent.<name>` settings in the global or project config. null resets a setting.",
          }),
        ),
        HttpApiEndpoint.delete("agentRemove", OperatorProjectPaths.agent, {
          params: { name: Schema.String },
          query: ScopeQuery,
          success: described(AgentWritten, "The file that was changed"),
          error: [ApiAgentNotFoundError, ApiAgentConflictError, ApiAgentInvalidError, ApiProjectConfigCopyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agent.remove",
            summary: "Delete an agent",
            description: "Delete a markdown or config agent. Built-in agents can only be turned off.",
          }),
        ),
        HttpApiEndpoint.get("tools", OperatorProjectPaths.tools, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(OperatorTools.Info), "Tools"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.tool.list",
            summary: "List tools with their origin",
            description:
              "Every tool available in this project: built-in, custom tool files, plugin tools and tools from connected MCP servers.",
          }),
        ),
        HttpApiEndpoint.get("models", OperatorProjectPaths.models, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorModels.Defaults, "The default and small model"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.model.defaults",
            summary: "Default and small model",
            description:
              "The model this project's agents use when they set none (config `model`, else the TUI's recent models, else OpenCode's own ranking), and the small model the title agent uses (config `small_model`, else OpenCode's search), each with where it is set.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator project", description: "Per-project operator routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator project HttpApi",
      version: "0.0.1",
      description: "Per-project operator routes.",
    }),
  )
