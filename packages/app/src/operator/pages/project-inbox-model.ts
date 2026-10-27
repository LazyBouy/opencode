import type {
  OperatorInboxAction,
  OperatorInboxMatch,
  OperatorInboxRule,
  OperatorInboxTarget,
  OperatorMessage,
  OperatorQueuePriority,
} from "@opencode-ai/sdk/v2/client"

// The Project inbox page's plain parts (SPEC-0023 §10.1): its tabs, how a message's sender and recipient read,
// the rule form's draft and back, and reordering. Kept free of components so they're tested on their own.

export const TABS = ["messages", "waiting", "dead", "rules", "settings"] as const
export type Tab = (typeof TABS)[number]
export const tabOf = (value: string | undefined): Tab => (TABS.includes(value as Tab) ? (value as Tab) : "messages")
/** The status a tab lists (Messages lists all). */
export const STATUS_OF: Partial<Record<Tab, OperatorMessage["status"]>> = {
  waiting: "with manager",
  dead: "dead letter",
}

export const PRIORITIES: OperatorQueuePriority[] = ["low", "normal", "high", "urgent"]
export const ACTIONS: OperatorInboxAction["kind"][] = [
  "as-addressed",
  "forward",
  "manager",
  "dead-letter",
  "drop",
  "broadcast",
  "to-sender",
]
export const TARGET_TYPES: OperatorInboxTarget["type"][] = ["agent", "group", "session"]

/** A status as a string key's last part: `dead letter` → `dead-letter`. */
export const statusSlug = (status: string) => status.replace(/ /g, "-")

/** Who sent a message, in words the page fills in. */
export function senderOf(from: OperatorMessage["from"], here: string | undefined) {
  if (from.kind === "agent")
    return {
      kind: from.project && from.project !== here ? "otherProject" : "agent",
      agent: from.agent ?? "?",
      project: from.project ?? "",
    }
  return { kind: from.kind, agent: "", project: "" } as const
}

/** What a message asked for. */
export function recipientText(to: OperatorMessage["to"]) {
  if (to.type === "inbox" || to.type === "all-projects" || !to.id) return undefined
  const kind = to.type === "project-agent" ? "agent" : to.type === "project-group" ? "group" : to.type
  return `${kind} ${to.id}`
}

export function move<T>(list: ReadonlyArray<T>, from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** Whether replies still find their sender (the warning on the Rules tab). */
export const hasReplies = (rules: ReadonlyArray<OperatorInboxRule>) =>
  rules.some((rule) => rule.enabled && rule.match.reply && rule.action.kind === "to-sender")

export function newRuleId(rules: ReadonlyArray<OperatorInboxRule>) {
  const ids = new Set(rules.map((rule) => rule.id))
  for (let n = rules.length + 1; ; n++) if (!ids.has(`r${n}`)) return `r${n}`
}

/** The rule form's fields: a rule's parts as the form edits them. */
export type Draft = {
  name: string
  enabled: boolean
  fromProject: "any" | "this" | "list"
  fromProjects: string
  fromAgents: string
  fromSessions: string
  recipient: "" | "agent" | "group" | "session" | "none" | "any"
  recipientId: string
  priority: "" | OperatorQueuePriority
  type: "" | "text" | "file-location"
  contains: string
  pattern: string
  correlationPrefix: string
  reply: boolean
  action: OperatorInboxAction["kind"]
  to: OperatorInboxTarget[]
  steer: boolean
  raise: "" | OperatorQueuePriority
}

const words = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

export function draftOf(rule?: OperatorInboxRule): Draft {
  const match = rule?.match ?? {}
  const fromProject = match.fromProject
  return {
    name: rule?.name ?? "",
    enabled: rule?.enabled ?? true,
    fromProject: fromProject === undefined ? "any" : fromProject === "this" ? "this" : "list",
    fromProjects: Array.isArray(fromProject) ? fromProject.join(", ") : "",
    fromAgents: (match.fromAgent ?? []).join(", "),
    fromSessions: (match.fromSession ?? []).join(", "),
    recipient: match.recipient?.type ?? "",
    recipientId: match.recipient?.id ?? "",
    priority: match.priority ?? "",
    type: match.type ?? "",
    contains: match.contains ?? "",
    pattern: match.pattern ?? "",
    correlationPrefix: match.correlationPrefix ?? "",
    reply: match.reply ?? false,
    action: rule?.action.kind ?? "forward",
    to: [...(rule?.action.to ?? [])],
    steer: rule?.action.steer ?? false,
    raise: rule?.action.priority ?? "",
  }
}

export function ruleOf(draft: Draft, id: string, preset?: OperatorInboxRule["preset"]): OperatorInboxRule {
  const match: OperatorInboxMatch = {
    ...(draft.fromProject === "this"
      ? { fromProject: "this" as const }
      : draft.fromProject === "list" && words(draft.fromProjects).length
        ? { fromProject: words(draft.fromProjects) }
        : {}),
    ...(words(draft.fromAgents).length ? { fromAgent: words(draft.fromAgents) } : {}),
    ...(words(draft.fromSessions).length ? { fromSession: words(draft.fromSessions) } : {}),
    ...(draft.recipient
      ? {
          recipient: {
            type: draft.recipient,
            ...(draft.recipientId.trim() && draft.recipient !== "none" && draft.recipient !== "any"
              ? { id: draft.recipientId.trim() }
              : {}),
          },
        }
      : {}),
    ...(draft.priority ? { priority: draft.priority } : {}),
    ...(draft.type ? { type: draft.type } : {}),
    ...(draft.contains.trim() ? { contains: draft.contains.trim() } : {}),
    ...(draft.pattern ? { pattern: draft.pattern } : {}),
    ...(draft.correlationPrefix.trim() ? { correlationPrefix: draft.correlationPrefix.trim() } : {}),
    ...(draft.reply ? { reply: true } : {}),
  }
  const action: OperatorInboxAction = {
    kind: draft.action,
    ...(draft.action === "forward" ? { to: draft.to.filter((target) => target.id.trim()) } : {}),
    ...(draft.steer ? { steer: true } : {}),
    ...(draft.raise ? { priority: draft.raise } : {}),
  }
  return { id, name: draft.name.trim(), enabled: draft.enabled, match, action, ...(preset ? { preset } : {}) }
}

/** A rule's match in a few words, for the list (the page puts them in its language). */
export function matchParts(match: OperatorInboxMatch): Array<{ key: string; value?: string }> {
  return [
    ...(match.reply ? [{ key: "reply" }] : []),
    ...(match.fromProject === "this"
      ? [{ key: "fromThis" }]
      : match.fromProject
        ? [{ key: "fromProjects", value: match.fromProject.join(", ") }]
        : []),
    ...(match.fromAgent?.length ? [{ key: "fromAgents", value: match.fromAgent.join(", ") }] : []),
    ...(match.fromSession?.length ? [{ key: "fromSessions", value: match.fromSession.join(", ") }] : []),
    ...(match.recipient
      ? match.recipient.type === "none" || match.recipient.type === "any"
        ? [{ key: `recipient.${match.recipient.type}` }]
        : [{ key: "recipient", value: `${match.recipient.type} ${match.recipient.id ?? "*"}` }]
      : []),
    ...(match.priority ? [{ key: "priority", value: match.priority }] : []),
    ...(match.type ? [{ key: "type", value: match.type }] : []),
    ...(match.contains ? [{ key: "contains", value: match.contains }] : []),
    ...(match.pattern ? [{ key: "pattern", value: match.pattern }] : []),
    ...(match.correlationPrefix ? [{ key: "correlation", value: match.correlationPrefix }] : []),
  ]
}
