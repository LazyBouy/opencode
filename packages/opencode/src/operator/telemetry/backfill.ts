export * as OperatorTelemetryBackfill from "./backfill"

import type { OperatorTelemetryIngest } from "./ingest"

// Building history (observability_spec.md §5.11): on the store's first start, and from Rebuild from history. Stored
// sessions inside the detailed window are replayed through the same ingestion as live events (a backfill-mode Ingest,
// whose turns end when their last assistant message completed), then their recorded calls and decision records, and
// the queue. Ids are stable (§4.5), so running it again updates rows; a row a live event wrote since it started wins.

export type Progress = {
  state: "idle" | "running" | "done" | "failed"
  /** Sessions read so far. */
  done: number
  /** Sessions to read. */
  total: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

export const IDLE: Progress = { state: "idle", done: 0, total: 0 }

/** Rows written per batch, with a pause between batches, so live sessions keep the disk. */
export const BATCH = 500
export const PAUSE_MS = 50
/** The server log's last part a first backfill reads. */
export const LOG_BYTES = 10 * 1024 * 1024

export type Message = { id: string; data: Record<string, unknown> }
export type Part = { id: string; message_id: string; data: Record<string, unknown> }

/**
 * One stored session through the ingestion, as the events that wrote it: the session, then each message (as last
 * written) with its parts, in order; then the end of its history.
 */
export function replay(
  ingest: OperatorTelemetryIngest.Ingest,
  session: { id: string; parentID?: string | null; title?: string; directory: string },
  messages: ReadonlyArray<Message>,
  parts: ReadonlyArray<Part>,
  clock: (time: number) => void,
) {
  ingest.handle({
    directory: session.directory,
    payload: {
      type: "session.created",
      properties: {
        sessionID: session.id,
        info: {
          id: session.id,
          parentID: session.parentID ?? undefined,
          title: session.title,
          directory: session.directory,
        },
      },
    },
  })
  const byMessage = new Map<string, Part[]>()
  for (const part of parts) {
    const list = byMessage.get(part.message_id)
    if (list) list.push(part)
    else byMessage.set(part.message_id, [part])
  }
  for (const message of messages) {
    const info = { ...message.data, id: message.id, sessionID: session.id } as Record<string, any>
    clock(Number(info.time?.created) || 0)
    ingest.handle({
      directory: session.directory,
      payload: { type: "message.updated", properties: { sessionID: session.id, info } },
    })
    for (const part of byMessage.get(message.id) ?? [])
      ingest.handle({
        directory: session.directory,
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: session.id,
            part: { ...part.data, id: part.id, sessionID: session.id, messageID: message.id },
            time: Number(info.time?.created) || 0,
          },
        },
      })
  }
  ingest.finish(session.id)
}
