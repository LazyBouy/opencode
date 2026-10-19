export * as OperatorTelemetrySchema from "./schema"

import { Schema } from "effect"
import { OperatorTelemetryAlerts as A } from "./alerts"

// What the telemetry API sends (observability_spec.md §7): the store's rows as they are stored (snake_case columns),
// so the page reads the same names the store and the export use.

const text = Schema.NullOr(Schema.String)
const number = Schema.NullOr(Schema.Finite)

export const Span = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable, from the source: turn:<message>, call:<call>, tool:<part>, …" }),
  seq: Schema.Finite.annotate({
    description: "Grows on every insert or update, server-wide (the live tail's `after`)",
  }),
  kind: Schema.String.annotate({
    description:
      "turn, model_call, tool_call, permission_wait, subagent, compaction, retry, helper_run, queue_item, alert",
  }),
  name: text.annotate({ description: "OpenTelemetry style: invoke_agent build, chat <model>, execute_tool bash" }),
  parent_id: text,
  turn_id: text,
  session_id: text,
  root_session_id: text.annotate({ description: "The top session (differs inside subagents)" }),
  project_key: text,
  directory: text,
  agent: text,
  agent_type: text.annotate({ description: "usual, subagent or helper" }),
  model: text,
  provider: text,
  tool: text,
  mcp_server: text,
  status: text.annotate({ description: "running, ok, error, denied, cancelled, interrupted" }),
  error_type: text,
  error_message: text.annotate({ description: "The error's own message, cut to 500 characters (never a body)" }),
  http_status: number,
  finish_reason: text,
  start_ms: number,
  end_ms: number,
  duration_ms: number,
  active_ms: number.annotate({ description: "Duration minus the approval waits inside it" }),
  wait_ms: number.annotate({ description: "Approval waits inside it" }),
  ttft_ms: number.annotate({ description: "Model calls: first byte minus start (recorded calls only)" }),
  attempt: number,
  attempts: number,
  tokens_input: number.annotate({ description: "Input without the cached part" }),
  tokens_output: number,
  tokens_reasoning: number,
  tokens_cache_read: number,
  tokens_cache_write: number,
  cost: number.annotate({ description: "OpenCode's estimate" }),
  cost_billed: number.annotate({ description: "The provider's billed cost, when the call has it" }),
  context_tokens: number,
  context_limit: number,
  decision: text,
  decision_source: text,
  decided_by: text,
  permission: text,
  pattern: text,
  args_hash: text,
  result_hash: text,
  loop: text.annotate({ description: "Turns: the possible-loop rule that matched" }),
  call_id: text,
  message_id: text,
  part_id: text,
  request_id: text,
  source: text,
  attrs: text.annotate({ description: "JSON: counts on turns, the call's kind, a helper run's purpose, …" }),
}).annotate({ identifier: "OperatorTelemetrySpan" })

export const SessionRow = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
  title: text,
  agent: text,
  agent_type: text,
  project_key: text,
  directory: text,
  parent_id: text,
  root_id: text,
  status: Schema.String.annotate({
    description: "running, waiting, idle, error, denied, stopped, interrupted, trash: the latest turn's, or Trash",
  }),
  first_ms: number,
  last_ms: number,
  turns: Schema.Finite,
  model_calls: Schema.Finite,
  tool_calls: Schema.Finite,
  errors: Schema.Finite,
  denials: Schema.Finite,
  retries: Schema.Finite,
  wait_ms: Schema.Finite,
  active_ms: Schema.Finite,
  tokens_input: Schema.Finite,
  tokens_output: Schema.Finite,
  tokens_reasoning: Schema.Finite,
  tokens_cache_read: Schema.Finite,
  tokens_cache_write: Schema.Finite,
  cost: Schema.Finite.annotate({ description: "Its own model calls" }),
  cost_total: Schema.Finite.annotate({ description: "With its subagents' sessions" }),
  cost_billed: number,
  loop: text,
  trashed: Schema.Finite,
  turn_start_ms: number,
  current: text.annotate({ description: "Running sessions: the newest running span's name" }),
  subagents: Schema.Finite,
  model: text.annotate({ description: "The model it used most" }),
  kept: Schema.optional(Schema.Boolean).annotate({ description: "Kept beyond retention" }),
}).annotate({ identifier: "OperatorTelemetrySessionRow" })

export const LogEntry = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
  time_ms: Schema.Finite,
  level: Schema.String,
  message: Schema.String,
  run: text,
  service: text,
  session_id: text,
  fields: text.annotate({ description: "JSON: the line's other fields" }),
}).annotate({ identifier: "OperatorTelemetryLogEntry" })

export const SpanPage = Schema.Struct({
  rows: Schema.Array(Span),
  nextCursor: Schema.optional(Schema.String),
  seq: Schema.Finite.annotate({ description: "The highest seq seen, for the next `after`" }),
  titles: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "The titles of the sessions the rows are in, by id",
  }),
}).annotate({ identifier: "OperatorTelemetrySpanPage" })

export const SessionPage = Schema.Struct({
  rows: Schema.Array(SessionRow),
  nextCursor: Schema.optional(Schema.String),
  total: Schema.Finite,
}).annotate({ identifier: "OperatorTelemetrySessionPage" })

export const LogPage = Schema.Struct({
  rows: Schema.Array(LogEntry),
  nextCursor: Schema.optional(Schema.String),
  seq: Schema.Finite,
}).annotate({ identifier: "OperatorTelemetryLogPage" })

export const Turn = Schema.Struct({
  span: Span,
  number: Schema.Finite.annotate({ description: "1-based, in the session" }),
  label: Schema.optional(Schema.String).annotate({
    description: "The first line of its prompt, read from the session (not stored); none when the session is gone",
  }),
}).annotate({ identifier: "OperatorTelemetryTurn" })

export const SessionDetail = Schema.Struct({
  session: SessionRow,
  turns: Schema.Array(Turn),
  earlier: Schema.Boolean.annotate({ description: "There are earlier turns (page back with `before`)" }),
}).annotate({ identifier: "OperatorTelemetrySessionDetail" })

export const TurnTree = Schema.Struct({
  turn: Span,
  spans: Schema.Array(Span).annotate({
    description:
      "Every span of the turn, in start order; `parent_id` builds the tree. A subagent's own turns are its session's",
  }),
}).annotate({ identifier: "OperatorTelemetryTurnTree" })

export const SpanDetail = Schema.Struct({
  span: Span,
  links: Schema.Struct({
    session: Schema.optional(Schema.String),
    turn: Schema.optional(Schema.String),
    call: Schema.optional(Schema.String).annotate({ description: "The recorded call (the Transcript)" }),
    decision: Schema.optional(Schema.String).annotate({ description: "The decision record's request id" }),
    message: Schema.optional(Schema.String),
    part: Schema.optional(Schema.String),
    child: Schema.optional(Schema.String).annotate({ description: "A subagent's session" }),
  }),
}).annotate({ identifier: "OperatorTelemetrySpanDetail" })

export const Facet = Schema.Struct({
  value: Schema.String,
  count: Schema.Finite,
}).annotate({ identifier: "OperatorTelemetryFacet" })

export const Progress = Schema.Struct({
  state: Schema.Literals(["idle", "running", "done", "failed"]),
  done: Schema.Finite,
  total: Schema.Finite,
  startedAt: Schema.optional(Schema.Finite),
  finishedAt: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorTelemetryBackfill" })

export const Storage = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Finite,
  spans: Schema.Finite,
  logs: Schema.Finite,
  sessions: Schema.Finite,
  oldestSpan: Schema.optional(Schema.Finite),
  dropped: Schema.Finite.annotate({ description: "Rows dropped because the backlog was full" }),
  kept: Schema.Finite.annotate({ description: "Sessions kept beyond retention" }),
  lastPurge: Schema.optional(Schema.Finite),
  eventsDays: Schema.Finite,
  totalsDays: Schema.Finite,
  logPath: Schema.String.annotate({ description: "The server log file the Logs tab keeps lines from" }),
  logLevel: Schema.String.annotate({ description: "The lowest level kept: error, warn or info" }),
  oldestLog: Schema.optional(Schema.Finite),
}).annotate({ identifier: "OperatorTelemetryStorage" })

export const MetricSeries = Schema.Struct({
  key: Schema.String.annotate({ description: "A value of the split (Other for the rest), or the line's name" }),
  label: Schema.String,
  points: Schema.Array(Schema.Array(Schema.NullOr(Schema.Finite))).annotate({
    description: "[time (ms, the step's start; a histogram's bucket index), value or null]",
  }),
  filter: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "The Events filter a point opens, besides the metric's kind and the step's time",
  }),
  line: Schema.optional(Schema.Boolean).annotate({ description: "Drawn as a line over the stacked series" }),
}).annotate({ identifier: "OperatorTelemetryMetricSeries" })

export const Metric = Schema.Struct({
  step: Schema.Finite.annotate({ description: "ms" }),
  from: Schema.Finite,
  to: Schema.Finite,
  source: Schema.Literals(["events", "totals"]),
  approx: Schema.Boolean.annotate({ description: "From hourly totals: percentiles estimated within a bucket" }),
  unit: Schema.Literals(["count", "ms", "percent", "usd", "tokens", "tps"]),
  kind: Schema.optional(Schema.String).annotate({ description: "The span kind a point opens in Events" }),
  series: Schema.Array(MetricSeries),
  other: Schema.Array(Schema.String).annotate({ description: "The values counted in Other" }),
  split: Schema.optional(Schema.String).annotate({
    description: "What the series' keys are values of, when split: status, decision, model, project, agent, …",
  }),
  table: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])))),
  ),
  buckets: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "A histogram's bucket labels" }),
  note: Schema.optional(Schema.Literals(["needs-events", "needs-recording"])),
  ignored: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Filters (or groupBy) hourly totals don't keep, so not applied",
  }),
}).annotate({ identifier: "OperatorTelemetryMetric" })

export const AlertScope = Schema.Struct({
  ns: Schema.optional(Schema.String),
  dir: Schema.optional(Schema.String).annotate({ description: "A project key" }),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorTelemetryAlertScope" })

export const AlertRuleInput = Schema.Struct({
  name: Schema.String,
  metric: Schema.Literals(A.METRICS),
  op: Schema.Literals(A.OPS),
  threshold: Schema.Finite.annotate({ description: "In the metric's unit: %, count, minutes, seconds or $" }),
  window: Schema.Literals(A.WINDOWS).annotate({ description: "Minutes, or today (local midnight to now)" }),
  minCount: Schema.optional(Schema.Finite).annotate({
    description: "The fewest events in the window before it can fire (ratios and percentiles)",
  }),
  consecutive: Schema.Finite.annotate({ description: "Evaluations in a row the condition must hold: 1 to 10" }),
  scope: AlertScope,
  severity: Schema.Literals(A.SEVERITIES),
  enabled: Schema.Boolean,
}).annotate({ identifier: "OperatorTelemetryAlertRuleInput" })

export const AlertRule = Schema.Struct({
  ...AlertRuleInput.fields,
  id: Schema.String,
  builtin: Schema.optional(Schema.String).annotate({
    description: "A built-in rule: edit, turn off or reset; not delete",
  }),
  mute: Schema.optional(
    Schema.Struct({ until: Schema.optional(Schema.Finite) }).annotate({
      description: "Muted until a time, or (no until) until turned back on",
    }),
  ),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "OperatorTelemetryAlertRule" })

export const AlertState = Schema.Struct({
  state: Schema.Literals(A.STATES),
  streak: Schema.Finite,
  clear: Schema.Finite,
  value: Schema.NullOr(Schema.Finite),
  count: Schema.NullOr(Schema.Finite),
  evaluated_ms: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String).annotate({ description: "Why it couldn't be evaluated" }),
  event_id: Schema.NullOr(Schema.String),
  last_fired_ms: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "OperatorTelemetryAlertState" })

export const AlertRuleView = Schema.Struct({
  rule: AlertRule,
  state: AlertState,
  muted: Schema.Boolean,
}).annotate({ identifier: "OperatorTelemetryAlertRuleView" })

export const AlertEvent = Schema.Struct({
  id: Schema.String,
  rule_id: Schema.String,
  name: Schema.String,
  severity: Schema.String,
  metric: Schema.String,
  op: Schema.String,
  threshold: Schema.Finite,
  win: Schema.String,
  start_ms: Schema.Finite,
  end_ms: Schema.NullOr(Schema.Finite).annotate({ description: "When it resolved; null while firing" }),
  value: Schema.NullOr(Schema.Finite).annotate({ description: "The value when it fired" }),
  worst: Schema.NullOr(Schema.Finite),
  scope: Schema.Record(Schema.String, Schema.String),
  link: Schema.Record(Schema.String, Schema.String).annotate({ description: "The Events filter for View events" }),
  ack_by: Schema.NullOr(Schema.String),
  ack_ms: Schema.NullOr(Schema.Finite),
  muted: Schema.Boolean.annotate({ description: "Its rule is muted now" }),
}).annotate({ identifier: "OperatorTelemetryAlertEvent" })

/** The shared filter (§7.2), as query parameters: lists comma-separated, numbers as text. */
export const FilterQuery = {
  range: Schema.optional(Schema.String).annotate({
    description: "15m, 1h, 6h, 24h, 7d, 14d, 30d, 90d, 365d (default 24h)",
  }),
  from: Schema.optional(Schema.String).annotate({ description: "Unix ms, instead of range" }),
  to: Schema.optional(Schema.String).annotate({ description: "Unix ms, instead of range" }),
  ns: Schema.optional(Schema.String).annotate({
    description: "A namespace: its projects (projects in none count under OpenCode)",
  }),
  dir: Schema.optional(Schema.String).annotate({ description: "A project key" }),
  session: Schema.optional(Schema.String).annotate({ description: "A session id; matches its subagents too" }),
  agent: Schema.optional(Schema.String),
  agentType: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  mcp: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  errorType: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
  decision: Schema.optional(Schema.String),
  minCost: Schema.optional(Schema.String),
  maxCost: Schema.optional(Schema.String),
  minDuration: Schema.optional(Schema.String).annotate({ description: "ms, against active time" }),
  maxDuration: Schema.optional(Schema.String),
  minTokens: Schema.optional(Schema.String),
  loop: Schema.optional(Schema.String).annotate({ description: "1: turns flagged as possible loops" }),
  http: Schema.optional(Schema.String).annotate({ description: "HTTP statuses, e.g. 429 or 5xx" }),
  q: Schema.optional(Schema.String).annotate({
    description: "Text in names, titles, errors, tools, models and agents",
  }),
  roots: Schema.optional(Schema.String).annotate({
    description: "Sessions: 1 (default) top sessions only; 0 subagents too",
  }),
  sessionStatus: Schema.optional(Schema.String),
  stuck: Schema.optional(Schema.String).annotate({
    description: "Sessions: 1 = running, no new span for the stuck threshold, no approval waiting",
  }),
}
