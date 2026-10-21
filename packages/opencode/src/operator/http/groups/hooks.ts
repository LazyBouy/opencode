import { OperatorHooks } from "@/operator/hooks/hooks"
import { OperatorHookEvents } from "@/operator/hooks/events"
import { OperatorHookRuns } from "@/operator/hooks/runs"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Hooks (SPEC-0022 §11). Under /operator/hook: the console's hooks live on the Capabilities page, and a GET
// route must not share a page's path.
export const OperatorHookPaths = {
  list: "/operator/hook",
  settings: "/operator/hook/settings",
  runs: "/operator/hook/runs",
  run: "/operator/hook/runs/:id",
  events: "/operator/hook/events",
} as const

export class ApiHookInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorHookInvalidError"
  readonly data: { readonly message: string }
}>("OperatorHookInvalidError")(
  { name: Schema.Literal("OperatorHookInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export class ApiHookNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorHookNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorHookNotFoundError")(
  { name: Schema.Literal("OperatorHookNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

export const HookEvent = Schema.Struct({
  name: Schema.Literals(OperatorHookEvents.NAMES),
  kind: Schema.Literals(["blocking", "watch"]).annotate({
    description: "blocking: the session waits for the answer; watch: it goes on",
  }),
  fields: Schema.Array(Schema.Literals(OperatorHookEvents.FIELDS)).annotate({
    description: "Answer fields the event uses; others are ignored",
  }),
  subject: Schema.optional(Schema.Literals(["tool", "permission", "agent"])).annotate({
    description: "What `match` is checked against",
  }),
  group: Schema.Literals(["session", "prompt", "step", "tool", "permission", "compaction", "watch"]),
}).annotate({ identifier: "OperatorHookEvent" })

const RunsQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  session: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  hook: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  test: Schema.optional(Schema.Literals(["true", "false"])),
  limit: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["project", "all"])).annotate({
    description: "project (default): runs in this project; all: every project's",
  }),
})

export const OperatorHookApi = HttpApi.make("operator-hooks")
  .add(
    HttpApiGroup.make("operatorHooks")
      .add(
        HttpApiEndpoint.get("list", OperatorHookPaths.list, {
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            agent: Schema.optional(Schema.String).annotate({ description: "Include this agent's own hooks" }),
          }),
          success: described(OperatorHooks.Effective, "The hooks in force"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.list",
            summary: "The hooks in force for a project or agent",
            description:
              "Every level's hooks (Global, namespace, project, and the agent's own), each with its level, state (on, off below, disabled, invalid), lock and problems, in run order.",
          }),
        ),
        HttpApiEndpoint.get("settings", OperatorHookPaths.settings, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorHooks.Settings, "Settings → Hooks"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.settings",
            summary: "Settings → Hooks",
            description: "The default timeout for hooks without their own, and Pause all hooks. Server-wide.",
          }),
        ),
        HttpApiEndpoint.put("saveSettings", OperatorHookPaths.settings, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            timeout: Schema.optional(Schema.Finite).annotate({ description: "Seconds, 0.1 to 600" }),
            paused: Schema.optional(Schema.Boolean),
          }),
          success: described(OperatorHooks.Settings, "The settings after the save"),
          error: ApiHookInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.saveSettings",
            summary: "Change Settings → Hooks",
            description: "Sets the default timeout or Pause all hooks; what isn't given stays.",
          }),
        ),
        HttpApiEndpoint.get("runs", OperatorHookPaths.runs, {
          query: RunsQuery,
          success: described(
            Schema.Struct({ runs: Schema.Array(OperatorHookRuns.Run), total: Schema.Finite }),
            "Runs, newest first",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.runs",
            summary: "Hook runs",
            description:
              "The run log, newest first: one session's runs, or a project's (or every project's), filtered by agent, hook, event, outcome or Test runs; paged with limit and offset.",
          }),
        ),
        HttpApiEndpoint.get("run", OperatorHookPaths.run, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorHookRuns.Run, "One run"),
          error: ApiHookNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.run",
            summary: "One hook run",
            description: "Everything the run log keeps of one run.",
          }),
        ),
        HttpApiEndpoint.get("events", OperatorHookPaths.events, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(HookEvent), "The events"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.hook.events",
            summary: "The events a hook can be attached to",
            description:
              "Each event, whether the session waits for the answer, the answer fields it uses, and what `match` checks.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator hooks", description: "Hook routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator hooks HttpApi",
      version: "0.0.1",
      description: "Hooks: scripts that run at points in a session.",
    }),
  )
