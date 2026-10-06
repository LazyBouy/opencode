import { OperatorAgentSessions } from "@/operator/agent-sessions"
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
export const OperatorAgentSessionPaths = {
  state: "/operator/agent/:name/session-state",
  main: "/operator/agent/:name/main",
  target: "/operator/agent/:name/target",
  mainSession: "/operator/main-session",
} as const

export class ApiAgentSessionsNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorAgentSessionsNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorAgentSessionsNotFoundError")(
  { name: Schema.Literal("OperatorAgentSessionsNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export const MainSession = Schema.Struct({
  agent: Schema.String,
  session: OperatorAgentSessions.SessionRef,
  created: Schema.Boolean.annotate({ description: "Made just now (the agent had no main session)" }),
}).annotate({ identifier: "OperatorMainSession" })

export const OperatorAgentSessionApi = HttpApi.make("operator-agent-sessions")
  .add(
    HttpApiGroup.make("operatorAgentSessions")
      .add(
        HttpApiEndpoint.get("state", OperatorAgentSessionPaths.state, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorAgentSessions.State, "The agent's main and active sessions"),
          error: ApiAgentSessionsNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentSessions.state",
            summary: "An agent's main and active sessions",
            description:
              "The agent's main session in this project (kept), and its active session (the most recently used one that is not archived or a subagent's).",
          }),
        ),
        HttpApiEndpoint.put("setMain", OperatorAgentSessionPaths.main, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            sessionID: Schema.String.annotate({ description: "The session; an empty string: no main session" }),
          }),
          success: described(OperatorAgentSessions.State, "The agent's main and active sessions"),
          error: ApiAgentSessionsNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentSessions.setMain",
            summary: "Set an agent's main session",
            description: "Make one of the project's sessions the agent's main session, or (empty) clear it.",
          }),
        ),
        HttpApiEndpoint.put("setTarget", OperatorAgentSessionPaths.target, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ target: OperatorAgentSessions.DefaultTarget }),
          success: described(OperatorAgentSessions.State, "The agent's main and active sessions"),
          error: ApiAgentSessionsNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentSessions.setTarget",
            summary: "Set where an agent's messages go",
            description:
              "Where messages queued for the agent go when they name no session: its main session or its active session.",
          }),
        ),
        HttpApiEndpoint.post("mainSession", OperatorAgentSessionPaths.mainSession, {
          // The agent is a query parameter, so the request needs no body.
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            agent: Schema.optional(Schema.String).annotate({
              description: "The agent; the default agent when left out",
            }),
          }),
          success: described(MainSession, "The agent's main session"),
          error: ApiAgentSessionsNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.agentSessions.mainSession",
            summary: "Open an agent's main session",
            description:
              "The agent's main session in this project (the default agent's when none is named), made in its home folder and kept when it has none.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator agent sessions", description: "Agent session routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator agent sessions HttpApi",
      version: "0.0.1",
      description: "Agent session routes.",
    }),
  )
