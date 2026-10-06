import { OperatorQueue } from "@/operator/queue"
import { OperatorQueueStore } from "@/operator/queue-store"
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

export const OperatorQueuePaths = {
  agent: "/operator/agent/:name/queue",
  project: "/operator/queue",
  item: "/operator/queue/:id",
} as const

export class ApiQueueNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorQueueNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorQueueNotFoundError")(
  { name: Schema.Literal("OperatorQueueNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export class ApiQueueInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorQueueInvalidError"
  readonly data: { readonly message: string }
}>("OperatorQueueInvalidError")(
  { name: Schema.Literal("OperatorQueueInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

const listQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  status: Schema.optional(OperatorQueueStore.Status),
  limit: Schema.optional(Schema.NumberFromString),
})
const Items = Schema.Array(OperatorQueueStore.Item)

export const OperatorQueueApi = HttpApi.make("operator-queue")
  .add(
    HttpApiGroup.make("operatorQueue")
      .add(
        HttpApiEndpoint.post("send", OperatorQueuePaths.agent, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: OperatorQueue.SendInput,
          success: described(OperatorQueueStore.Item, "The queued message"),
          error: [ApiQueueNotFoundError, ApiQueueInvalidError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.queue.send",
            summary: "Queue a message for an agent",
            description:
              "Queue a message for one of the project's agents. It goes to the session it names, else to the agent's main or active session (the agent's default), when that session is idle; a steering message goes in at once, even into a running session.",
          }),
        ),
        HttpApiEndpoint.get("agent", OperatorQueuePaths.agent, {
          params: { name: Schema.String },
          query: listQuery,
          success: described(Items, "The agent's messages"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.queue.agent",
            summary: "An agent's queued messages",
            description:
              "The agent's messages in this project: queued ones in delivery order (priority, then oldest first), the others newest first.",
          }),
        ),
        HttpApiEndpoint.get("list", OperatorQueuePaths.project, {
          query: listQuery,
          success: described(Items, "The project's messages"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.queue.list",
            summary: "The project's queued messages",
            description: "Every agent's messages in this project.",
          }),
        ),
        HttpApiEndpoint.delete("cancel", OperatorQueuePaths.item, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorQueueStore.Item, "The cancelled message"),
          error: [ApiQueueNotFoundError, ApiQueueInvalidError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.queue.cancel",
            summary: "Cancel a queued message",
            description: "Cancel a message that is still queued.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator queue", description: "Agent input queue routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator queue HttpApi",
      version: "0.0.1",
      description: "Agent input queue routes.",
    }),
  )
