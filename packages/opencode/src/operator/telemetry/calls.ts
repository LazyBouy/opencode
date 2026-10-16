export * as OperatorTelemetryCalls from "./calls"

import { OperatorCallAccounting } from "../call-accounting"
import type { OperatorCallStore } from "../call-store"
import type { OperatorTelemetryIngest } from "./ingest"
import { OperatorTelemetryNames } from "./names"
import type { OperatorTelemetryStore } from "./store"

// Recorded model calls as spans (observability_spec.md §4.5, §5.1): one row per request, each attempt its own row,
// with its first byte, HTTP status and attempt number. The attempts of one step share its assistant message (a retry
// repeats the request; without a message, the retry chain links them), as the Transcript counts them (call-view.ts).
// The step's tokens and cost, as OpenCode counts them, go on its last attempt, the one that produced the message, so a
// turn's totals match the session's. The message's own row (`msg:`) is replaced. Kind decides the parent: agent calls
// sit under their turn, compaction calls under the compaction, title and summary calls beside the turn ("side calls"),
// unlinked calls under no turn.

const SIDE = new Set(["title", "summary"])
const STEP = new Set(["agent", "compaction"])

export function spans(input: {
  sessionID: string
  calls: ReadonlyArray<OperatorCallStore.Call>
  ingest: OperatorTelemetryIngest.Ingest
}): OperatorTelemetryStore.SpanWrite[] {
  const groupOf = new Map<string, string>()
  for (const call of input.calls)
    groupOf.set(
      call.callID,
      call.assistantMessageID ?? (call.retryOf ? (groupOf.get(call.retryOf) ?? call.retryOf) : call.callID),
    )
  const groups = new Map<string, string[]>()
  for (const call of input.calls) {
    const key = groupOf.get(call.callID)!
    groups.set(key, [...(groups.get(key) ?? []), call.callID])
  }
  return input.calls.map((call) => {
    const group = groups.get(groupOf.get(call.callID)!)!
    const attempt = group.indexOf(call.callID) + 1
    const attempts = group.length
    const last = attempt === attempts
    const assistant = call.assistantMessageID
      ? input.ingest.assistant(input.sessionID, call.assistantMessageID)
      : undefined
    const step = STEP.has(call.kind)
    if (call.assistantMessageID && step) input.ingest.recorded(input.sessionID, call.assistantMessageID)
    const owner = call.userMessageID ? input.ingest.owner(input.sessionID, call.userMessageID) : undefined
    const current = input.ingest.currentTurn(input.sessionID)
    // Not counted in turn or session totals: OpenCode doesn't count them in the session's either.
    const side = !step
    const place = step
      ? {
          turn: assistant?.turnID ?? owner?.turnID ?? current,
          parent: assistant?.parentID ?? owner?.parentID ?? current,
        }
      : SIDE.has(call.kind)
        ? { turn: owner?.turnID ?? current, parent: owner?.turnID ?? current }
        : { turn: undefined, parent: undefined }
    const http = call.httpStatus ?? call.error?.status
    const failed = !!call.error || (http ?? 0) >= 400 || !last
    const running = !call.finishedAt && !call.error
    const billed = OperatorCallAccounting.billed(call)
    // A step's numbers, as OpenCode counts them, on its last attempt (earlier attempts weren't counted); a side call
    // has what the provider reported.
    const usage =
      step && !last
        ? {}
        : step && assistant
          ? input.ingest.usage(assistant)
          : billed
            ? {
                tokens_input: Math.max(0, (billed.input ?? 0) - billed.read - billed.write),
                tokens_output: billed.output ?? 0,
                tokens_reasoning: billed.reasoning,
                tokens_cache_read: billed.read,
                tokens_cache_write: billed.write,
                ...(side && billed.cost !== undefined ? { cost: billed.cost } : {}),
                context_tokens: billed.input ?? 0,
              }
            : {}
    const errorType =
      http === 429
        ? "http_429"
        : http && http >= 400
          ? `http_${http}`
          : call.error
            ? "stream_error"
            : !last
              ? "retried"
              : undefined
    return {
      id: `call:${call.callID}`,
      kind: "model_call",
      name: OperatorTelemetryNames.name("model_call", call.model),
      parent_id: place.parent ?? null,
      turn_id: place.turn ?? null,
      session_id: input.sessionID,
      ...(call.directory ? { directory: call.directory } : {}),
      ...(call.projectKey ? { project_key: call.projectKey } : {}),
      ...(call.agent ? { agent: call.agent } : {}),
      ...(call.model ? { model: call.model } : {}),
      ...(call.providerID ? { provider: call.providerID } : {}),
      status: running ? "running" : failed ? "error" : "ok",
      ...(errorType && !running ? { error_type: errorType } : {}),
      ...(call.error?.message ? { error_message: call.error.message.slice(0, 500) } : {}),
      ...(http ? { http_status: http } : {}),
      ...(last && assistant?.finish ? { finish_reason: assistant.finish } : {}),
      start_ms: call.startedAt,
      ...(call.finishedAt
        ? {
            end_ms: call.finishedAt,
            duration_ms: Math.max(0, call.finishedAt - call.startedAt),
            active_ms: Math.max(0, call.finishedAt - call.startedAt),
          }
        : {}),
      ...(call.firstByteAt ? { ttft_ms: Math.max(0, call.firstByteAt - call.startedAt) } : {}),
      attempt,
      attempts,
      ...usage,
      ...(billed?.cost !== undefined ? { cost_billed: billed.cost } : {}),
      call_id: call.callID,
      ...(call.assistantMessageID ? { message_id: call.assistantMessageID } : {}),
      source: "recorded-call",
      attrs: JSON.stringify({ callKind: call.kind, ...(side ? { side: true } : {}) }),
    } satisfies OperatorTelemetryStore.SpanWrite
  })
}
