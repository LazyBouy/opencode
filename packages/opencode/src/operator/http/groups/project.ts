import { OperatorAgents } from "@/operator/agents"
import { OperatorTools } from "@/operator/tools"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const OperatorProjectPaths = {
  agents: "/operator/agent",
  tools: "/operator/tool",
} as const

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
