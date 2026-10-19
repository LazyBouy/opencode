export * as OperatorTelemetryRetention from "./retention"

import type { OperatorTelemetryStore } from "./store"
import { OperatorTelemetryTotals } from "./totals"

// Retention (observability_spec.md §6.1): detailed events are kept a number of days (default 30), hourly totals
// longer (default 400). Purging runs at startup and every 6 hours, in batches of 5,000 rows (each its own transaction,
// so live writes go on between them), then frees the pages. A span goes by its end (or its start, if it never ended);
// a turn goes with all its spans; a kept session (§6.3) keeps everything. What purged spans added to the totals is
// frozen first, so the totals stay.

export const DAY = 24 * 60 * 60 * 1000
export const BATCH = 5_000

export const RANGES = {
  eventsDays: { min: 1, max: 365, default: 30 },
  totalsDays: { min: 30, max: 1825, default: 400 },
}

/** The retention settings, within their ranges; totals are never kept less than events. */
export function days(input: { eventsDays?: unknown; totalsDays?: unknown }) {
  const clamp = (value: unknown, range: { min: number; max: number; default: number }) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(range.max, Math.max(range.min, Math.round(value)))
      : range.default
  const events = clamp(input.eventsDays, RANGES.eventsDays)
  return { eventsDays: events, totalsDays: Math.max(events, clamp(input.totalsDays, RANGES.totalsDays)) }
}

const KEPT = "SELECT session_id FROM kept_session"
const NOT_KEPT = `(session_id IS NULL OR session_id NOT IN (${KEPT})) AND (root_session_id IS NULL OR root_session_id NOT IN (${KEPT}))`

export type Purged = {
  spans: number
  logs: number
  samples: number
  mcp: number
  sessions: number
  totals: number
  alerts: number
}

/** Purges what is older than the settings allow. Returns what went, and the sessions whose summary must be redone. */
export function purge(
  store: OperatorTelemetryStore.Store,
  input: { eventsDays: number; totalsDays: number; now: number; batch?: number },
): Purged & { touched: Set<string> } {
  const events = input.now - input.eventsDays * DAY
  const totals = input.now - input.totalsDays * DAY
  const size = input.batch ?? BATCH
  const out: Purged & { touched: Set<string> } = {
    spans: 0,
    logs: 0,
    samples: 0,
    mcp: 0,
    sessions: 0,
    totals: 0,
    alerts: 0,
    touched: new Set(),
  }
  const drop = (spans: OperatorTelemetryStore.Span[]) => {
    OperatorTelemetryTotals.freeze(store, spans)
    const statement = store.db.prepare("DELETE FROM span WHERE id = ?")
    for (const span of spans) {
      statement.run(span.id)
      if (span.session_id) out.touched.add(span.session_id)
    }
    out.spans += spans.length
  }
  // Turns with all their spans.
  for (;;) {
    const turns = store.db
      .query(`SELECT id FROM span WHERE kind = 'turn' AND COALESCE(end_ms, start_ms) < ? AND ${NOT_KEPT} LIMIT ?`)
      .all(events, Math.max(1, Math.floor(size / 50))) as Array<{ id: string }>
    if (!turns.length) break
    store.transaction(() => {
      for (const turn of turns)
        drop(
          store.db
            .query("SELECT * FROM span WHERE turn_id = ? OR id = ?")
            .all(turn.id, turn.id) as OperatorTelemetryStore.Span[],
        )
    })
  }
  // Spans outside a turn (helper runs, queue items, unlinked calls, alerts), and any whose turn is gone.
  for (;;) {
    const spans = store.db
      .query(
        `SELECT * FROM span WHERE kind != 'turn' AND COALESCE(end_ms, start_ms) < ? AND ${NOT_KEPT}
         AND (turn_id IS NULL OR turn_id NOT IN (SELECT id FROM span WHERE kind = 'turn')) LIMIT ?`,
      )
      .all(events, size) as OperatorTelemetryStore.Span[]
    if (!spans.length) break
    store.transaction(() => drop(spans))
  }
  const batched = (select: string, ...values: Array<string | number>) => {
    let count = 0
    for (;;) {
      const changes = store.transaction(
        () => store.db.query(`DELETE FROM ${select} LIMIT ${size})`).run(...values).changes,
      )
      count += changes
      if (changes < size) return count
    }
  }
  out.logs = batched(
    `log_entry WHERE id IN (SELECT id FROM log_entry WHERE time_ms < ? AND (session_id IS NULL OR session_id NOT IN (${KEPT}))`,
    events,
  )
  out.samples = batched("sample WHERE id IN (SELECT id FROM sample WHERE time_ms < ?", events)
  out.mcp = batched("mcp_status WHERE id IN (SELECT id FROM mcp_status WHERE time_ms < ?", events)
  out.totals =
    batched("total_hour WHERE rowid IN (SELECT rowid FROM total_hour WHERE hour_ms < ?", totals) +
    batched("total_frozen WHERE rowid IN (SELECT rowid FROM total_frozen WHERE hour_ms < ?", totals)
  // Alert history is kept as long as the totals.
  out.alerts = batched(
    "alert_event WHERE id IN (SELECT id FROM alert_event WHERE end_ms IS NOT NULL AND end_ms < ?",
    totals,
  )
  // Summaries of sessions with nothing left, unless kept.
  out.sessions = store.transaction(
    () =>
      store.db
        .query(
          `DELETE FROM session_row WHERE id NOT IN (SELECT DISTINCT session_id FROM span WHERE session_id IS NOT NULL)
           AND id NOT IN (${KEPT})`,
        )
        .run().changes,
  )
  for (const id of [...out.touched]) if (!store.session(id)) out.touched.delete(id)
  store.db.exec("PRAGMA incremental_vacuum")
  store.setMeta("last_purge", String(input.now))
  store.optimize()
  return out
}
