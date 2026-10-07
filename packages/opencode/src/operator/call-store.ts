export * as OperatorCallStore from "./call-store"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorCallFormat } from "./call-format"

// Recorded model calls, on disk: `<data>/operator/calls/<sessionID>/calls.jsonl` (one call per line,
// then update lines when its response completes) and `blobs/<hash>.json` (each message, system text
// and tools value stored once; see call-format.ts). `latest.json` names each agent's newest call per
// project, for the Tool Prompt tab's "Last sent". Plain async functions: the provider tap that writes
// here runs in the fetch layer, outside Effect.

export type Kind = "agent" | "title" | "compaction" | "summary" | "other" | "unlinked"

export type Call = {
  callID: string
  sessionID: string
  projectKey?: string
  directory?: string
  agent?: string
  kind: Kind
  userMessageID?: string
  assistantMessageID?: string
  retryOf?: string
  model?: string
  providerID?: string
  endpoint: string
  format: OperatorCallFormat.Format
  startedAt: number
  firstByteAt?: number
  finishedAt?: number
  httpStatus?: number
  request: {
    body: OperatorCallFormat.Stored
    bytes: number
    exact: boolean
    headers: Record<string, string>
  }
  response?: OperatorCallFormat.Assembled
  error?: { status?: number; body?: string; message?: string }
}

export function root() {
  return path.join(Global.Path.data, "operator", "calls")
}
const folder = (sessionID: string) => path.join(root(), sessionID.replace(/[^a-zA-Z0-9_-]/g, "_"))
const lines = (sessionID: string) => path.join(folder(sessionID), "calls.jsonl")
const blobFile = (sessionID: string, key: string) => path.join(folder(sessionID), "blobs", `${key}.json`)

// Writes per session happen in order (a call's update after the call).
const queues = new Map<string, Promise<unknown>>()
function queued<T>(sessionID: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(sessionID) ?? Promise.resolve()).then(work, work)
  queues.set(
    sessionID,
    next.catch(() => undefined),
  )
  return next
}

export function saveCall(call: Call, blobs: Map<string, string>) {
  return queued(call.sessionID, async () => {
    await fs.mkdir(path.join(folder(call.sessionID), "blobs"), { recursive: true })
    for (const [key, text] of blobs) {
      const file = blobFile(call.sessionID, key)
      // Stored once: a blob that exists is the same text (its name is its hash).
      if (await Bun.file(file).exists()) continue
      await Bun.write(file, text)
    }
    await fs.appendFile(lines(call.sessionID), JSON.stringify(call) + "\n")
  })
}

export function updateCall(sessionID: string, callID: string, update: Partial<Call>) {
  return queued(sessionID, async () => {
    await fs.mkdir(folder(sessionID), { recursive: true })
    await fs.appendFile(lines(sessionID), JSON.stringify({ callID, update }) + "\n")
  })
}

// A session's calls in the order they started, each merged with its updates.
export async function list(sessionID: string): Promise<Call[]> {
  const text = await fs.readFile(lines(sessionID), "utf8").catch(() => "")
  const calls = new Map<string, Call>()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let item: unknown
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    const record = item as Partial<Call> & { update?: Partial<Call> }
    if (!record.callID) continue
    if (record.update) {
      const found = calls.get(record.callID)
      if (found) calls.set(record.callID, { ...found, ...record.update })
      continue
    }
    calls.set(record.callID, record as Call)
  }
  return [...calls.values()].sort((a, b) => a.startedAt - b.startedAt)
}

export async function blob(sessionID: string, key: string) {
  return Bun.file(blobFile(sessionID, key))
    .text()
    .catch(() => undefined)
}

// The exact request body of a call, rebuilt from its stored parts.
export async function body(call: Call) {
  const keys = OperatorCallFormat.keysOf(call.request.body)
  const texts = new Map<string, string>()
  for (const key of new Set(keys)) {
    const text = await blob(call.sessionID, key)
    if (text !== undefined) texts.set(key, text)
  }
  return OperatorCallFormat.rebuild(call.request.body, (key) => texts.get(key))
}

// Each call's token accounting (call-accounting.ts), computed once its response is complete:
// `accounting.jsonl`, one `{ callID, accounting }` per line, the last line of a call wins. Kept beside
// the calls so the calls file stays as recorded; "Recount" clears it.
const accountingFile = (sessionID: string) => path.join(folder(sessionID), "accounting.jsonl")

export async function accounting(sessionID: string): Promise<Map<string, unknown>> {
  const text = await fs.readFile(accountingFile(sessionID), "utf8").catch(() => "")
  const found = new Map<string, unknown>()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as { callID?: string; accounting?: unknown }
      if (item.callID && item.accounting) found.set(item.callID, item.accounting)
    } catch {
      // a torn line: recomputed
    }
  }
  return found
}

export function saveAccounting(sessionID: string, items: ReadonlyArray<{ callID: string; accounting: unknown }>) {
  if (!items.length) return Promise.resolve()
  return queued(sessionID, async () => {
    await fs.mkdir(folder(sessionID), { recursive: true })
    await fs.appendFile(accountingFile(sessionID), items.map((item) => JSON.stringify(item)).join("\n") + "\n")
  })
}

export function clearAccounting(sessionID: string) {
  return queued(sessionID, () => fs.rm(accountingFile(sessionID), { force: true }))
}

export async function remove(sessionID: string) {
  queues.delete(sessionID)
  await fs.rm(folder(sessionID), { recursive: true, force: true })
  const latest = await readLatest()
  const kept = Object.fromEntries(Object.entries(latest).filter(([, value]) => value.sessionID !== sessionID))
  if (Object.keys(kept).length !== Object.keys(latest).length) await writeLatest(kept)
}

// Each agent's newest recorded call, per project.
type Latest = Record<string, { sessionID: string; callID: string; at: number }>
const latestFile = () => path.join(root(), "latest.json")
async function readLatest(): Promise<Latest> {
  return Bun.file(latestFile())
    .json()
    .catch(() => ({}))
}
async function writeLatest(latest: Latest) {
  await fs.mkdir(root(), { recursive: true })
  await Bun.write(latestFile(), JSON.stringify(latest, null, 2) + "\n")
}
let latestQueue: Promise<unknown> = Promise.resolve()
export function setLatest(projectKey: string, agent: string, value: { sessionID: string; callID: string; at: number }) {
  latestQueue = latestQueue.then(
    async () => {
      const latest = await readLatest()
      latest[`${projectKey}\n${agent}`] = value
      await writeLatest(latest)
    },
    () => undefined,
  )
  return latestQueue
}
export async function latest(projectKey: string, agent: string) {
  return (await readLatest())[`${projectKey}\n${agent}`]
}
