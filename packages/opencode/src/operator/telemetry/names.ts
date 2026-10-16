export * as OperatorTelemetryNames from "./names"

import type { OperatorTelemetryStore } from "./store"

// Span names and attributes after the OpenTelemetry GenAI semantic conventions (observability_spec.md §4.6), so a
// later OTLP export is a translation, not a redesign. Nothing is exported in v1. The conventions are still
// "Development" status and changed in September and October 2026: this follows
// open-telemetry/semantic-conventions-genai as of 2026-10-06, after PR #521.
export const CONVENTION = "open-telemetry/semantic-conventions-genai@2026-10-06 (after #521)"

/** A span's display name: `invoke_agent build`, `chat claude-sonnet-4-5`, `execute_tool bash`, ... */
export function name(kind: OperatorTelemetryStore.Kind, subject?: string) {
  const of = (prefix: string) => (subject ? `${prefix} ${subject}` : prefix)
  switch (kind) {
    case "turn":
    case "subagent":
    case "helper_run":
      return of("invoke_agent")
    case "model_call":
      return of("chat")
    case "tool_call":
      return of("execute_tool")
    case "permission_wait":
      return of("approval")
    case "compaction":
      return "gen_ai.conversation.compacted"
    case "retry":
      return of("retry")
    case "queue_item":
      return of("queued message")
    case "alert":
      return of("alert")
  }
}

/** Each column's OpenTelemetry attribute, where it has one (times in ms here, in seconds there). */
export const ATTRIBUTES: Partial<Record<keyof OperatorTelemetryStore.Span, string>> = {
  root_session_id: "gen_ai.conversation.id",
  agent: "gen_ai.agent.name",
  model: "gen_ai.request.model",
  provider: "gen_ai.provider.name",
  tool: "gen_ai.tool.name",
  call_id: "gen_ai.tool.call.id",
  finish_reason: "gen_ai.response.finish_reasons",
  tokens_input: "gen_ai.usage.input_tokens",
  tokens_output: "gen_ai.usage.output_tokens",
  tokens_reasoning: "gen_ai.usage.reasoning.output_tokens",
  tokens_cache_read: "gen_ai.usage.cache_read.input_tokens",
  tokens_cache_write: "gen_ai.usage.cache_creation.input_tokens",
  ttft_ms: "gen_ai.response.time_to_first_chunk",
  error_type: "error.type",
  http_status: "http.response.status_code",
}
