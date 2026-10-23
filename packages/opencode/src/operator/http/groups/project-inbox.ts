import { OperatorProjectInbox } from "@/operator/messaging/inbox"
import { OperatorMessage } from "@/operator/messaging/message"
import { OperatorInboxRules } from "@/operator/messaging/rules"
import { OperatorMessagingSettings } from "@/operator/messaging/settings"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// The Project inbox and the message log (SPEC-0023 §11). A project is named by its unique id (project-ids.ts).
// "Project inbox" everywhere, to keep clear of the Permission Inbox (/operator/inbox). The console's page is
// /operator/project-inbox, so no GET route here is that path.
export const OperatorProjectInboxPaths = {
  enter: "/operator/project-inbox/:project",
  messages: "/operator/project-inbox/:project/messages",
  rules: "/operator/project-inbox/:project/rules",
  test: "/operator/project-inbox/:project/rules/test",
  settings: "/operator/project-inbox/:project/settings",
  message: "/operator/messages/:id",
  forward: "/operator/messages/:id/forward",
  drop: "/operator/messages/:id/drop",
  routeAgain: "/operator/messages/:id/route-again",
  broadcast: "/operator/messages/:id/broadcast",
  status: "/operator/messaging/status",
  messagingSettings: "/operator/messaging/settings",
  counts: "/operator/messaging/counts",
  conversation: "/operator/conversation/:correlationID",
} as const

export class ApiProjectInboxInvalidError extends Schema.ErrorClass<{
  readonly name: "OperatorProjectInboxInvalidError"
  readonly data: { readonly message: string }
}>("OperatorProjectInboxInvalidError")(
  { name: Schema.Literal("OperatorProjectInboxInvalidError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 400 },
) {}

export class ApiProjectInboxNotFoundError extends Schema.ErrorClass<{
  readonly name: "OperatorProjectInboxNotFoundError"
  readonly data: { readonly message: string }
}>("OperatorProjectInboxNotFoundError")(
  { name: Schema.Literal("OperatorProjectInboxNotFoundError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 404 },
) {}

const ProjectParam = {
  project: Schema.String.annotate({ description: "The project's unique id" }),
}
const IdParam = { id: Schema.String.annotate({ description: "The message's id (msg_…)" }) }
const errors = [ApiProjectInboxInvalidError, ApiProjectInboxNotFoundError]

export const InboxView = Schema.Struct({
  rules: Schema.Array(OperatorInboxRules.Rule),
  unmatched: OperatorInboxRules.Unmatched,
}).annotate({ identifier: "OperatorProjectInbox" })

export const InboxSettings = Schema.Struct({
  unmatched: OperatorInboxRules.Unmatched,
  manager: Schema.optional(Schema.String).annotate({ description: "The project's manager (its record's)" }),
  transport: Schema.Literals(["sqlite"]).annotate({
    description: "How messages reach the inbox: sqlite (routed as they arrive); RabbitMQ when configured (later)",
  }),
}).annotate({ identifier: "OperatorProjectInboxSettings" })

export const MessagingStatus = Schema.Struct({
  memoryLane: Schema.Struct({
    backend: Schema.Literals(["in-process"]).annotate({ description: "in-process (the server's memory); Redis later" }),
    held: Schema.Finite.annotate({ description: "Messages held now for running sessions" }),
    cap: Schema.Finite.annotate({ description: "At most this many a session" }),
  }),
  inboxTransport: Schema.Literals(["sqlite"]),
  rabbitmq: Schema.Literals(["not configured"]),
  redis: Schema.Literals(["not configured"]),
  outbox: Schema.Finite.annotate({ description: "Messages waiting to be published (RabbitMQ only)" }),
}).annotate({ identifier: "OperatorMessagingStatus" })

const Counts = Schema.Record(
  Schema.String,
  Schema.Struct({ waiting: Schema.Finite, deadLetters: Schema.Finite }).annotate({
    identifier: "OperatorProjectInboxCount",
  }),
).annotate({ identifier: "OperatorProjectInboxCounts" })

export const OperatorProjectInboxApi = HttpApi.make("operator-project-inbox")
  .add(
    HttpApiGroup.make("operatorProjectInbox")
      .add(
        HttpApiEndpoint.post("enter", OperatorProjectInboxPaths.enter, {
          params: ProjectParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            text: Schema.String,
            type: Schema.optional(Schema.Literals(["text", "file-location"])).annotate({
              description: "file-location: the text is a path, which the recipient reads only if its permissions allow",
            }),
            to: Schema.optional(OperatorInboxRules.Target).annotate({
              description: "The recipient it asks for; the rules or the manager decide",
            }),
            priority: Schema.optional(OperatorInboxRules.Priority),
            steer: Schema.optional(Schema.Boolean),
            correlationID: Schema.optional(Schema.String),
            replyTo: Schema.optional(Schema.String),
            from: Schema.optional(Schema.Literals(["user", "external"])).annotate({
              description: "user (default): you; external: an outside source, through this API",
            }),
          }),
          success: described(OperatorMessage.Message, "The message as routed"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.enter",
            summary: "Put a message into a project's inbox",
            description:
              "From the user (the Project inbox page's New message) or from outside. It's routed at once: the rules, else the manager, else as addressed, else dead letter or broadcast.",
          }),
        ),
        HttpApiEndpoint.get("messages", OperatorProjectInboxPaths.messages, {
          params: ProjectParam,
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            status: Schema.optional(OperatorMessage.Status),
            from: Schema.optional(Schema.String).annotate({
              description: "A sender's kind (user, agent, system, external) or an agent's name",
            }),
            limit: Schema.optional(Schema.String),
          }),
          success: described(Schema.Array(OperatorMessage.Message), "Newest first"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.messages",
            summary: "A project's inbox messages",
            description: "Everything that entered the project's inbox, filtered by status and sender; at most 500.",
          }),
        ),
        HttpApiEndpoint.get("rules", OperatorProjectInboxPaths.rules, {
          params: ProjectParam,
          query: WorkspaceRoutingQuery,
          success: described(InboxView, "The rules, in order, and the unmatched setting"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.rules",
            summary: "A project's inbox rules",
            description: "The ordered rules (the first that matches decides) and what happens to unmatched messages.",
          }),
        ),
        HttpApiEndpoint.put("setRules", OperatorProjectInboxPaths.rules, {
          params: ProjectParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ rules: Schema.Array(OperatorInboxRules.Rule) }),
          success: described(InboxView, "As saved"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.setRules",
            summary: "Save a project's inbox rules",
            description:
              "The whole ordered list. Refused when a rule has no name, a regular expression doesn't compile or a forward names nobody.",
          }),
        ),
        HttpApiEndpoint.post("test", OperatorProjectInboxPaths.test, {
          params: ProjectParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            sample: OperatorProjectInbox.Sample,
            rules: Schema.optional(Schema.Array(OperatorInboxRules.Rule)).annotate({
              description: "Rules not saved yet (default: the saved ones)",
            }),
          }),
          success: described(OperatorProjectInbox.TestResult, "What would take it"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.test",
            summary: "Test the rules on a sample message",
            description:
              "Which rule would take it, or the manager, as addressed, broadcast or dead letter. Nothing is sent.",
          }),
        ),
        HttpApiEndpoint.get("settings", OperatorProjectInboxPaths.settings, {
          params: ProjectParam,
          query: WorkspaceRoutingQuery,
          success: described(InboxSettings, "The inbox's settings"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.settings",
            summary: "A project's inbox settings",
            description: "What happens to unmatched messages, the manager, and the transport.",
          }),
        ),
        HttpApiEndpoint.put("setSettings", OperatorProjectInboxPaths.settings, {
          params: ProjectParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ unmatched: OperatorInboxRules.Unmatched }),
          success: described(InboxSettings, "As saved"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.projectInbox.setSettings",
            summary: "Change what happens to unmatched messages",
            description: "Dead letter (the default) or broadcast: one message, and one model turn, per member.",
          }),
        ),
        HttpApiEndpoint.get("message", OperatorProjectInboxPaths.message, {
          params: IdParam,
          query: WorkspaceRoutingQuery,
          success: described(OperatorMessage.Message, "The message, with its trail"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.message.get",
            summary: "A message's record",
            description: "Any message in the message log: who sent it, what it asked for, where it went and when.",
          }),
        ),
        HttpApiEndpoint.delete("remove", OperatorProjectInboxPaths.message, {
          params: IdParam,
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Moved to Trash"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.message.remove",
            summary: "Delete a dead letter",
            description: "Moves a dead letter (or a dropped message) to Trash; restoring it puts it back.",
          }),
        ),
        HttpApiEndpoint.post("forward", OperatorProjectInboxPaths.forward, {
          params: IdParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ to: Schema.Array(OperatorInboxRules.Target) }),
          success: described(OperatorMessage.Message, "As routed"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.message.forward",
            summary: "Forward a waiting message or a dead letter",
            description: "To agents, sessions or groups of its project; its sender and correlation id stay.",
          }),
        ),
        HttpApiEndpoint.post("drop", OperatorProjectInboxPaths.drop, {
          params: IdParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ reason: Schema.optional(Schema.String) }),
          success: described(OperatorMessage.Message, "Dropped"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.message.drop",
            summary: "Drop a waiting message or a dead letter",
            description: "It stays in the log, dropped, with the reason.",
          }),
        ),
        HttpApiEndpoint.post("routeAgain", OperatorProjectInboxPaths.routeAgain, {
          params: IdParam,
          query: WorkspaceRoutingQuery,
          success: described(OperatorMessage.Message, "As routed now"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.message.routeAgain",
            summary: "Route a message again",
            description:
              "A dead letter (or a waiting message) through the inbox's routing again, e.g. after adding a rule.",
          }),
        ),
        HttpApiEndpoint.post("broadcast", OperatorProjectInboxPaths.broadcast, {
          params: IdParam,
          query: WorkspaceRoutingQuery,
          success: described(OperatorMessage.Message, "Broadcast"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.message.broadcast",
            summary: "Broadcast a dead letter",
            description:
              "One message per member of its project (at most 50): each starts a model turn for an idle member.",
          }),
        ),
        HttpApiEndpoint.get("status", OperatorProjectInboxPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(MessagingStatus, "Messaging's state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.messaging.status",
            summary: "Messaging's state",
            description:
              "The memory lane's backend and what it holds, the inbox transport, RabbitMQ, Redis and the outbox.",
          }),
        ),
        HttpApiEndpoint.get("messagingSettings", OperatorProjectInboxPaths.messagingSettings, {
          query: WorkspaceRoutingQuery,
          success: described(OperatorMessagingSettings.Settings, "Settings → Messaging"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.messaging.settings",
            summary: "Settings → Messaging",
            description: "The rate limits per sending agent and the default wait of a ping that waits. Server-wide.",
          }),
        ),
        HttpApiEndpoint.put("setMessagingSettings", OperatorProjectInboxPaths.messagingSettings, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            perMinute: Schema.optional(Schema.Finite),
            perHour: Schema.optional(Schema.Finite),
            wait: Schema.optional(Schema.Finite),
          }),
          success: described(OperatorMessagingSettings.Settings, "The settings after the save"),
          error: ApiProjectInboxInvalidError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.messaging.setSettings",
            summary: "Change Settings → Messaging",
            description: "What isn't given stays.",
          }),
        ),
        HttpApiEndpoint.get("conversation", OperatorProjectInboxPaths.conversation, {
          params: { correlationID: Schema.String.annotate({ description: "The correlation id" }) },
          query: WorkspaceRoutingQuery,
          success: described(OperatorProjectInbox.Conversation, "Oldest first, with the sessions involved"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.conversation.get",
            summary: "A conversation",
            description:
              "Every message sharing a correlation id (a message, its replies, what an inbox routed), oldest first, and the sessions they went between.",
          }),
        ),
        HttpApiEndpoint.get("counts", OperatorProjectInboxPaths.counts, {
          query: WorkspaceRoutingQuery,
          success: described(Counts, "By project id"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "operator.messaging.counts",
            summary: "Waiting and dead-letter counts",
            description:
              "Per project: messages waiting for the manager, and dead letters (the Projects list's columns).",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "operator project inbox", description: "Project inbox routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode operator project inbox HttpApi",
      version: "0.0.1",
      description: "Messaging: the Project inbox, its rules, and the message log.",
    }),
  )
