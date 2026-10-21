export * as OperatorHookProtocol from "./protocol"

import { OperatorHookEvents } from "./events"

// What a hook is given and how its answer is read (SPEC-0022 §7.1, §7.6, §8). The script reads one JSON
// object on stdin. On stdout it prints nothing ("no objection") or one JSON object, the answer; stderr is
// kept for the run log and never read. An answer field the event doesn't use is ignored and listed; a field
// of the wrong type, or output that isn't one JSON object, makes the run a failure.

export const CONTEXT_LIMIT = 4000
export const REASON_LIMIT = 1000
/** What the run log keeps of each text (stdout, stderr, a change before and after). */
export const LOG_LIMIT = 8 * 1024

/** The fields every event sends (§7.6); each event adds its own. */
export type Base = {
  event: OperatorHookEvents.Name
  hook: string
  level: string
  time: string
  session?: { id: string; parentID: string | null; title: string }
  agent?: { name: string; type: string }
  project?: { id: string; name: string; folder: string }
  namespace?: { id: string; name: string }
  cwd: string
  model?: { provider: string; id: string }
}

export type Answer = {
  allow?: boolean
  reason?: string
  input?: Record<string, unknown>
  prompt?: string
  output?: string
  context?: string
  continue?: boolean
}

export type Parsed = { ok: true; answer: Answer; ignored: string[] } | { ok: false; error: string }

export function cut(text: string, limit: number, suffix = " (cut by the server)") {
  return text.length > limit ? text.slice(0, limit) + suffix : text
}

const TYPES: Record<OperatorHookEvents.Field, (value: unknown) => boolean> = {
  allow: (value) => typeof value === "boolean",
  reason: (value) => typeof value === "string",
  input: (value) => !!value && typeof value === "object" && !Array.isArray(value),
  prompt: (value) => typeof value === "string",
  output: (value) => typeof value === "string",
  context: (value) => typeof value === "string",
  continue: (value) => typeof value === "boolean",
}
const EXPECTED: Record<OperatorHookEvents.Field, string> = {
  allow: "true or false",
  reason: "text",
  input: "an object",
  prompt: "text",
  output: "text",
  context: "text",
  continue: "true or false",
}

/** Reads a run's stdout as the answer for its event. */
export function parse(event: OperatorHookEvents.Name, stdout: string): Parsed {
  const text = stdout.trim()
  if (!text) return { ok: true, answer: {}, ignored: [] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: "its output isn't one JSON object" }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "its output isn't one JSON object" }
  const raw = value as Record<string, unknown>
  const ignored = OperatorHookEvents.ignoredFields(event, raw)
  const answer: Answer = {}
  for (const field of OperatorHookEvents.of(event).fields) {
    if (!(field in raw) || raw[field] === undefined || raw[field] === null) continue
    if (!TYPES[field](raw[field])) return { ok: false, error: `"${field}" must be ${EXPECTED[field]}` }
    ;(answer as Record<string, unknown>)[field] = raw[field]
  }
  if (answer.reason !== undefined) answer.reason = cut(answer.reason, REASON_LIMIT, "…")
  if (answer.context !== undefined) answer.context = cut(answer.context, CONTEXT_LIMIT)
  return { ok: true, answer, ignored }
}

/** Context as the model sees it: under one header line naming the hook (§8.3). */
export function contextBlock(hook: string, text: string) {
  return `From hook ${hook}:\n${text}`
}
