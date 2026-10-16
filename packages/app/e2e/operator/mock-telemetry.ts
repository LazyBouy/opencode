import type { Route } from "@playwright/test"

// Observability's API for the e2e mock (observability_spec.md §7): seeded sessions, turns and spans, answered as the
// server would (sorting, roots, paging with a cursor, facets), with every query recorded.

const MIN = 60_000
type Row = Record<string, any>

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

export function createTelemetryMock(now: number) {
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
  const state = {
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
    return json(route, { name: "NotFound", data: { message: path } }, 404)
  }
  return { state, handle }
}
