import { OperatorCalls } from "@/operator/calls"
import { OperatorCallView } from "@/operator/call-view"
import { OperatorTokenizers } from "@/operator/tokenizers"
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

// A session's recorded model calls, for the Transcript view (operator/calls.ts). Under the API's
// /operator/session/:id, never the app's /operator/sessions pages.
export const OperatorCallPaths = {
  calls: "/operator/session/:sessionID/calls",
  export: "/operator/session/:sessionID/calls/export",
  call: "/operator/session/:sessionID/call/:callID",
  raw: "/operator/session/:sessionID/call/:callID/raw",
  recount: "/operator/session/:sessionID/calls/recount",
  tokenizers: "/operator/tokenizers",
} as const

export class ApiCallNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorCallNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorCallNotFoundError")(
  { name: Schema.Literal("OperatorCallNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

const params = { sessionID: Schema.String }

export const OperatorCallApi = HttpApi.make("operator-calls")
  .add(
    HttpApiGroup.make("operatorCalls")
      .add(
        HttpApiEndpoint.get("list", OperatorCallPaths.calls, {
          params,
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            after: Schema.optional(Schema.String).annotate({ description: "Only calls after this one" }),
            limit: Schema.optional(Schema.NumberFromString),
            kind: Schema.optional(Schema.String).annotate({
              description: "Comma-separated: agent, title, compaction, summary, other, unlinked, errors",
            }),
            search: Schema.optional(Schema.String).annotate({
              description: "Only calls whose request body or response contains this text (case does not matter)",
            }),
          }),
          success: described(OperatorCallView.List, "The session's recorded calls"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.call.list",
            summary: "List a session's model calls",
            description:
              "Every recorded model call of the session, in order: its kind (agent step, title, compaction, …), exchange and step, timing, usage and cost, whether its system text and tools are the same as an earlier call's, and how many of its messages are new; the session's exchanges (marking those not recorded); and totals.",
          }),
        ),
        HttpApiEndpoint.get("export", OperatorCallPaths.export, {
          params,
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, format: Schema.Literals(["md", "json"]) }),
          success: described(OperatorCalls.Export, "The transcript"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.call.export",
            summary: "Export a session's transcript",
            description: "The session's model calls as Markdown, or as JSON with each request's exact body.",
          }),
        ),
        HttpApiEndpoint.get("get", OperatorCallPaths.call, {
          params: { ...params, callID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OperatorCallView.Detail, "One call"),
          error: ApiCallNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.call.get",
            summary: "A model call",
            description:
              "One call: what it sent (system text and tools against earlier calls, each message marked new or seen and with what the chat does not show), its parameters, and what came back (reasoning, text and tool calls in order).",
          }),
        ),
        HttpApiEndpoint.get("raw", OperatorCallPaths.raw, {
          params: { ...params, callID: Schema.String },
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, part: Schema.Literals(["request", "response"]) }),
          success: described(OperatorCalls.Raw, "The exact request body, or the response"),
          error: ApiCallNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.call.raw",
            summary: "A model call's raw request or response",
            description:
              "The request body exactly as sent (rebuilt byte for byte), or the assembled response (the raw stream for formats that are not read).",
          }),
        ),
        HttpApiEndpoint.post("recount", OperatorCallPaths.recount, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "The counts are made again when next read"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.call.recount",
            summary: "Count a session's tokens again",
            description:
              "Reloads the tokenizers and clears the session's stored token counts, so each call's accounting is made again (after a tokenizer is added).",
          }),
        ),
        HttpApiEndpoint.get("tokenizers", OperatorCallPaths.tokenizers, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorTokenizers.List, "The tokenizers that count tokens per model"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.call.tokenizers",
            summary: "List tokenizers",
            description:
              "The tokenizers loaded from the tokenizer folder, the models each counts for, and modules that failed to load. Without one, the Transcript estimates (characters ÷ 4).",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator calls", description: "Recorded model calls." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator calls HttpApi",
      version: "0.0.1",
      description: "Recorded model calls.",
    }),
  )
