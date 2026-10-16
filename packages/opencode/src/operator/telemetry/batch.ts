export * as OperatorTelemetryBatch from "./batch"

import type { OperatorTelemetryLogs } from "./logs"
import type { OperatorTelemetryStore } from "./store"

// What event handlers hand the writer (observability_spec.md §5.6): rows in memory only, no disk access, no awaiting.
// Writes to one span merge (the newest value of each column wins), so a tool call that starts and ends between two
// flushes is written once. Past the backlog limit new rows are dropped and counted; nothing ever blocks or throws into
// a session.

export const LIMIT = 50_000

export class Batch {
  readonly spans = new Map<string, OperatorTelemetryStore.SpanWrite>()
  readonly deletes = new Set<string>()
  readonly deletedSessions = new Set<string>()
  readonly trash = new Map<string, boolean>()
  readonly logs: Array<Omit<OperatorTelemetryStore.LogEntry, "seq">> = []
  readonly samples: OperatorTelemetryStore.Sample[] = []
  readonly mcp: OperatorTelemetryStore.McpStatus[] = []
  /** Sessions whose recorded calls are read at the next flush. */
  readonly calls = new Set<string>()
  /** Queue items read at the next flush. */
  readonly queue = new Set<string>()
  /** Sessions whose summary is recomputed at the next flush. */
  readonly sessions = new Set<string>()
  /** Where the server log was read to, kept with the lines it gave. */
  logPosition: OperatorTelemetryLogs.Position | undefined
  dropped = 0

  constructor(readonly limit = LIMIT) {}

  size() {
    return this.spans.size + this.logs.length + this.samples.length + this.mcp.length
  }

  private full() {
    if (this.size() < this.limit) return false
    this.dropped += 1
    return true
  }

  span(write: OperatorTelemetryStore.SpanWrite) {
    const before = this.spans.get(write.id)
    if (!before && this.full()) return
    const merged: Record<string, unknown> = { ...before }
    for (const [key, value] of Object.entries(write)) if (value !== undefined) merged[key] = value
    this.spans.set(write.id, merged as OperatorTelemetryStore.SpanWrite)
    this.deletes.delete(write.id)
    if (write.session_id) this.sessions.add(write.session_id)
  }

  deleteSpan(id: string) {
    this.spans.delete(id)
    this.deletes.add(id)
  }

  deleteSession(sessionID: string) {
    for (const [id, write] of this.spans) if (write.session_id === sessionID) this.spans.delete(id)
    this.sessions.delete(sessionID)
    this.calls.delete(sessionID)
    this.deletedSessions.add(sessionID)
  }

  log(entry: Omit<OperatorTelemetryStore.LogEntry, "seq">) {
    if (!this.full()) this.logs.push(entry)
  }

  sample(sample: OperatorTelemetryStore.Sample) {
    if (!this.full()) this.samples.push(sample)
  }

  mcpStatus(row: OperatorTelemetryStore.McpStatus) {
    if (!this.full()) this.mcp.push(row)
  }

  empty() {
    return (
      !this.size() &&
      !this.deletes.size &&
      !this.deletedSessions.size &&
      !this.trash.size &&
      !this.calls.size &&
      !this.queue.size &&
      !this.sessions.size &&
      !this.logPosition
    )
  }
}
