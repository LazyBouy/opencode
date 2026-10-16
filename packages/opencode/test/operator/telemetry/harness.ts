import path from "path"
import { OperatorTelemetryBatch } from "@/operator/telemetry/batch"
import { OperatorTelemetryDerive } from "@/operator/telemetry/derive"
import { OperatorTelemetryIngest } from "@/operator/telemetry/ingest"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorTelemetryWriter } from "@/operator/telemetry/writer"

// A telemetry store fed by hand-made events (observability_spec.md §21.1): events in, a flush, rows out.

export function harness(dir: string, options: { limit?: number; loops?: Partial<OperatorTelemetryDerive.Loops> } = {}) {
  const store = new OperatorTelemetryStore.Store(path.join(dir, "telemetry.sqlite"))
  let batch = new OperatorTelemetryBatch.Batch(options.limit)
  let now = 1_700_000_000_000
  const contexts = new Map<string, OperatorTelemetryDerive.Context>()
  const ingest = new OperatorTelemetryIngest.Ingest(() => batch, { secret: store.meta("secret")!, now: () => now })
  const loops = { ...OperatorTelemetryDerive.DEFAULT_LOOPS, ...options.loops }
  const flush = () => {
    const taken = batch
    batch = new OperatorTelemetryBatch.Batch(options.limit)
    OperatorTelemetryWriter.apply(store, taken, {
      contextOf: (id) => contexts.get(id) ?? {},
      loops,
      now,
    })
    return taken
  }
  const event = (type: string, properties: Record<string, unknown>, directory = "/work/app") =>
    ingest.handle({ directory, payload: { type, properties } })
  const at = (time: number) => {
    now = time
  }
  return { store, ingest, flush, event, at, contexts, batch: () => batch, now: () => now, loops }
}

export type Harness = ReturnType<typeof harness>

export const T0 = 1_700_000_000_000

// ---- events, as the server emits them ----

export function user(
  h: Harness,
  sessionID: string,
  id: string,
  created: number,
  text = "Fix the test",
  agent = "build",
) {
  h.event("message.updated", {
    sessionID,
    info: {
      id,
      sessionID,
      role: "user",
      time: { created },
      agent,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    },
  })
  h.event("message.part.updated", {
    sessionID,
    part: { id: `prt_${id}`, sessionID, messageID: id, type: "text", text },
    time: created,
  })
}

export function assistant(
  h: Harness,
  sessionID: string,
  id: string,
  parentID: string,
  fields: {
    created: number
    completed?: number
    error?: { name: string; data?: Record<string, unknown> }
    finish?: string
    cost?: number
    tokens?: { input: number; output: number; reasoning?: number; read?: number; write?: number }
    mode?: string
    agent?: string
  },
) {
  const tokens = fields.tokens ?? { input: 0, output: 0 }
  h.event("message.updated", {
    sessionID,
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID,
      time: { created: fields.created, ...(fields.completed ? { completed: fields.completed } : {}) },
      ...(fields.error ? { error: fields.error } : {}),
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: fields.mode ?? "build",
      agent: fields.agent ?? "build",
      path: { cwd: "/work/app", root: "/work/app" },
      cost: fields.cost ?? 0,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning ?? 0,
        cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
      },
      ...(fields.finish ? { finish: fields.finish } : {}),
    },
  })
}

export function tool(
  h: Harness,
  sessionID: string,
  messageID: string,
  partID: string,
  name: string,
  state: Record<string, unknown>,
  callID = `call_${partID}`,
) {
  h.event("message.part.updated", {
    sessionID,
    part: { id: partID, sessionID, messageID, type: "tool", callID, tool: name, state },
    time: h.now(),
  })
}

export function idle(h: Harness, sessionID: string) {
  h.event("session.status", { sessionID, status: { type: "idle" } })
}
