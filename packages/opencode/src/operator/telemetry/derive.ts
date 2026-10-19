export * as OperatorTelemetryDerive from "./derive"

import type { OperatorTelemetryStore } from "./store"

// What is worked out from spans rather than from one event (observability_spec.md §5.3–§5.5): a tool call's wait and
// active time, a turn's totals, wait, active time and possible loop, and a session's summary row. Recomputed from the
// stored spans whenever one of them changes, so a late or repeated event leaves the right numbers.

export type Loops = { sameCallSameResult: number; sameCall: number; toolCalls: number; modelCalls: number }
export const DEFAULT_LOOPS: Loops = { sameCallSameResult: 3, sameCall: 5, toolCalls: 50, modelCalls: 30 }

type Span = OperatorTelemetryStore.Span
type Store = OperatorTelemetryStore.Store

/** The total length of a set of intervals, overlaps counted once. */
export function union(intervals: ReadonlyArray<readonly [number, number]>) {
  const sorted = intervals.filter(([start, end]) => end > start).toSorted((a, b) => a[0] - b[0])
  let total = 0
  let from = -Infinity
  let to = -Infinity
  for (const [start, end] of sorted) {
    if (start > to) {
      if (to > from) total += to - from
      from = start
      to = end
    } else if (end > to) to = end
  }
  if (to > from) total += to - from
  return total
}

export function attrsOf(span: Pick<Span, "attrs"> | undefined): Record<string, unknown> {
  if (!span?.attrs) return {}
  try {
    const value = JSON.parse(span.attrs)
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** A side call (a title or summary next to the turn): shown with the turn, not counted in its tokens or cost. */
export const side = (span: Span) => attrsOf(span).side === true

/** The first loop rule a turn matches (§5.5), or undefined. */
export function loopOf(input: {
  tools: ReadonlyArray<Pick<Span, "tool" | "args_hash" | "result_hash">>
  waits: ReadonlyArray<Pick<Span, "permission">>
  modelCalls: number
  loops: Loops
}) {
  if (input.waits.some((wait) => wait.permission === "doom_loop")) return "opencode-doom-loop"
  const run = (key: (tool: (typeof input.tools)[number]) => string | undefined, limit: number) => {
    let count = 0
    let last: string | undefined
    for (const tool of input.tools) {
      const value = key(tool)
      count = value !== undefined && value === last ? count + 1 : value === undefined ? 0 : 1
      last = value
      if (count >= limit) return true
    }
    return false
  }
  const both = (tool: (typeof input.tools)[number]) =>
    tool.args_hash && tool.result_hash ? `${tool.tool}\u0000${tool.args_hash}\u0000${tool.result_hash}` : undefined
  const args = (tool: (typeof input.tools)[number]) =>
    tool.args_hash ? `${tool.tool}\u0000${tool.args_hash}` : undefined
  if (run(both, input.loops.sameCallSameResult)) return "same-call-same-result"
  if (run(args, input.loops.sameCall)) return "same-call"
  if (input.tools.length > input.loops.toolCalls) return "many-tool-calls"
  if (input.modelCalls > input.loops.modelCalls) return "many-model-calls"
  return undefined
}

/** A tool call's wait (its permission waits; it asks inside its run) and active time (§5.4). */
export function tool(store: Store, id: string, now: number, known?: Span) {
  const span = known ?? store.span(id)
  if (!span || span.kind !== "tool_call") return
  // Its children by the parent index; only waits count.
  const waits = (
    store.db.query("SELECT kind, start_ms, end_ms FROM span WHERE parent_id = ?").all(id) as Array<{
      kind: string
      start_ms: number
      end_ms: number | null
    }>
  ).filter((child) => child.kind === "permission_wait")
  const wait = waits.reduce((sum, child) => sum + Math.max(0, (child.end_ms ?? now) - child.start_ms), 0)
  const duration = span.end_ms === null ? undefined : Math.max(0, span.end_ms - span.start_ms)
  const active = duration === undefined ? undefined : Math.max(0, duration - wait)
  // Unchanged (most finished calls): nothing to write.
  if (span.wait_ms === wait && (duration === undefined || (span.duration_ms === duration && span.active_ms === active)))
    return
  store.setTiming(id, {
    wait_ms: wait,
    ...(duration !== undefined ? { duration_ms: duration, active_ms: active } : {}),
  })
}

const sum = (spans: ReadonlyArray<Span>, key: keyof Span) =>
  spans.reduce((total, span) => total + (Number(span[key]) || 0), 0)

/** A turn's totals from its spans (subagents have their own turns), its wait, active time and possible loop. */
export function turn(store: Store, id: string, loops: Loops, now: number) {
  const span = store.span(id)
  if (!span || span.kind !== "turn") return
  const children = store.spansOfTurn(id)
  const calls = children.filter((child) => child.kind === "model_call")
  const counted = calls.filter((call) => !side(call))
  const tools = children.filter((child) => child.kind === "tool_call")
  const waits = children.filter((child) => child.kind === "permission_wait")
  const end = span.end_ms ?? now
  const wait = union(waits.map((item) => [item.start_ms, Math.min(item.end_ms ?? end, end)] as const))
  const duration = span.end_ms === null ? undefined : Math.max(0, span.end_ms - span.start_ms)
  const billed = counted.filter((call) => call.cost_billed !== null)
  const loop = loopOf({ tools, waits, modelCalls: calls.length, loops })
  store.upsertSpan({
    id,
    kind: "turn",
    tokens_input: sum(counted, "tokens_input"),
    tokens_output: sum(counted, "tokens_output"),
    tokens_reasoning: sum(counted, "tokens_reasoning"),
    tokens_cache_read: sum(counted, "tokens_cache_read"),
    tokens_cache_write: sum(counted, "tokens_cache_write"),
    cost: sum(counted, "cost"),
    ...(billed.length ? { cost_billed: sum(billed, "cost_billed") } : {}),
    wait_ms: wait,
    ...(duration !== undefined ? { duration_ms: duration, active_ms: Math.max(0, duration - wait) } : {}),
    ...(loop ? { loop } : {}),
    attrs: JSON.stringify({
      ...attrsOf(span),
      modelCalls: calls.length,
      toolCalls: tools.length,
      retries: children.filter((child) => child.kind === "retry").length,
      compactions: children.filter((child) => child.kind === "compaction").length,
      errors:
        tools.filter((child) => child.status === "error").length + calls.filter((c) => c.status === "error").length,
    }),
  })
}

/** What a session's summary takes from outside its spans. */
export type Context = {
  title?: string
  agent?: string
  agentType?: string
  projectKey?: string
  directory?: string
  parentID?: string
  rootID?: string
  trashed?: boolean
}

const SESSION_STATUS: Record<string, string> = {
  ok: "idle",
  error: "error",
  denied: "denied",
  cancelled: "stopped",
  interrupted: "interrupted",
}

/**
 * A session's summary row (§4.4, §9.2) from its spans; its cost with subagents adds its child sessions' rows. Returns
 * whether that total changed, for the parent's row to follow.
 */
export function session(store: Store, id: string, context: Context, now: number) {
  const spans = store.spansOfSession(id)
  const before = store.session(id)
  if (!spans.length) return false
  const turns = spans.filter((span) => span.kind === "turn")
  const calls = spans.filter((span) => span.kind === "model_call")
  const counted = calls.filter((call) => !side(call))
  const tools = spans.filter((span) => span.kind === "tool_call")
  const latest = turns.at(-1)
  const running = turns.find((item) => item.status === "running")
  const waiting = spans.some((span) => span.kind === "permission_wait" && span.status === "running")
  const status = context.trashed
    ? "trash"
    : latest?.status === "running"
      ? waiting
        ? "waiting"
        : "running"
      : (SESSION_STATUS[latest?.status ?? "ok"] ?? "idle")
  const own = sum(counted, "cost")
  const children = store.childSessions(id)
  const total = own + children.reduce((value, child) => value + child.cost_total, 0)
  const billed = counted.filter((call) => call.cost_billed !== null)
  const models = new Map<string, number>()
  for (const call of calls) if (call.model) models.set(call.model, (models.get(call.model) ?? 0) + 1)
  const model = [...models].toSorted((a, b) => b[1] - a[1])[0]?.[0]
  const current = spans
    .filter((span) => span.status === "running")
    .toSorted((a, b) => b.start_ms - a.start_ms || (a.id < b.id ? 1 : -1))[0]
  const looped = turns.findLast((item) => item.loop)
  store.upsertSession({
    id,
    title: context.title ?? before?.title ?? null,
    agent: context.agent ?? latest?.agent ?? before?.agent ?? null,
    agent_type: context.agentType ?? before?.agent_type ?? null,
    project_key: context.projectKey ?? spans.find((span) => span.project_key)?.project_key ?? null,
    directory: context.directory ?? spans.find((span) => span.directory)?.directory ?? null,
    parent_id: context.parentID ?? before?.parent_id ?? null,
    root_id: context.rootID ?? before?.root_id ?? id,
    status,
    first_ms: spans.reduce((low, span) => Math.min(low, span.start_ms), Infinity),
    last_ms: spans.reduce(
      (high, span) => Math.max(high, span.end_ms ?? (span.status === "running" ? now : span.start_ms)),
      -Infinity,
    ),
    turns: turns.length,
    model_calls: calls.length,
    tool_calls: tools.length,
    errors:
      turns.filter((item) => item.status === "error" || item.status === "interrupted").length +
      tools.filter((item) => item.status === "error").length,
    denials: tools.filter((item) => item.status === "denied").length,
    retries: spans.filter((span) => span.kind === "retry").length,
    wait_ms: sum(turns, "wait_ms"),
    active_ms: sum(turns, "active_ms"),
    tokens_input: sum(counted, "tokens_input"),
    tokens_output: sum(counted, "tokens_output"),
    tokens_reasoning: sum(counted, "tokens_reasoning"),
    tokens_cache_read: sum(counted, "tokens_cache_read"),
    tokens_cache_write: sum(counted, "tokens_cache_write"),
    cost: own,
    cost_total: total,
    cost_billed: billed.length ? sum(billed, "cost_billed") : null,
    loop: looped?.loop ?? null,
    trashed: context.trashed ? 1 : 0,
    turn_start_ms: running?.start_ms ?? null,
    current: status === "running" || status === "waiting" ? (current?.name ?? null) : null,
    subagents: spans.filter((span) => span.kind === "subagent").length,
    model: model ?? null,
  })
  return before?.cost_total !== total
}
