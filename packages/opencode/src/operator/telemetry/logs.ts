export * as OperatorTelemetryLogs from "./logs"

import fs from "fs/promises"
import type { OperatorTelemetryStore } from "./store"

// The server log, tailed into the store (observability_spec.md §5.8): `~/.local/share/opencode/log/opencode.log`, in
// core's `key=value` format (observability/logging.ts: timestamp, level, run, message, then the fields; a value with a
// space, `=` or a quote is JSON-quoted). Lines at or above the configured level are kept, cut to size. Read from a
// stored byte offset; a file that got smaller or was replaced (a new inode) is read again from the start, and a first
// start begins at the end.

export type Level = "error" | "warn" | "info"
const RANK: Record<string, number> = { ERROR: 0, WARN: 1, WARNING: 1, INFO: 2, DEBUG: 3, TRACE: 4 }
const MIN: Record<Level, number> = { error: 0, warn: 1, info: 2 }

const MESSAGE = 1_000
const VALUE = 500
const FIELDS = 4_096
/** At most this much is read per pass, so a large backlog is read over several. */
const CHUNK = 1024 * 1024

/** A line's `key=value` pairs, in order (a JSON-quoted value is unquoted). */
export function pairs(line: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let at = 0
  while (at < line.length) {
    while (line[at] === " ") at += 1
    const equals = line.indexOf("=", at)
    if (equals < 0) break
    const key = line.slice(at, equals)
    at = equals + 1
    if (line[at] === '"') {
      let end = at + 1
      while (end < line.length && line[end] !== '"') end += line[end] === "\\" ? 2 : 1
      const raw = line.slice(at, end + 1)
      let value = raw
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw.slice(1, -1)
      }
      out.push([key, String(value)])
      at = end + 1
      continue
    }
    const space = line.indexOf(" ", at)
    const end = space < 0 ? line.length : space
    out.push([key, line.slice(at, end)])
    at = end
  }
  return out
}

/** One log line as an entry (its id from the file and offset), or undefined if it isn't one. */
export function parse(line: string, id: string): Omit<OperatorTelemetryStore.LogEntry, "seq"> | undefined {
  const found = pairs(line)
  const map = new Map(found)
  const time = Date.parse(map.get("timestamp") ?? "")
  const level = (map.get("level") ?? "").toUpperCase()
  if (!Number.isFinite(time) || !(level in RANK)) return undefined
  const fields: Record<string, string> = {}
  let size = 2
  for (const [key, value] of found) {
    if (["timestamp", "level", "run", "message"].includes(key)) continue
    const cut = value.length > VALUE ? value.slice(0, VALUE) : value
    const added = JSON.stringify(key).length + JSON.stringify(cut).length + 2
    if (size + added > FIELDS) break
    fields[key] = cut
    size += added
  }
  const message = map.get("message") ?? ""
  return {
    id,
    time_ms: time,
    level: level === "WARNING" ? "WARN" : level,
    message: message.length > MESSAGE ? message.slice(0, MESSAGE) : message,
    run: map.get("run") ?? null,
    service: map.get("service") ?? null,
    session_id: map.get("session.id") ?? map.get("sessionID") ?? null,
    fields: Object.keys(fields).length ? JSON.stringify(fields) : null,
  }
}

export function kept(level: string, min: Level) {
  return (RANK[level.toUpperCase()] ?? 99) <= MIN[min]
}

export type Position = { inode: number; offset: number }

/**
 * The new entries since `position` (none on a first start, which begins at the end), and where to read next. Only
 * whole lines are read; a line still being written waits for the next pass.
 */
export async function read(input: { file: string; position: Position | undefined; level: Level; fromStart?: number }) {
  const stat = await fs.stat(input.file).catch(() => undefined)
  if (!stat) return { entries: [], position: input.position }
  const inode = Number(stat.ino)
  const restart = !input.position || input.position.inode !== inode || stat.size < input.position.offset
  const offset = !input.position
    ? input.fromStart !== undefined
      ? Math.max(0, stat.size - input.fromStart)
      : stat.size
    : restart
      ? 0
      : input.position.offset
  if (stat.size <= offset) return { entries: [], position: { inode, offset } }
  const length = Math.min(CHUNK, stat.size - offset)
  const handle = await fs.open(input.file, "r")
  const buffer = Buffer.alloc(length)
  try {
    await handle.read(buffer, 0, length, offset)
  } finally {
    await handle.close()
  }
  const last = buffer.lastIndexOf(0x0a)
  if (last < 0) return { entries: [], position: { inode, offset: length === CHUNK ? offset + length : offset } }
  const entries: Array<Omit<OperatorTelemetryStore.LogEntry, "seq">> = []
  let start = 0
  // A read that starts mid-file (fromStart) skips the partial first line.
  if (!input.position && input.fromStart !== undefined && offset > 0) start = buffer.indexOf(0x0a) + 1
  while (start <= last) {
    const end = buffer.indexOf(0x0a, start)
    const line = buffer.subarray(start, end).toString("utf8")
    const entry = line.trim() ? parse(line, `log:${inode}:${offset + start}`) : undefined
    if (entry && kept(entry.level, input.level)) entries.push(entry)
    start = end + 1
  }
  return { entries, position: { inode, offset: offset + last + 1 } }
}
