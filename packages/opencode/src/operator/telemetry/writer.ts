export * as OperatorTelemetryWriter from "./writer"

import type { OperatorTelemetryBatch } from "./batch"
import { OperatorTelemetryDerive } from "./derive"
import type { OperatorTelemetryStore } from "./store"
import { OperatorTelemetryTotals } from "./totals"

// One flush (observability_spec.md §5.6): a batch written in one transaction, then what depends on it worked out from
// the stored spans (derive.ts): the tool calls' waits, the turns' totals and loops, and the sessions' summaries,
// children before parents, since a child's cost goes into its parent's total.

export function apply(
  store: OperatorTelemetryStore.Store,
  batch: OperatorTelemetryBatch.Batch,
  input: {
    /** Sessions to recompute besides the ones the batch's spans name. */
    sessions?: Iterable<string>
    contextOf: (sessionID: string) => OperatorTelemetryDerive.Context
    loops: OperatorTelemetryDerive.Loops
    dropped?: number
    now: number
  },
) {
  store.transaction(() => {
    const tools = new Set<string>()
    const turns = new Set<string>()
    const sessions = new Set<string>([...(input.sessions ?? []), ...batch.sessions])
    const hours: Array<number | null> = []
    const mark = (span: OperatorTelemetryStore.Span | undefined) => {
      if (!span) return
      hours.push(span.start_ms)
      if (span.kind === "tool_call") tools.add(span.id)
      if (span.kind === "permission_wait" && span.parent_id?.startsWith("tool:")) tools.add(span.parent_id)
      if (span.turn_id) turns.add(span.turn_id)
      if (span.session_id) sessions.add(span.session_id)
    }
    for (const id of batch.deletes) {
      mark(store.span(id))
      store.deleteSpan(id)
    }
    for (const span of batch.spans.values()) {
      store.upsertSpan(span)
      mark(store.span(span.id))
    }
    // A session deleted for good leaves what it added to the totals (§5.10).
    for (const id of batch.deletedSessions) {
      OperatorTelemetryTotals.freeze(store, store.spansOfSession(id))
      store.deleteSession(id)
      sessions.delete(id)
    }
    for (const entry of batch.logs) store.insertLog(entry)
    for (const sample of batch.samples) store.insertSample(sample)
    for (const row of batch.mcp) store.insertMcpStatus(row)
    if (batch.logPosition) store.setMeta("log_position", JSON.stringify(batch.logPosition))
    for (const id of tools) OperatorTelemetryDerive.tool(store, id, input.now)
    for (const id of turns) {
      OperatorTelemetryDerive.turn(store, id, input.loops, input.now)
      hours.push(store.span(id)?.start_ms ?? null)
    }
    OperatorTelemetryTotals.mark(store, hours)
    const pending = [...sessions]
    for (let step = 0; pending.length && step < 10_000; step++) {
      const id = pending.shift()!
      const context = input.contextOf(id)
      const changed = OperatorTelemetryDerive.session(store, id, context, input.now)
      if (changed && context.parentID && !pending.includes(context.parentID)) pending.push(context.parentID)
    }
    store.setMeta("last_write", String(input.now))
    if (input.dropped !== undefined) store.setMeta("dropped", String(input.dropped))
  })
}

/**
 * Spans a stopped server left running (§5.7): `interrupted`, ended at the last time that server wrote anything. Their
 * turns and sessions are worked out again from what is stored.
 */
export function interrupt(
  store: OperatorTelemetryStore.Store,
  input: { started: number; loops: OperatorTelemetryDerive.Loops; now: number },
) {
  const restarted = store.running(input.started)
  if (!restarted.length) return
  const last = Number(store.meta("last_write") ?? 0)
  store.transaction(() => {
    for (const span of restarted)
      store.upsertSpan({
        id: span.id,
        kind: span.kind,
        status: "interrupted",
        error_type: "server_restart",
        end_ms: Math.max(span.start_ms, last || span.start_ms),
      })
    for (const span of restarted) if (span.kind === "tool_call") OperatorTelemetryDerive.tool(store, span.id, input.now)
    for (const id of new Set(restarted.map((span) => span.turn_id).filter((id): id is string => !!id)))
      OperatorTelemetryDerive.turn(store, id, input.loops, input.now)
    for (const id of new Set(restarted.map((span) => span.session_id).filter((id): id is string => !!id))) {
      const before = store.session(id)
      OperatorTelemetryDerive.session(store, id, before ? contextOf(before) : {}, input.now)
    }
  })
}

/** A summary row's context, to recompute it without the session's events. */
export function contextOf(row: OperatorTelemetryStore.SessionRow): OperatorTelemetryDerive.Context {
  return {
    ...(row.title ? { title: row.title } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.agent_type ? { agentType: row.agent_type } : {}),
    ...(row.project_key ? { projectKey: row.project_key } : {}),
    ...(row.directory ? { directory: row.directory } : {}),
    ...(row.parent_id ? { parentID: row.parent_id } : {}),
    ...(row.root_id ? { rootID: row.root_id } : {}),
    trashed: row.trashed === 1,
  }
}

/** Recomputes the hours whose spans changed (every 60 s, §6.2). */
export function totals(store: OperatorTelemetryStore.Store) {
  return store.transaction(() => OperatorTelemetryTotals.recompute(store))
}
