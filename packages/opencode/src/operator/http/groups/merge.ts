import { SessionMerge } from "@opencode-ai/schema/session-merge"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const MergePaths = {
  adapters: "/merge/adapter",
} as const

export const MergeApi = HttpApi.make("merge")
  .add(
    HttpApiGroup.make("merge")
      .add(
        HttpApiEndpoint.get("adapters", MergePaths.adapters, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SessionMerge.Adapter), "Merge adapters"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "merge.adapter.list",
            summary: "List merge adapters",
            description:
              "List the adapters `/merge` can attach (for example Claude Code), whether each is turned on, and whether its program is installed. Each call checks the installed programs again.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "merge", description: "External agent merge routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode merge HttpApi",
      version: "0.0.1",
      description: "External agent merge routes.",
    }),
  )
