// What the Hooks tab shows about a hook at the page's scope (SPEC-0022 §10.1, §10.4), as plain values the
// views and tests share: its state here, where it comes from, what the scope may do with it, and what a Test
// run's answer would do, in words (as language keys with their values).

type Level = "global" | "namespace" | "project" | "agent"
export type HookRow = {
  name: string
  event: string
  level: Level
  locked: boolean
  state: "on" | "off" | "disabled" | "invalid"
  offAt?: Level
  problems: ReadonlyArray<string>
}

/** On; Off here (this scope turned it off); Off (a level between turned it off); Locked; Disabled; Invalid. */
export type Shown = "on" | "offHere" | "off" | "locked" | "disabled" | "invalid"

export function shownState(hook: HookRow, scope: Level): Shown {
  if (hook.state === "invalid") return "invalid"
  if (hook.state === "disabled") return "disabled"
  if (hook.state === "off") return hook.offAt === scope ? "offHere" : "off"
  return hook.locked && hook.level !== scope ? "locked" : "on"
}

/** This scope's own hook, or inherited from a level above. */
export const isOwn = (hook: Pick<HookRow, "level">, scope: Level) => hook.level === scope

/** What the scope may do: edit and delete its own; turn an inherited one off or on, or override it, unless locked. */
export function actionsOf(hook: HookRow, scope: Level) {
  if (isOwn(hook, scope)) return { edit: true, remove: true, turnOff: false, turnOn: false, override: false }
  const free = !hook.locked
  return {
    edit: false,
    remove: false,
    turnOff: free && hook.state !== "off",
    turnOn: free && hook.state === "off" && hook.offAt === scope,
    override: free,
  }
}

export type Words = { key: string; values?: Record<string, string> }

const WHAT: Record<string, string> = {
  "prompt.submitted": "message",
  "turn.before": "turn",
  "step.before": "turn",
  "tool.before": "tool",
  "subagent.before": "subagent",
  "permission.asked": "request",
}
const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

/** What a Test run's answer would do in a session (§10.4). */
export function wouldDo(input: {
  event: string
  outcome: string
  answer: Record<string, unknown>
  cause?: string
  onFailure?: string
}): Words[] {
  const { event, answer } = input
  if (input.outcome === "failed" || input.outcome === "timed out" || input.outcome === "stopped by the server") {
    const failure: Words = { key: "operator.hooks.would.failed", values: { cause: input.cause ?? input.outcome } }
    if (event === "permission.asked") return [failure, { key: "operator.hooks.would.ask" }]
    if (!WHAT[event] && event !== "tool.after" && event !== "subagent.after" && event !== "compaction.after")
      return [failure]
    return [
      failure,
      { key: input.onFailure === "allow" ? "operator.hooks.would.failOpen" : "operator.hooks.would.failClosed" },
    ]
  }
  const out: Words[] = []
  if (answer.allow === false) {
    const reason = typeof answer.reason === "string" ? answer.reason : ""
    out.push({ key: `operator.hooks.would.deny.${WHAT[event] ?? "tool"}`, values: { reason } })
    return out
  }
  if (answer.allow === true && event === "permission.asked") out.push({ key: "operator.hooks.would.allowOnce" })
  if (answer.continue === false) out.push({ key: "operator.hooks.would.noContinue" })
  if (answer.input !== undefined) out.push({ key: "operator.hooks.would.input", values: { value: show(answer.input) } })
  if (answer.prompt !== undefined)
    out.push({
      key: event === "subagent.before" ? "operator.hooks.would.subagentPrompt" : "operator.hooks.would.prompt",
      values: { value: show(answer.prompt) },
    })
  if (answer.output !== undefined)
    out.push({ key: "operator.hooks.would.output", values: { value: show(answer.output) } })
  if (answer.context !== undefined)
    out.push({ key: `operator.hooks.would.context.${contextWhere(event)}`, values: { value: show(answer.context) } })
  if (!out.length)
    out.push({ key: event === "permission.asked" ? "operator.hooks.would.ask" : "operator.hooks.would.nothing" })
  return out
}

function contextWhere(event: string) {
  if (event === "prompt.submitted" || event === "turn.before") return "message"
  if (event === "step.before") return "request"
  if (event === "compaction.before") return "compaction"
  return "result"
}

/** Arguments as the form writes them: one a line. */
export const linesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

/** Names as the form writes them: comma or space separated. */
export const namesOf = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
