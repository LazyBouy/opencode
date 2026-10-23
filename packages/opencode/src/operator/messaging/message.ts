export * as OperatorMessage from "./message"

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
  trail: Schema.Array(Step),
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
