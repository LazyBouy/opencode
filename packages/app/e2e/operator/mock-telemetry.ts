import type { Route } from "@playwright/test"

// Observability's API for the e2e mock (observability_spec.md §7): seeded sessions, turns and spans, answered as the
// server would (sorting, roots, paging with a cursor, facets), with every query recorded.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
type Row = Record<string, any>

// ---- metrics (§12): synthetic series on the server's steps and frames ----

const RANGES: Record<string, number> = {
  "15m": 15 * MIN,
  "1h": HOUR,
  "6h": 6 * HOUR,
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
  "365d": 365 * DAY,
}
const stepOf = (length: number, beyond: boolean) => {
  const step =
    length <= 15 * MIN
      ? 15_000
      : length <= HOUR
        ? MIN
        : length <= 6 * HOUR
          ? 5 * MIN
          : length <= DAY
            ? 15 * MIN
            : length <= 7 * DAY
              ? HOUR
              : length <= 30 * DAY
                ? 6 * HOUR
                : DAY
  return beyond ? Math.max(HOUR, step) : step
}
const UNITS: Record<string, string> = {
  turn_error_rate: "percent",
  turn_active: "ms",
  turn_wait: "ms",
  call_duration: "ms",
  ttft: "ms",
  output_speed: "tps",
  tokens: "tokens",
  cache_hit: "percent",
  cost: "usd",
  cost_per_turn: "usd",
  cost_billed: "usd",
  helper_cost: "usd",
  approval_wait: "ms",
  approval_oldest: "ms",
  queue_oldest: "ms",
  queue_wait: "ms",
  context_used: "tokens",
  mcp_errors: "percent",
}
const KINDS: Record<string, string> = {
  turns: "turn",
  turn_error_rate: "turn",
  turn_active: "turn",
  turn_wait: "turn",
  calls: "model_call",
  call_errors: "model_call",
  call_duration: "model_call",
  output_speed: "model_call",
  tokens: "model_call",
  cache_hit: "model_call",
  cost: "model_call",
  tool_calls: "tool_call",
  tool_errors: "tool_call",
  tool_table: "tool_call",
}
// A chart's own split and lines; anything else is one "p50"/"calls"-style line.
const SHAPES: Record<string, { split?: string; keys: string[]; filters?: Array<Record<string, string>> }> = {
  turns: { split: "status", keys: ["ok", "error"], filters: [{ status: "ok" }, { status: "error" }] },
  turn_active: { keys: ["ok_p50", "ok_p95", "failed_p50", "failed_p95"] },
  call_errors: {
    keys: ["errors", "http_429", "retries_exhausted"],
    filters: [{ status: "error" }, { http: "429" }, {}],
  },
  tokens: { keys: ["input", "cache_read", "cache_write", "output", "reasoning"] },
  cache_hit: {
    split: "model",
    keys: ["gpt-5", "claude-sonnet-4-5"],
    filters: [{ model: "gpt-5" }, { model: "claude-sonnet-4-5" }],
  },
  context_used: { split: "providerModel", keys: ["openai/gpt-5"] },
  tool_calls: { split: "tool", keys: ["bash", "edit"], filters: [{ tool: "bash" }, { tool: "edit" }] },
  approvals: { split: "decision", keys: ["allow", "deny"] },
  calls: { keys: ["calls"] },
}
const HISTOGRAMS = new Set(["calls_per_turn", "tools_per_turn"])

export function metricOf(q: URLSearchParams, now: number) {
  const metric = q.get("metric") ?? ""
  const from = q.get("from") ? Number(q.get("from")) : now - (RANGES[q.get("range") ?? "24h"] ?? DAY)
  const to = q.get("to") ? Number(q.get("to")) : now + 1
  const beyond = from < now - 30 * DAY
  const length = q.get("from") ? to - from : (RANGES[q.get("range") ?? "24h"] ?? DAY)
  const step = q.get("step") ? Number(q.get("step")) : stepOf(length, beyond)
  const start = Math.floor(from / step) * step
  const count = Math.max(1, Math.ceil((to - start) / step))
  const unit = UNITS[metric] ?? "count"
  const scale = unit === "ms" ? 1000 : unit === "usd" ? 0.01 : unit === "tokens" ? 1000 : unit === "percent" ? 10 : 1
  const head = {
    step,
    from: start,
    to: start + count * step,
    source: beyond ? "totals" : "events",
    approx: beyond,
    unit,
    ...(KINDS[metric] ? { kind: KINDS[metric] } : {}),
    other: [] as string[],
  }
  if (metric === "ttft") return { ...head, series: [], note: "needs-recording" }
  if (metric === "tool_table")
    return {
      ...head,
      series: [],
      table: [
        { tool: "bash", mcp: 0, calls: 12, errors: 2, error_rate: 16.7, denials: 1, p50: 800, p95: 4000, wait: 300 },
        { tool: "github", mcp: 1, calls: 3, errors: 0, error_rate: 0, denials: 0, p50: 400, p95: 900, wait: 0 },
      ],
    }
  if (metric === "approval_table")
    return {
      ...head,
      series: [],
      table: [{ permission: "bash", requests: 5, allowed: 80, p95: 60_000, decided_by: "user" }],
    }
  if (HISTOGRAMS.has(metric))
    return {
      ...head,
      kind: "turn",
      buckets: ["1", "2", "4", "8", "16", "32", "64", "128+"],
      series: [
        { key: "turns", label: "turns", points: [3, 5, 2, 1, 0, 0, 0, 0].map((value, index) => [index, value]) },
      ],
    }
  const points = (offset: number) =>
    Array.from({ length: count }, (_, index) => [start + index * step, (1 + ((index + offset) % 4)) * scale])
  const groupBy = q.get("groupBy")
  if (groupBy) {
    const keys = ["gpt-5", "claude-sonnet-4-5", "Other"]
    return {
      ...head,
      split: groupBy,
      other: ["gemini-2.5-pro", "grok-4"],
      series: keys.map((key, at) => ({
        key,
        label: key,
        points: points(at),
        ...(key === "Other" ? {} : { filter: { [groupBy]: key } }),
      })),
    }
  }
  const shape = SHAPES[metric] ?? { keys: [metric.includes("wait") || unit === "ms" ? "p50" : metric] }
  return {
    ...head,
    ...(shape.split ? { split: shape.split } : {}),
    series: shape.keys.map((key, at) => ({
      key,
      label: key,
      points: points(at),
      ...(shape.filters?.[at] ? { filter: shape.filters[at] } : {}),
    })),
  }
}

const tokens = (input = 0, output = 0, read = 0, write = 0) => ({
  tokens_input: input,
  tokens_output: output,
  tokens_reasoning: 0,
  tokens_cache_read: read,
  tokens_cache_write: write,
})

function sessionRow(id: string, fields: Row): Row {
  return {
    id,
    seq: 1,
    title: id,
    agent: "build",
    agent_type: "usual",
    project_key: "/workspace/opencode",
    directory: "/workspace/opencode",
    parent_id: null,
    root_id: id,
    status: "idle",
    first_ms: 0,
    last_ms: 0,
    turns: 1,
    model_calls: 1,
    tool_calls: 0,
    errors: 0,
    denials: 0,
    retries: 0,
    wait_ms: 0,
    active_ms: 1000,
    ...tokens(),
    cost: 0,
    cost_total: 0,
    cost_billed: null,
    loop: null,
    trashed: 0,
    turn_start_ms: null,
    current: null,
    subagents: 0,
    model: "claude-sonnet-4-5",
    kept: false,
    ...fields,
  }
}

const SPAN_DEFAULTS: Row = {
  seq: 1,
  parent_id: null,
  turn_id: null,
  session_id: null,
  root_session_id: null,
  project_key: "/workspace/opencode",
  directory: "/workspace/opencode",
  agent: "build",
  agent_type: "usual",
  model: null,
  provider: null,
  tool: null,
  mcp_server: null,
  status: "ok",
  error_type: null,
  error_message: null,
  http_status: null,
  finish_reason: null,
  end_ms: null,
  duration_ms: null,
  active_ms: null,
  wait_ms: null,
  ttft_ms: null,
  attempt: null,
  attempts: null,
  ...tokens(),
  cost: null,
  cost_billed: null,
  context_tokens: null,
  context_limit: null,
  decision: null,
  decision_source: null,
  decided_by: null,
  permission: null,
  pattern: null,
  args_hash: null,
  result_hash: null,
  loop: null,
  call_id: null,
  message_id: null,
  part_id: null,
  request_id: null,
  source: "message",
  attrs: null,
}
const spanRow = (id: string, kind: string, fields: Row): Row => ({ ...SPAN_DEFAULTS, id, kind, name: id, ...fields })

export type TelemetryMock = ReturnType<typeof createTelemetryMock>["state"]

const BUILTIN_VIEWS = [
  ["errors", "events", { status: "error", sort: "start:desc" }],
  ["denied", "events", { status: "denied", sort: "start:desc" }],
  ["awaiting", "events", { kind: "permission_wait", status: "running", sort: "start:asc" }],
  ["rate_limited", "events", { http: "429", sort: "start:desc" }],
  ["expensive", "sessions", { sort: "cost:desc" }],
  ["slow_turns", "events", { kind: "turn", sort: "active:desc" }],
  ["loops", "events", { kind: "turn", loop: "1", sort: "start:desc" }],
  ["interrupted", "events", { status: "interrupted", sort: "start:desc" }],
  ["failing_tools", "events", { kind: "tool_call", status: "error", sort: "start:desc" }],
].map(([key, tab, params]) => ({
  id: `builtin-${key}`,
  name: key,
  builtin: key,
  state: { tab, params, ...(key === "failing_tools" ? { facets: true, expand: ["tool"] } : {}) },
  createdAt: 0,
  updatedAt: 0,
}))

type TrashEntry = {
  id: string
  kind: string
  name: string
  deletedAt: number
  files: { path: string; stored: string }[]
}

// Alerts (§14): the built-in rules and one of the user's, firing now; its history.
const ALERT_INPUT = { window: "15", consecutive: 1, scope: {}, severity: "warning", enabled: true }
function alertRules(now: number): Row[] {
  const state = (fields: Row = {}) => ({
    state: "ok",
    streak: 0,
    clear: 0,
    value: 0,
    count: 0,
    evaluated_ms: now - 30_000,
    error: null,
    event_id: null,
    last_fired_ms: null,
    ...fields,
  })
  const builtin = (builtin: string, name: string, metric: string, op: string, threshold: number, extra: Row = {}) => ({
    rule: {
      ...ALERT_INPUT,
      id: `builtin-${builtin}`,
      builtin,
      name,
      metric,
      op,
      threshold,
      createdAt: 0,
      updatedAt: 0,
      ...extra,
    },
    state: state(extra.enabled === false ? { state: "disabled" } : {}),
    muted: false,
  })
  return [
    builtin("approval_waiting", "Approval waiting long", "oldest_approval", ">", 10),
    builtin("calls_failing", "Model calls failing", "call_error_rate", ">", 20, { minCount: 10, severity: "critical" }),
    builtin("rate_limited", "Rate limited", "rate_limits", ">=", 5),
    builtin("daily_cost", "Daily cost", "cost", ">", 0, { window: "today", enabled: false }),
    {
      rule: {
        ...ALERT_INPUT,
        id: "rule-denials",
        name: "Too many denials",
        metric: "denials",
        op: ">=",
        threshold: 3,
        severity: "critical",
        scope: { agent: "build" },
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000,
      },
      state: state({ state: "firing", value: 4, event_id: "alert-1", last_fired_ms: now - 5 * MIN, streak: 3 }),
      muted: false,
    },
  ]
}

export function createTelemetryMock(now: number, hooks: { trash?: (entry: TrashEntry) => void } = {}) {
  const t0 = now - 30 * MIN
  // The busy session: 22 turns (the latest 20 first), its last with a tool call that waited for approval, a model call
  // that hit a rate limit and its retry, and a subagent.
  const main = "ses_main"
  const child = "ses_child"
  const turns: Row[] = Array.from({ length: 22 }, (_, i) =>
    spanRow(`turn:msg_u${i + 1}`, "turn", {
      name: "invoke_agent build",
      session_id: main,
      root_session_id: main,
      turn_id: `turn:msg_u${i + 1}`,
      start_ms: t0 + i * MIN,
      end_ms: t0 + i * MIN + 50_000,
      duration_ms: 50_000,
      active_ms: i === 21 ? 20_000 : 50_000,
      wait_ms: i === 21 ? 30_000 : 0,
      status: i === 21 ? "error" : "ok",
      error_type: i === 21 ? "APIError" : null,
      message_id: `msg_u${i + 1}`,
      cost: 0.01,
      attrs: JSON.stringify({ modelCalls: i === 21 ? 3 : 1, toolCalls: i === 21 ? 2 : 0, retries: i === 21 ? 1 : 0 }),
    }),
  )
  const last = turns[21]!
  const lastID = last.id as string
  const start = last.start_ms as number
  const spans: Row[] = [
    spanRow("call:c1", "model_call", {
      name: "chat claude-sonnet-4-5",
      session_id: main,
      turn_id: lastID,
      parent_id: lastID,
      start_ms: start + 500,
      end_ms: start + 3_500,
      duration_ms: 3000,
      active_ms: 3000,
      ttft_ms: 800,
      attempt: 1,
      attempts: 1,
      message_id: "msg_a1",
      call_id: "c1",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      http_status: 200,
      source: "recorded-call",
      ...tokens(1200, 300, 5000, 0),
      cost: 0.004,
    }),
    spanRow("tool:bash", "tool_call", {
      name: "execute_tool bash",
      tool: "bash",
      session_id: main,
      turn_id: lastID,
      parent_id: lastID,
      start_ms: start + 4_000,
      end_ms: start + 40_000,
      duration_ms: 36_000,
      wait_ms: 30_000,
      active_ms: 6_000,
      part_id: "prt_bash",
      call_id: "toolu_bash",
      source: "part",
    }),
    spanRow("perm:per_1", "permission_wait", {
      name: "approval bash (git push*)",
      session_id: main,
      turn_id: lastID,
      parent_id: "tool:bash",
      start_ms: start + 5_000,
      end_ms: start + 35_000,
      duration_ms: 30_000,
      wait_ms: 30_000,
      decision: "allow",
      decided_by: "me",
      decision_source: "user",
      permission: "bash",
      pattern: "git push*",
      request_id: "per_1",
      source: "decision",
    }),
    spanRow("call:c2", "model_call", {
      name: "chat claude-sonnet-4-5",
      session_id: main,
      turn_id: lastID,
      parent_id: lastID,
      start_ms: start + 41_000,
      end_ms: start + 41_500,
      duration_ms: 500,
      attempt: 1,
      attempts: 2,
      message_id: "msg_a2",
      call_id: "c2",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      http_status: 429,
      status: "error",
      error_type: "http_429",
      source: "recorded-call",
    }),
    spanRow("call:c3", "model_call", {
      name: "chat claude-sonnet-4-5",
      session_id: main,
      turn_id: lastID,
      parent_id: lastID,
      start_ms: start + 45_000,
      end_ms: start + 48_000,
      duration_ms: 3000,
      active_ms: 3000,
      ttft_ms: 600,
      attempt: 2,
      attempts: 2,
      message_id: "msg_a2",
      call_id: "c3",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      http_status: 200,
      source: "recorded-call",
      ...tokens(1500, 200),
      cost: 0.006,
    }),
    spanRow("tool:task", "tool_call", {
      name: "execute_tool task",
      tool: "task",
      session_id: main,
      turn_id: lastID,
      parent_id: lastID,
      start_ms: start + 42_000,
      end_ms: start + 49_000,
      duration_ms: 7000,
      active_ms: 7000,
      part_id: "prt_task",
      source: "part",
    }),
    spanRow(`sub:${child}`, "subagent", {
      name: "invoke_agent explore",
      agent: "explore",
      session_id: main,
      turn_id: lastID,
      parent_id: "tool:task",
      start_ms: start + 42_100,
      end_ms: start + 48_900,
      duration_ms: 6800,
      part_id: "prt_task",
      source: "part",
      attrs: JSON.stringify({ sessionID: child }),
    }),
  ]
  const childTurn = spanRow("turn:msg_cu", "turn", {
    name: "invoke_agent explore",
    agent: "explore",
    agent_type: "subagent",
    session_id: child,
    root_session_id: main,
    turn_id: "turn:msg_cu",
    parent_id: `sub:${child}`,
    start_ms: start + 42_200,
    end_ms: start + 48_800,
    duration_ms: 6600,
    active_ms: 6600,
    message_id: "msg_cu",
  })
  const sessions: Row[] = [
    sessionRow(main, {
      title: "Fix the failing test",
      status: "error",
      first_ms: t0,
      last_ms: start + 50_000,
      turns: 22,
      model_calls: 24,
      tool_calls: 2,
      errors: 1,
      retries: 1,
      wait_ms: 30_000,
      active_ms: 1_070_000,
      cost: 0.22,
      cost_total: 0.25,
      subagents: 1,
      ...tokens(9000, 2000, 40000, 1000),
    }),
    sessionRow(child, {
      title: "explore",
      agent: "explore",
      agent_type: "subagent",
      parent_id: main,
      root_id: main,
      first_ms: start + 42_200,
      last_ms: start + 48_800,
      cost: 0.03,
      cost_total: 0.03,
    }),
    ...Array.from({ length: 60 }, (_, i) =>
      sessionRow(`ses_${String(i).padStart(2, "0")}`, {
        title: `Session ${i}`,
        first_ms: t0 - (i + 1) * MIN,
        last_ms: t0 - i * MIN,
        cost: i / 100,
        cost_total: i / 100,
        status: i === 3 ? "running" : "idle",
      }),
    ),
  ]
  const turnsOf: Record<string, Row[]> = { [main]: turns, [child]: [childTurn] }
  const spansOf: Record<string, Row[]> = { [lastID]: spans, "turn:msg_cu": [] }
  const labels: Record<string, string> = {
    msg_u22: "Now run the whole suite\nand report",
    msg_cu: "Look for the test file",
  }
  // Every span, for Events, each with its seq (a write bumps it, as the store does).
  let seq = 0
  const all: Row[] = [...turns, ...spans, childTurn].map((span) => ({ ...span, seq: ++seq }))
  const logs: Row[] = [
    {
      id: "log:1:0",
      seq: ++seq,
      time_ms: now - 20 * MIN,
      level: "WARN",
      message: "failed to materialize reference",
      run: "r1",
      service: "skill",
      session_id: null,
      fields: JSON.stringify({ name: "effect", repository: "github.com/x/y" }),
    },
    {
      id: "log:1:100",
      seq: ++seq,
      time_ms: now - 10 * MIN,
      level: "ERROR",
      message: "stream error",
      run: "r1",
      service: "llm",
      session_id: main,
      fields: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", "error.message": "overloaded" }),
    },
  ]
  const alertEvent = (fields: Row): Row => ({
    rule_id: "rule-denials",
    name: "Too many denials",
    severity: "critical",
    metric: "denials",
    op: ">=",
    threshold: 3,
    win: "15",
    end_ms: null,
    value: 3,
    worst: 4,
    scope: { agent: "build" },
    link: { kind: "tool_call", status: "denied", agent: "build" },
    ack_by: null,
    ack_ms: null,
    muted: false,
    ...fields,
  })
  const state = {
    rules: alertRules(now),
    alerts: [
      alertEvent({ id: "alert-1", start_ms: now - 5 * MIN }),
      alertEvent({ id: "alert-0", start_ms: now - 3 * 60 * MIN, end_ms: now - 2 * 60 * MIN, value: 5, worst: 6 }),
    ],
    /** Every write to the alert API. */
    alertWrites: [] as Array<{ method: string; path: string; body: unknown }>,
    views: BUILTIN_VIEWS.map((view) => ({ ...view })) as Row[],
    /** Records in Trash, by Trash id, to bring back on restore. */
    trashed: new Map<string, { kind: string; record: Row }>(),
    settings: {
      enabled: true,
      eventsDays: 30,
      totalsDays: 400,
      logLevel: "warn",
      loops: { sameCallSameResult: 3, sameCall: 5, toolCalls: 50, modelCalls: 30 },
      dailyBudget: null as number | null,
      stuckMinutes: 10,
      queueMinutes: 10,
      recordCalls: true,
      limits: { eventsDays: { min: 1, max: 365 }, totalsDays: { min: 30, max: 1825 } },
    },
    /** Every write to views, settings and Clear, and every export asked for. */
    writes: [] as Array<{ method: string; path: string; body: unknown; params?: URLSearchParams }>,
    /** Rows the export count says match (for the 100,000-row limit). */
    exportRows: 42,
    queries: [] as Array<{ path: string; params: URLSearchParams }>,
    sessions,
    kept: new Set<string>(),
    backfill: { state: "done" as string, done: 64, total: 64 },
    spans: all,
    logs,
    /** A span written now (new, or changed): it gets the next seq. */
    write(span: Row) {
      const at = all.findIndex((item) => item.id === span.id)
      const next = { ...(at >= 0 ? all[at] : SPAN_DEFAULTS), ...span, seq: ++seq }
      if (at >= 0) all[at] = next
      else all.push(next)
      return next
    },
  }

  const sortOf = (sort: string | null) => {
    const [column, way] = (sort ?? "lastActivity:desc").split(":")
    const key: Record<string, string> = {
      lastActivity: "last_ms",
      started: "first_ms",
      cost: "cost_total",
      title: "title",
      turns: "turns",
      status: "status",
      agent: "agent",
    }
    return { key: key[column ?? ""] ?? "last_ms", down: way !== "asc" }
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

  const phase8 = (route: Route, path: string, method: string, q: URLSearchParams) => {
    const body = (() => {
      try {
        return route.request().postDataJSON() as Row | null
      } catch {
        return null
      }
    })()
    if (method !== "GET" || path.startsWith("/export")) state.writes.push({ method, path, body, params: q })
    if (path === "/view" && method === "GET") return json(route, state.views)
    if (path === "/view" && method === "POST") {
      const made = {
        ...body,
        id: `view-${state.views.length + 1}`,
        createdBy: "operator",
        createdAt: now,
        updatedAt: now,
      }
      state.views.push(made)
      return json(route, made)
    }
    const view = path.match(/^\/view\/([^/]+)$/)
    if (view) {
      const found = state.views.find((item) => item.id === view[1])
      if (!found) return json(route, { name: "OperatorTelemetryNotFoundError", data: { message: "none" } }, 404)
      if (found.builtin)
        return json(
          route,
          { name: "OperatorTelemetryInvalidError", data: { message: "Built-in views can't change" } },
          400,
        )
      if (method === "PUT") {
        Object.assign(found, body, { updatedAt: now })
        return json(route, found)
      }
      state.views.splice(state.views.indexOf(found), 1)
      const id = `trash-view-${found.id}`
      state.trashed.set(id, { kind: "telemetry-view", record: found })
      hooks.trash?.({ id, kind: "telemetry-view", name: String(found.name), deletedAt: now, files: [] })
      return json(route, true)
    }
    if (path === "/settings" && method === "GET") return json(route, state.settings)
    if (path === "/settings") {
      if ((body?.eventsDays as number) < 1)
        return json(
          route,
          { name: "OperatorTelemetryInvalidError", data: { message: "Keep detailed events for 1 to 365 days" } },
          400,
        )
      const changed = body?.recordCalls !== state.settings.recordCalls
      state.settings = { ...state.settings, ...(body as typeof state.settings) }
      return json(route, { settings: state.settings, ...(changed ? { reload: "when-idle" } : {}) })
    }
    if (path === "/clear") {
      hooks.trash?.({ id: "trash-telemetry-1", kind: "telemetry", name: "telemetry.sqlite", deletedAt: now, files: [] })
      return json(route, { trash: "trash-telemetry-1" })
    }
    if (path === "/export/count") return json(route, { rows: state.exportRows, limit: 100_000 })
    if (path === "/export") {
      const csv = q.get("format") === "csv"
      return route.fulfill({
        status: 200,
        contentType: csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        headers: {
          "content-disposition": `attachment; filename="opencode-${q.get("tab")}-202610190000-202610200000.${csv ? "csv" : "jsonl"}"`,
        },
        body: csv
          ? "start_ms,kind,name\r\n2026-10-19T10:00:00.000+00:00,turn,invoke_agent build\r\n"
          : '{"id":"turn:1"}\n',
      })
    }
    return json(route, { name: "NotFound", data: { message: path } }, 404)
  }

  const alerts = (route: Route, path: string, method: string) => {
    const body = (() => {
      try {
        return route.request().postDataJSON() as Row | null
      } catch {
        return null
      }
    })()
    if (method !== "GET") state.alertWrites.push({ method, path, body })
    const view = (id: string) => state.rules.find((item) => item.rule.id === id)
    const mutedNow = (ruleID: string) => !!view(ruleID)?.muted
    const events = () => state.alerts.map((event) => ({ ...event, muted: mutedNow(event.rule_id) }))
    if (path === "/alert/rule" && method === "GET") return json(route, state.rules)
    if (path === "/alert/rule" && method === "POST") {
      const created = {
        rule: { ...body, id: `rule-${state.rules.length + 1}`, createdAt: now, updatedAt: now },
        state: {
          state: "ok",
          streak: 0,
          clear: 0,
          value: null,
          count: null,
          evaluated_ms: null,
          error: null,
          event_id: null,
          last_fired_ms: null,
        },
        muted: false,
      }
      state.rules.push(created)
      return json(route, created)
    }
    const rule = path.match(/^\/alert\/rule\/([^/]+)(?:\/(mute|reset))?$/)
    if (rule) {
      const found = view(decodeURIComponent(rule[1]!))
      if (!found) return json(route, { name: "OperatorTelemetryNotFoundError", data: { message: "none" } }, 404)
      if (rule[2] === "mute") {
        found.muted = body?.for !== "off"
        found.rule = {
          ...found.rule,
          ...(found.muted ? { mute: body?.for === "always" ? {} : { until: now + 3_600_000 } } : {}),
        }
        if (!found.muted) delete found.rule.mute
        return json(route, found)
      }
      if (rule[2] === "reset") return json(route, found)
      if (method === "PUT") {
        found.rule = { ...found.rule, ...body }
        return json(route, found)
      }
      if (method === "DELETE") {
        if (found.rule.builtin)
          return json(
            route,
            { name: "OperatorTelemetryAlertError", data: { message: "Built-in rules can't be deleted" } },
            400,
          )
        state.rules.splice(state.rules.indexOf(found), 1)
        hooks.trash?.({
          id: `trash-alert-${found.rule.id}`,
          kind: "alert-rule",
          name: found.rule.name,
          deletedAt: now,
          files: [{ path: `/data/operator/alert-rules/${found.rule.id}.json`, stored: "files/0" }],
        })
        return json(route, true)
      }
    }
    if (path === "/alert/event")
      return json(
        route,
        events().filter((event) => event.end_ms === null || route.request().url().indexOf("firing=1") < 0),
      )
    const ack = path.match(/^\/alert\/event\/([^/]+)\/ack$/)
    if (ack) {
      const found = state.alerts.find((event) => event.id === ack[1])
      if (!found) return json(route, { name: "OperatorTelemetryNotFoundError", data: { message: "none" } }, 404)
      found.ack_by = "operator"
      found.ack_ms = now
      return json(route, { ...found, muted: mutedNow(found.rule_id) })
    }
    return json(route, { name: "NotFound", data: { message: path } }, 404)
  }

  const handle = (route: Route, url: URL, method: string) => {
    const path = url.pathname.slice("/operator/telemetry".length)
    state.queries.push({ path, params: url.searchParams })
    const q = url.searchParams
    if (path === "/sessions") {
      const { key, down } = sortOf(q.get("sort"))
      const statuses = q.get("sessionStatus")?.split(",")
      const agents = q.get("agent")?.split(",")
      const rows = state.sessions
        .filter((row) => q.get("roots") === "0" || !row.parent_id)
        .filter((row) => !statuses || statuses.includes(row.status))
        .filter((row) => !agents || agents.includes(row.agent))
        .filter((row) => !q.get("q") || String(row.title).toLowerCase().includes(q.get("q")!.toLowerCase()))
        .toSorted((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.id < b.id ? -1 : 1) * (down ? -1 : 1))
        .map((row) => ({ ...row, kept: state.kept.has(row.id) }))
      const offset = Number(q.get("cursor") ?? 0)
      const limit = Number(q.get("limit") ?? 50)
      const page = rows.slice(offset, offset + limit)
      return json(route, {
        rows: page,
        total: rows.length,
        ...(offset + limit < rows.length ? { nextCursor: String(offset + limit) } : {}),
      })
    }
    const detail = path.match(/^\/session\/([^/]+)$/)
    if (detail) {
      const id = decodeURIComponent(detail[1]!)
      const row = state.sessions.find((item) => item.id === id)
      if (!row) return json(route, { name: "OperatorTelemetryNotFoundError", data: { message: "none" } }, 404)
      const all = (turnsOf[id] ?? []).map((span, index) => ({
        span,
        number: index + 1,
        ...(labels[span.message_id] ? { label: labels[span.message_id]!.split("\n")[0] } : {}),
      }))
      const before = Number(q.get("before") ?? NaN)
      const earlierThan = Number.isFinite(before) ? all.filter((item) => item.span.start_ms < before) : all
      const shown = q.get("turns") === "all" ? earlierThan : earlierThan.slice(-20)
      return json(route, {
        session: { ...row, kept: state.kept.has(id) },
        turns: shown,
        earlier: shown.length < earlierThan.length,
      })
    }
    const turn = path.match(/^\/session\/([^/]+)\/turn\/([^/]+)$/)
    if (turn) {
      const turnID = decodeURIComponent(turn[2]!)
      const found = Object.values(turnsOf)
        .flat()
        .find((span) => span.id === turnID)
      if (!found) return json(route, { name: "OperatorTelemetryNotFoundError", data: { message: "none" } }, 404)
      return json(route, { turn: found, spans: spansOf[turnID] ?? [] })
    }
    const keep = path.match(/^\/session\/([^/]+)\/keep$/)
    if (keep) {
      const id = decodeURIComponent(keep[1]!)
      if (method === "POST") state.kept.add(id)
      else state.kept.delete(id)
      return json(route, true)
    }
    const span = path.match(/^\/span\/(.+)$/)
    if (span) {
      const id = decodeURIComponent(span[1]!)
      const found = all.find((item) => item.id === id)
      if (!found) return json(route, { name: "OperatorTelemetryNotFoundError", data: { message: "none" } }, 404)
      return json(route, {
        span: found,
        links: {
          ...(found.session_id ? { session: found.session_id } : {}),
          ...(found.kind === "model_call" && found.call_id ? { call: found.call_id } : {}),
          ...(found.request_id ? { decision: found.request_id } : {}),
          ...(found.kind === "subagent" ? { child: String(found.id).slice(4) } : {}),
        },
      })
    }
    if (path === "/facets") {
      const field = q.get("field") ?? ""
      const column: Record<string, string> = {
        sessionStatus: "status",
        agent: "agent",
        agentType: "agent_type",
        model: "model",
        dir: "project_key",
      }
      const counts = new Map<string, number>()
      for (const row of state.sessions.filter((item) => !item.parent_id)) {
        const value = row[column[field] ?? ""]
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      return json(
        route,
        [...counts].map(([value, count]) => ({ value, count })).toSorted((a, b) => b.count - a.count),
      )
    }
    if (path === "/backfill") return json(route, state.backfill)
    if (path === "/storage")
      return json(route, {
        path: "/x/telemetry.sqlite",
        bytes: 1000,
        spans: 10,
        logs: 0,
        sessions: 60,
        dropped: 0,
        kept: 0,
        eventsDays: 30,
        totalsDays: 400,
        logPath: "/root/.local/share/opencode/log/opencode.log",
        logLevel: "warn",
        oldestLog: now - 20 * MIN,
      })
    if (path === "/events") {
      const kinds = q.get("kind")?.split(",")
      const statuses = q.get("status")?.split(",")
      const from = Number(q.get("from") ?? NaN)
      const to = Number(q.get("to") ?? NaN)
      const session = q.get("session")
      const rows = all
        .filter((span) => !kinds || kinds.includes(span.kind))
        .filter((span) => !statuses || statuses.includes(span.status))
        .filter((span) => !session || span.session_id === session || span.root_session_id === session)
        .filter((span) => !Number.isFinite(from) || (span.start_ms >= from && span.start_ms < to))
      const titles = Object.fromEntries(state.sessions.map((row) => [row.id, row.title]))
      if (q.get("after") !== null) {
        const after = Number(q.get("after"))
        const tail = rows.filter((span) => span.seq > after).toSorted((a, b) => a.seq - b.seq)
        return json(route, { rows: tail, seq: tail.at(-1)?.seq ?? after, titles })
      }
      const sorted = rows.toSorted((a, b) => b.start_ms - a.start_ms || (a.id < b.id ? 1 : -1))
      const offset = Number(q.get("cursor") ?? 0)
      const limit = Number(q.get("limit") ?? 100)
      return json(route, {
        rows: sorted.slice(offset, offset + limit),
        seq,
        titles,
        ...(offset + limit < sorted.length ? { nextCursor: String(offset + limit) } : {}),
      })
    }
    if (path === "/logs") {
      const kept: Record<string, string[]> = {
        error: ["ERROR"],
        warn: ["ERROR", "WARN"],
        info: ["ERROR", "WARN", "INFO"],
      }
      const levels = kept[q.get("level") ?? "warn"] ?? kept.warn!
      const rows = logs.filter((entry) => levels.includes(entry.level))
      if (q.get("after") !== null) {
        const after = Number(q.get("after"))
        const tail = rows.filter((entry) => entry.seq > after).toSorted((a, b) => a.seq - b.seq)
        return json(route, { rows: tail, seq: tail.at(-1)?.seq ?? after })
      }
      return json(route, { rows: rows.toSorted((a, b) => b.time_ms - a.time_ms), seq })
    }
    if (path === "/metrics") return json(route, metricOf(q, now))
    if (path.startsWith("/alert/")) return alerts(route, path, method)
    if (
      path === "/view" ||
      path.startsWith("/view/") ||
      path === "/settings" ||
      path === "/clear" ||
      path.startsWith("/export")
    )
      return phase8(route, path, method, q)
    return json(route, { name: "NotFound", data: { message: path } }, 404)
  }
  /** A record restored from Trash comes back. */
  const restore = (entry: { id: string }) => {
    const found = state.trashed.get(entry.id)
    if (!found) return
    state.trashed.delete(entry.id)
    if (found.kind === "telemetry-view") state.views.push(found.record)
  }
  return { state, handle, restore }
}
