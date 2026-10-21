export * as OperatorHookEvents from "./events"

// The sixteen events a hook can be attached to (SPEC-0022 §5): when each fires, whether the session waits
// for the answer (blocking) or goes on (watch), and what an answer may do. An answer field an event doesn't
// allow is ignored, and the run log lists it (§7.3).

export const NAMES = [
  "session.created",
  "prompt.submitted",
  "turn.before",
  "step.before",
  "step.after",
  "tool.before",
  "tool.after",
  "subagent.before",
  "subagent.after",
  "permission.asked",
  "compaction.before",
  "compaction.after",
  "turn.after",
  "session.error",
  "file.edited",
  "session.deleted",
] as const
export type Name = (typeof NAMES)[number]
export const isName = (value: unknown): value is Name => (NAMES as ReadonlyArray<unknown>).includes(value)

/** Answer fields, as a script writes them (§8). */
export const FIELDS = ["allow", "reason", "input", "prompt", "output", "context", "continue"] as const
export type Field = (typeof FIELDS)[number]

/** What `match` is checked against, for the events that have it. */
export type Subject = "tool" | "permission" | "agent"

export type Group = "session" | "prompt" | "step" | "tool" | "permission" | "compaction" | "watch"

export type Event = {
  name: Name
  /** blocking: the session waits for the answer; watch: it goes on and the hook runs alongside. */
  kind: "blocking" | "watch"
  /** Answer fields this event uses; `reason` goes with `allow`. */
  fields: ReadonlyArray<Field>
  subject?: Subject
  group: Group
}

const event = (
  name: Name,
  kind: Event["kind"],
  fields: ReadonlyArray<Field>,
  group: Group,
  subject?: Subject,
): Event => ({ name, kind, fields, group, ...(subject ? { subject } : {}) })

export const EVENTS: ReadonlyArray<Event> = [
  event("session.created", "watch", [], "session"),
  event("prompt.submitted", "blocking", ["allow", "reason", "prompt", "context"], "prompt"),
  event("turn.before", "blocking", ["allow", "reason", "context"], "prompt"),
  event("step.before", "blocking", ["allow", "reason", "context"], "step"),
  event("step.after", "watch", [], "step"),
  event("tool.before", "blocking", ["allow", "reason", "input", "context"], "tool", "tool"),
  // Blocking when the tool succeeded, watch when it failed (§5): the failed path has no seam (§12.3, item 3).
  event("tool.after", "blocking", ["output", "context"], "tool", "tool"),
  event("subagent.before", "blocking", ["allow", "reason", "prompt", "context"], "tool", "agent"),
  event("subagent.after", "blocking", ["output", "context"], "tool", "agent"),
  event("permission.asked", "blocking", ["allow", "reason"], "permission", "permission"),
  // No deny in v1 (§12.3, item 2): it adds context only.
  event("compaction.before", "blocking", ["context"], "compaction"),
  event("compaction.after", "blocking", ["continue"], "compaction"),
  event("turn.after", "watch", [], "watch"),
  event("session.error", "watch", [], "watch"),
  event("file.edited", "watch", [], "watch"),
  event("session.deleted", "watch", [], "session"),
]

const byName = new Map(EVENTS.map((item) => [item.name, item]))
export const of = (name: Name): Event => byName.get(name)!

/** The answer fields a run's answer used that its event doesn't allow (§7.3: ignored and listed). */
export function ignoredFields(name: Name, answer: Record<string, unknown>): string[] {
  const allowed = new Set<string>(of(name).fields)
  return Object.keys(answer).filter((key) => !allowed.has(key))
}
