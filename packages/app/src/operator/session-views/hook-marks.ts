// What hooks did (SPEC-0022 §10.6), read from the parts the server's hooks/seams.ts marks (`metadata.hook`): to a
// tool call, when it completes, and for a deny, from the error text the model got ("Denied by hook <name>:
// <reason>"); to a user message, its text a hook changed and the context hooks added to it. A changed value keeps
// its original; a context is the text the model got.

export type By = { hook: string; level: string; file: string; run: string }
export type Mark =
  | { kind: "denied"; hook: string; reason?: string }
  | { kind: "input" | "prompt" | "output" | "text"; by: By[]; original: string }
  | { kind: "withheld"; by: By; reason: string }
  | { kind: "context"; by: By; event: string; text: string }
  /** compaction.after answered `continue: false`: no automatic "continue" turn followed. */
  | { kind: "no-continue"; by: By }

type Part = { type: string; metadata?: unknown; state?: { status?: string; error?: string; metadata?: unknown } }

const DENIED = /^Denied by hook (\S+?)(?:: ([\s\S]+)|\.)$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const isBy = (value: unknown): value is By & Record<string, unknown> =>
  isRecord(value) && typeof value.hook === "string" && typeof value.run === "string"
const byOf = (value: By): By => ({
  hook: value.hook,
  level: String(value.level ?? ""),
  file: String(value.file ?? ""),
  run: value.run,
})
const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

/** What hooks did to a user message: its text changed (prompt.submitted), context added to it. */
export function messageMarks(parts: ReadonlyArray<Part & { text?: string }>): Mark[] {
  const out: Mark[] = []
  for (const part of parts) {
    if (part.type !== "text") continue
    const metadata = isRecord(part.metadata) ? part.metadata : {}
    const marks = isRecord(metadata.hook) ? metadata.hook : {}
    const change = marks.prompt
    if (isRecord(change) && Array.isArray(change.by)) {
      const by = change.by.filter(isBy).map(byOf)
      if (by.length) out.push({ kind: "text", by, original: shown(change.original) })
    }
    out.push(...contexts(marks))
  }
  return out
}

function contexts(marks: Record<string, unknown>): Mark[] {
  if (!Array.isArray(marks.context)) return []
  return marks.context.flatMap((item): Mark[] =>
    isBy(item)
      ? [{ kind: "context", by: byOf(item), event: String(item.event ?? ""), text: String(item.text ?? "") }]
      : [],
  )
}

/** What hooks did to a tool call. */
export function hookMarks(part: Part): Mark[] {
  if (part.type !== "tool" || !part.state) return []
  const out: Mark[] = []
  if (part.state.status === "error" && part.state.error) {
    const denied = DENIED.exec(part.state.error)
    if (denied) out.push({ kind: "denied", hook: denied[1]!, ...(denied[2] ? { reason: denied[2] } : {}) })
  }
  const metadata = isRecord(part.state.metadata) ? part.state.metadata : {}
  const marks = isRecord(metadata.hook) ? metadata.hook : {}
  for (const kind of ["input", "prompt", "output"] as const) {
    const change = marks[kind]
    if (!isRecord(change) || !Array.isArray(change.by)) continue
    const by = change.by.filter(isBy).map(byOf)
    if (by.length) out.push({ kind, by, original: shown(change.original) })
  }
  if (isBy(marks.withheld))
    out.push({ kind: "withheld", by: byOf(marks.withheld), reason: String(marks.withheld.reason ?? "") })
  out.push(...contexts(marks))
  // A withheld output's mark says so; its "changed" line would repeat it.
  return out.some((mark) => mark.kind === "withheld") ? out.filter((mark) => mark.kind !== "output") : out
}
