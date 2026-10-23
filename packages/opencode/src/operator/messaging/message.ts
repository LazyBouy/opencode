export * as OperatorMessage from "./message"

import path from "path"
import { Schema } from "effect"
import { OperatorQueueStore } from "../queue-store"

// A message (SPEC-0023 §5): one thing sent, from a sender to a target, with its history. The message log
// (log.ts) keeps every one, whichever lane or inbox it went through.

export const From = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system", "external"]),
  project: Schema.optional(Schema.String).annotate({ description: "The sender's project (its unique id)" }),
  agent: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorMessageFrom" })
export type From = typeof From.Type

export const To = Schema.Struct({
  type: Schema.Literals(["session", "agent", "group", "inbox", "project-agent", "project-group", "all-projects"]),
  project: Schema.optional(Schema.String).annotate({ description: "The target project (its unique id)" }),
  id: Schema.optional(Schema.String).annotate({ description: "The session, agent or group named" }),
}).annotate({ identifier: "OperatorMessageTo" })
export type To = typeof To.Type

export const Body = Schema.Struct({
  type: Schema.Literals(["text", "file-location"]),
  text: Schema.String,
}).annotate({ identifier: "OperatorMessageBody" })
export type Body = typeof Body.Type

export const Status = Schema.Literals([
  "queued",
  "in memory",
  "delivered",
  "routed",
  "with manager",
  "dead letter",
  "dropped",
  "failed",
  "cancelled",
]).annotate({ identifier: "OperatorMessageStatus" })
export type Status = typeof Status.Type

/** One step of a message's history: queued, held in memory, moved, routed by a rule, delivered, … */
export const Step = Schema.Struct({
  at: Schema.Finite,
  kind: Schema.String,
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorMessageStep" })
export type Step = typeof Step.Type

export const Message = Schema.Struct({
  id: Schema.String,
  project: Schema.String.annotate({ description: "The source project's unique id" }),
  folder: Schema.optional(Schema.String).annotate({ description: "The source project's folder, when it was sent" }),
  from: From,
  to: To,
  body: Body,
  priority: OperatorQueueStore.Priority,
  steer: Schema.Boolean,
  correlationID: Schema.String,
  replyTo: Schema.optional(Schema.String),
  hops: Schema.Finite,
  status: Status,
  agent: Schema.optional(Schema.String).annotate({ description: "The agent it's for, when one" }),
  sessionID: Schema.optional(Schema.String).annotate({ description: "The session it's held for or went to" }),
  lane: Schema.optional(OperatorQueueStore.Lane),
  createdAt: Schema.Finite,
  deliveredAt: Schema.optional(Schema.Finite),
  inbox: Schema.optional(Schema.String).annotate({
    description: "The Project inbox it entered (that project's unique id), when it went through one",
  }),
  via: Schema.optional(Schema.String).annotate({
    description: "The Project inbox message it was delivered for (a routed copy's original)",
  }),
  routedBy: Schema.optional(Schema.String).annotate({
    description: "What routed it: a rule's name, the manager, as addressed, broadcast, or who forwarded it",
  }),
  routedTo: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Where it was routed" }),
  trail: Schema.Array(Step),
  copies: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        agent: Schema.optional(Schema.String),
        sessionID: Schema.optional(Schema.String),
        status: Status,
      }).annotate({ identifier: "OperatorMessageCopy" }),
    ),
  ).annotate({
    description: "A Project inbox message's routed copies, and the sessions they went to (its record only)",
  }),
}).annotate({ identifier: "OperatorMessage" })
export type Message = typeof Message.Type

let sequence = 0
/** `msg_…`, ascending: the id a message keeps through every lane and inbox (a queued one's queue item too). */
export const newId = () =>
  `msg_${Date.now().toString(36)}${(sequence++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`

/** A queue item's sender as a message's `from`. */
export const fromSender = (sender: OperatorQueueStore.Sender, project: string): From => ({
  kind: sender.kind,
  project: sender.project ?? project,
  ...(sender.agent ? { agent: sender.agent } : {}),
  ...(sender.sessionID ? { session: sender.sessionID } : {}),
})

/** What the part a delivered message becomes carries (`metadata.message`), for the chat views' marker. */
export type Mark = {
  id: string
  /** The agent it was for, and its project's folder: where its record is (the agent's queue). */
  agent: string
  folder: string
  from: From
  correlationID: string
  replyTo?: string
  /** The Project inbox message it was routed from. */
  via?: string
  priority: OperatorQueueStore.Priority
}

const senderName = (sender: OperatorQueueStore.Sender) =>
  sender.kind === "agent" ? (sender.agent ?? "an agent") : sender.kind === "system" ? "the system" : "outside"

/**
 * What a session reads for a queued message (§5). The user's own words as they are; anyone else's headed with who
 * sent it and from which session, for example "Message from researcher (project web, session ses_…) · high ·
 * correlation c_19 · id msg_…:", so the recipient can answer it (`ping send` with `replyTo`) or write to that session.
 * The part carries the mark.
 */
export function delivered(item: OperatorQueueStore.Item): { text: string; metadata?: { message: Mark } } {
  if (item.sender.kind === "user") return { text: item.text }
  const correlationID = item.correlationID ?? item.id
  const head = [
    `${item.replyTo ? "Reply" : "Message"} from ${senderName(item.sender)} (project ${path.basename(item.project)}${item.sender.sessionID ? `, session ${item.sender.sessionID}` : ""})`,
    ...(item.priority === "normal" ? [] : [item.priority]),
    `correlation ${correlationID}`,
    `id ${item.id}`,
    ...(item.replyTo ? [`answers ${item.replyTo}`] : []),
    // The manager routes what no rule did (§8.3).
    ...(item.via?.manager ? [`no rule routed it: route it with ping forward or drop, messageID ${item.via.id}`] : []),
  ].join(" · ")
  return {
    text: `${head}:\n${item.text}`,
    metadata: {
      message: {
        id: item.id,
        agent: item.agent,
        folder: item.project,
        from: fromSender(item.sender, item.sender.project ?? item.project),
        correlationID,
        ...(item.replyTo ? { replyTo: item.replyTo } : {}),
        ...(item.via ? { via: item.via.id } : {}),
        priority: item.priority,
      },
    },
  }
}
