export * as OperatorInboxRules from "./rules"

import { Schema } from "effect"
import { OperatorQueueStore } from "../queue-store"
import type { OperatorMessage } from "./message"

// A Project inbox's rules (SPEC-0023 §8.2): an ordered list, the first that matches decides. Kept with the
// project's record (project-records.ts `inbox`), copied with the project. Every part of a match is optional and
// all given parts must hold; the action delivers as addressed, forwards, sends to the manager, dead-letters, drops
// or broadcasts, and can steer or raise the priority. Compiled once per list (regular expressions included); a
// rule never names an inbox as a target, so a rule can't loop. Plain data and functions: no service imports.

export const Priority = OperatorQueueStore.Priority

export const Recipient = Schema.Struct({
  type: Schema.Literals(["agent", "group", "session", "none", "any"]).annotate({
    description: "agent, group, session: the message names one (id: which); none: it names none; any: it names one",
  }),
  id: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorInboxRecipient" })
export type Recipient = typeof Recipient.Type

export const Match = Schema.Struct({
  fromProject: Schema.optional(Schema.Union([Schema.Literal("this"), Schema.Array(Schema.String)])).annotate({
    description: "this: from this project; a list: from those projects (their ids); left out: from anywhere",
  }),
  fromAgent: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Sent by one of these agents" }),
  recipient: Schema.optional(Recipient).annotate({ description: "The recipient the message asks for" }),
  priority: Schema.optional(Priority).annotate({ description: "At least this priority" }),
  type: Schema.optional(Schema.Literals(["text", "file-location"])),
  contains: Schema.optional(Schema.String).annotate({ description: "The text contains these words (any case)" }),
  pattern: Schema.optional(Schema.String).annotate({ description: "The text matches this regular expression" }),
  correlationPrefix: Schema.optional(Schema.String).annotate({ description: "The correlation id starts with this" }),
  reply: Schema.optional(Schema.Boolean).annotate({
    description: "A reply (replyTo, or its correlation id) to a message an agent of this project sent",
  }),
}).annotate({ identifier: "OperatorInboxMatch" })
export type Match = typeof Match.Type

export const Target = Schema.Struct({
  type: Schema.Literals(["agent", "session", "group"]),
  id: Schema.String,
}).annotate({ identifier: "OperatorInboxTarget" })
export type Target = typeof Target.Type

export const ActionKind = Schema.Literals([
  "as-addressed",
  "forward",
  "manager",
  "dead-letter",
  "drop",
  "broadcast",
  "to-sender",
])
export type ActionKind = typeof ActionKind.Type

export const Action = Schema.Struct({
  kind: ActionKind.annotate({
    description:
      "as-addressed: to the recipient it names; forward: to `to`; manager: to the manager; dead-letter; drop (logged); broadcast: to every member; to-sender: to the session of the message it answers",
  }),
  to: Schema.optional(Schema.Array(Target)).annotate({ description: "forward: agents, sessions or groups here" }),
  steer: Schema.optional(Schema.Boolean).annotate({ description: "Deliver it steering (read at the next step)" }),
  priority: Schema.optional(Priority).annotate({ description: "Raise its priority to at least this" }),
}).annotate({ identifier: "OperatorInboxAction" })
export type Action = typeof Action.Type

export const Rule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  match: Match,
  action: Action,
  preset: Schema.optional(Schema.Literals(["replies", "as-addressed"])).annotate({
    description: "Made from a preset (it can be changed like any rule)",
  }),
}).annotate({ identifier: "OperatorInboxRule" })
export type Rule = typeof Rule.Type

export const Unmatched = Schema.Literals(["dead-letter", "broadcast"]).annotate({
  identifier: "OperatorInboxUnmatched",
  description:
    "What no rule matches, in a project with no manager, that names no recipient: dead-letter (kept on the Project inbox page), or broadcast (one message, and one model turn, per member)",
})
export type Unmatched = typeof Unmatched.Type

export const Settings = Schema.Struct({ unmatched: Unmatched }).annotate({ identifier: "OperatorInboxSettings" })
export type Settings = typeof Settings.Type

/** What a project keeps (with its record). */
export type Inbox = { rules: Rule[]; unmatched: Unmatched }

export const PRESETS = {
  replies: (): Rule => ({
    id: "replies",
    name: "Replies go to their sender",
    enabled: true,
    preset: "replies",
    match: { reply: true },
    action: { kind: "to-sender" },
  }),
  "as-addressed": (): Rule => ({
    id: "as-addressed",
    name: "As addressed",
    enabled: true,
    preset: "as-addressed",
    match: { recipient: { type: "any" } },
    action: { kind: "as-addressed" },
  }),
} as const

/** A new inbox: "Replies go to their sender" first, so replies across projects reach their sender (§9.2). */
export const fresh = (): Inbox => ({ rules: [PRESETS.replies()], unmatched: "dead-letter" })

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const

/** The recipient a message asks for, by kind. */
export function recipientOf(message: Pick<OperatorMessage.Message, "to">): {
  type: "agent" | "group" | "session" | "none"
  id?: string
} {
  const to = message.to
  if ((to.type === "agent" || to.type === "project-agent") && to.id) return { type: "agent", id: to.id }
  if ((to.type === "group" || to.type === "project-group") && to.id) return { type: "group", id: to.id }
  if (to.type === "session" && to.id) return { type: "session", id: to.id }
  return { type: "none" }
}

/** What's wrong with a list of rules, if anything: checked when saved. */
export function check(rules: ReadonlyArray<Rule>): string | undefined {
  const ids = new Set<string>()
  for (const rule of rules) {
    if (!rule.id.trim()) return "A rule has no id"
    if (ids.has(rule.id)) return `Two rules have the id ${rule.id}`
    ids.add(rule.id)
    if (!rule.name.trim()) return `The rule ${rule.id} has no name`
    if (rule.match.pattern !== undefined) {
      try {
        new RegExp(rule.match.pattern, "i")
      } catch (error) {
        return `The rule ${rule.name}: its pattern isn't a regular expression (${error instanceof Error ? error.message : String(error)})`
      }
    }
    if (rule.action.kind === "forward" && !rule.action.to?.length)
      return `The rule ${rule.name} forwards to nobody: name agents, sessions or groups`
    if (rule.action.to?.some((target) => !target.id.trim())) return `The rule ${rule.name} names a target without an id`
    if (rule.action.kind === "to-sender" && !rule.match.reply)
      return `The rule ${rule.name} sends to the sender of the message answered: it must match replies`
  }
  return undefined
}

/** What a rule is checked with: the message, and the message it answers when an agent of this project sent it. */
export type Subject = {
  message: Pick<OperatorMessage.Message, "from" | "to" | "priority" | "body" | "correlationID">
  /** This project's unique id. */
  project: string
  /** The message it answers, sent by an agent of this project (for `reply`). */
  original?: Pick<OperatorMessage.Message, "id" | "from">
}

type Compiled = { rule: Rule; test: (subject: Subject) => boolean }

function compileOne(rule: Rule): Compiled {
  const match = rule.match
  const pattern = match.pattern !== undefined ? new RegExp(match.pattern, "i") : undefined
  const contains = match.contains?.trim().toLowerCase()
  return {
    rule,
    test: ({ message, project, original }) => {
      if (match.fromProject !== undefined) {
        const from = message.from.project ?? project
        if (match.fromProject === "this" ? from !== project : !match.fromProject.includes(from)) return false
      }
      if (match.fromAgent?.length && !(message.from.agent && match.fromAgent.includes(message.from.agent))) return false
      if (match.recipient) {
        const asked = recipientOf(message)
        if (match.recipient.type === "any") {
          if (asked.type === "none") return false
        } else if (asked.type !== match.recipient.type) return false
        else if (match.recipient.id && asked.id !== match.recipient.id) return false
      }
      if (match.priority && RANK[message.priority] < RANK[match.priority]) return false
      if (match.type && message.body.type !== match.type) return false
      if (contains && !message.body.text.toLowerCase().includes(contains)) return false
      if (pattern && !pattern.test(message.body.text)) return false
      if (match.correlationPrefix && !message.correlationID.startsWith(match.correlationPrefix)) return false
      if (match.reply && !original) return false
      return true
    },
  }
}

// Compiled lists, by their content (the rules change only when saved).
const compiled = new Map<string, Compiled[]>()
export function compile(rules: ReadonlyArray<Rule>): Compiled[] {
  const key = JSON.stringify(rules)
  const found = compiled.get(key)
  if (found) return found
  const list = rules.filter((rule) => rule.enabled).map(compileOne)
  if (compiled.size > 200) compiled.clear()
  compiled.set(key, list)
  return list
}

/** The first enabled rule that matches, if one does. */
export function first(rules: ReadonlyArray<Rule>, subject: Subject): Rule | undefined {
  return compile(rules).find((entry) => entry.test(subject))?.rule
}

/** A priority raised to at least `floor`. */
export const raise = (priority: OperatorQueueStore.Priority, floor?: OperatorQueueStore.Priority) =>
  floor && RANK[floor] > RANK[priority] ? floor : priority

/** A rule in one line, for the manager's `ping rule list` and the Project inbox page. */
export function describe(rule: Rule): string {
  const match = rule.match
  const parts = [
    match.reply ? "a reply to this project's agents" : undefined,
    match.fromProject === "this"
      ? "from this project"
      : match.fromProject
        ? `from ${match.fromProject.join(", ")}`
        : undefined,
    match.fromAgent?.length ? `sent by ${match.fromAgent.join(", ")}` : undefined,
    match.recipient
      ? match.recipient.type === "none"
        ? "naming no recipient"
        : match.recipient.type === "any"
          ? "naming a recipient"
          : `for ${match.recipient.type} ${match.recipient.id ?? "any"}`
      : undefined,
    match.priority ? `priority ${match.priority} or higher` : undefined,
    match.type ? match.type : undefined,
    match.contains ? `containing "${match.contains}"` : undefined,
    match.pattern ? `matching /${match.pattern}/` : undefined,
    match.correlationPrefix ? `correlation ${match.correlationPrefix}…` : undefined,
  ].filter(Boolean)
  const action = rule.action
  const then = [
    action.kind === "forward"
      ? `forward to ${(action.to ?? []).map((target) => `${target.type} ${target.id}`).join(", ")}`
      : action.kind,
    action.steer ? "steering" : undefined,
    action.priority ? `at least ${action.priority}` : undefined,
  ].filter(Boolean)
  return `[${rule.enabled ? "on" : "off"}] ${rule.name} (${rule.id}): ${parts.length ? parts.join(", ") : "every message"} → ${then.join(", ")}`
}
