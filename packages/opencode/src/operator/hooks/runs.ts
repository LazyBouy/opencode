export * as OperatorHookRuns from "./runs"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorHookProtocol } from "./protocol"

// The run log (SPEC-0022 §9): one record per run, in `<data>/operator/hook-runs/<sessionID>.jsonl` (deleted
// with its session), Test runs in `tests.jsonl` (the last 200). The full stdin isn't stored: the tool input
// it carries may hold secrets and is in the session already; the input is kept only when a hook changed it.
// Each record is also announced (`operator.hook.ran`, sent by seams.ts) for the live views.

export const RAN = "operator.hook.ran"
const TESTS = "tests"
const TESTS_KEPT = 200

export const Outcome = Schema.Literals([
  "allowed",
  "denied",
  "changed",
  "context",
  "ok",
  "ok, with ignored fields",
  "failed",
  "timed out",
  "stopped by the server",
  "dropped",
]).annotate({ identifier: "OperatorHookOutcome" })
export type Outcome = typeof Outcome.Type

export const Run = Schema.Struct({
  id: Schema.String,
  time: Schema.Finite.annotate({ description: "When the run started (ms)" }),
  event: Schema.String,
  hook: Schema.String,
  level: Schema.String,
  file: Schema.String.annotate({ description: "The config file that declares the hook" }),
  sessionID: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String).annotate({ description: "The project's folder" }),
  agent: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  callID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String).annotate({ description: "The step's assistant message (step.before)" }),
  durationMs: Schema.optional(Schema.Finite),
  exitCode: Schema.optional(Schema.NullOr(Schema.Finite)),
  outcome: Outcome,
  reason: Schema.optional(Schema.String),
  ignored: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Answer fields the event doesn't use, ignored",
  }),
  before: Schema.optional(Schema.String).annotate({ description: "What a change replaced (first 8 KB)" }),
  after: Schema.optional(Schema.String).annotate({ description: "What it was changed to (first 8 KB)" }),
  context: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  dropped: Schema.optional(Schema.Finite).annotate({ description: "Watch runs dropped since the last one recorded" }),
  test: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OperatorHookRun" })
export type Run = typeof Run.Type

export const Filter = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  hook: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  test: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Finite),
  offset: Schema.optional(Schema.Finite),
})
export type Filter = typeof Filter.Type

const folder = () => path.join(Global.Path.data, "operator", "hook-runs")
const safe = (name: string) => name.replace(/[^\w-]/g, "_")
const fileOf = (key: string) => path.join(folder(), `${safe(key)}.jsonl`)

/** A run's id names its file: `hr.<sessionID or tests>.<random>`. */
export function newId(sessionID: string | undefined) {
  return `hr.${safe(sessionID ?? TESTS)}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
const keyOf = (id: string) => id.split(".")[1] ?? TESTS

const keep = (text: string | undefined) =>
  text === undefined || text === "" ? undefined : OperatorHookProtocol.cut(text, OperatorHookProtocol.LOG_LIMIT, "…")

/** A record with its texts cut to what the log keeps. */
export function trimmed(run: Run): Run {
  return {
    ...run,
    ...(run.before !== undefined ? { before: keep(run.before) } : {}),
    ...(run.after !== undefined ? { after: keep(run.after) } : {}),
    ...(run.stdout !== undefined ? { stdout: keep(run.stdout) } : {}),
    ...(run.stderr !== undefined ? { stderr: keep(run.stderr) } : {}),
  }
}

let writes: Promise<unknown> = Promise.resolve()

/** Where a recorded run is announced: set by seams.ts, which owns every tie to OpenCode. */
export const announce: { ran?: (run: Run) => void } = {}

/** Adds a run to its session's log (a Test run to the tests' log) and announces it. */
export function record(run: Run) {
  const value = trimmed(run)
  const key = value.test ? TESTS : (value.sessionID ?? TESTS)
  const next = writes.then(async () => {
    await fs.mkdir(folder(), { recursive: true })
    await fs.appendFile(fileOf(key), JSON.stringify(value) + "\n")
    if (key !== TESTS) return
    const lines = (await fs.readFile(fileOf(key), "utf8")).split("\n").filter(Boolean)
    if (lines.length > TESTS_KEPT * 2) await fs.writeFile(fileOf(key), lines.slice(-TESTS_KEPT).join("\n") + "\n")
  })
  writes = next.catch(() => undefined)
  announce.ran?.(value)
  return next
}

async function readFile(file: string): Promise<Run[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as Run]
    } catch {
      return [] // a line cut short by a crash
    }
  })
}

/** Runs, newest first, filtered and paged. */
export async function list(filter: Filter): Promise<{ runs: Run[]; total: number }> {
  await writes
  const files = filter.sessionID
    ? [fileOf(filter.sessionID)]
    : filter.test
      ? [fileOf(TESTS)]
      : (await fs.readdir(folder()).catch(() => [] as string[]))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => path.join(folder(), name))
  const all = (await Promise.all(files.map(readFile)))
    .flat()
    .filter((run) => filter.test === undefined || !!run.test === filter.test)
    .filter((run) => !filter.project || run.project === filter.project)
    .filter((run) => !filter.agent || run.agent === filter.agent)
    .filter((run) => !filter.hook || run.hook === filter.hook)
    .filter((run) => !filter.event || run.event === filter.event)
    .filter((run) => !filter.outcome || run.outcome === filter.outcome)
    .toSorted((a, b) => b.time - a.time)
  const offset = Math.max(0, filter.offset ?? 0)
  return { runs: all.slice(offset, offset + Math.min(500, Math.max(1, filter.limit ?? 100))), total: all.length }
}

export async function get(id: string): Promise<Run | undefined> {
  await writes
  return (await readFile(fileOf(keyOf(id)))).find((run) => run.id === id)
}

/** A deleted session's runs go with it. */
export function removeSession(sessionID: string) {
  return fs.rm(fileOf(sessionID), { force: true }).catch(() => undefined)
}
