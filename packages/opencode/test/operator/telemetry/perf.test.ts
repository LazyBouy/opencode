import fs from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { OperatorTelemetryBatch } from "@/operator/telemetry/batch"
import { OperatorTelemetryDashboard } from "@/operator/telemetry/dashboard"
import { OperatorTelemetryDerive } from "@/operator/telemetry/derive"
import { OperatorTelemetryMetrics as M } from "@/operator/telemetry/metrics"
import { OperatorTelemetryQuery as Q } from "@/operator/telemetry/query"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorTelemetryTotals } from "@/operator/telemetry/totals"
import { OperatorTelemetryWriter } from "@/operator/telemetry/writer"
import { tmpdir } from "../../fixture/fixture"
import { harness, tool, user } from "./harness"

// observability_spec.md §19, §21.1: the budgets on the reference data — a store with 30 days of activity: about
// 500,000 spans (3,000 sessions, 30,000 turns), 50,000 log lines and samples, realistic mixes of kinds, statuses,
// models and tools. Opt-in, so normal runs stay fast: OPENCODE_TELEMETRY_PERF=1 bun run test test/operator/telemetry/perf.test.ts
// Each budget is the p95 of several runs (the slowest of 5, or the 95th percentile of many for the hot path).

const run = !!process.env.OPENCODE_TELEMETRY_PERF
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.now()

// A small deterministic random source, so every run builds the same store.
let seed = 42
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}
const pick = <T>(items: ReadonlyArray<T>) => items[Math.floor(random() * items.length)]!
const MODELS = ["claude-sonnet-4-5", "claude-opus-4-6", "gpt-5", "gemini-2.5-pro", "grok-4"]
const PROVIDER: Record<string, string> = {
  "claude-sonnet-4-5": "anthropic",
  "claude-opus-4-6": "anthropic",
  "gpt-5": "openai",
  "gemini-2.5-pro": "google",
  "grok-4": "xai",
}
const TOOLS = ["bash", "edit", "read", "grep", "glob", "write", "list", "webfetch", "task", "todowrite", "patch", "lsp"]
const AGENTS = ["build", "plan", "review", "explore"]
const PROJECTS = ["/work/app", "/work/api", "/work/web", "/work/infra", "/work/docs", "/work/ml"]
const status = () => {
  const roll = random()
  return roll < 0.9 ? "ok" : roll < 0.95 ? "error" : roll < 0.98 ? "denied" : "interrupted"
}

export type Built = { store: OperatorTelemetryStore.Store; spans: number; big: string; seconds: number }

export function build(dir: string): Built {
  const store = new OperatorTelemetryStore.Store(path.join(dir, "telemetry.sqlite"))
  const started = performance.now()
  let spans = 0
  const sessions: Array<Omit<OperatorTelemetryStore.SessionRow, "seq">> = []
  const writes: OperatorTelemetryStore.SpanWrite[] = []
  const flush = () => {
    store.transaction(() => {
      for (const write of writes) store.upsertSpan(write)
    })
    spans += writes.length
    writes.length = 0
  }
  const session = (id: string, turns: number) => {
    const project = pick(PROJECTS)
    const agent = pick(AGENTS)
    const model = pick(MODELS)
    let time = NOW - Math.floor(random() * 30 * DAY)
    const first = time
    let cost = 0
    let calls = 0
    let tools = 0
    for (let turn = 0; turn < turns; turn++) {
      const turnID = `turn:${id}:${turn}`
      const base = { session_id: id, root_session_id: id, project_key: project, agent, agent_type: "usual" }
      const turnStatus = status()
      let at = time
      // Four model calls and eleven tool calls a turn, and now and then a wait, a retry, a subagent, a compaction.
      for (let call = 0; call < 4; call++) {
        const duration = 800 + Math.floor(random() * 20_000)
        const callCost = random() * 0.05
        cost += callCost
        calls++
        writes.push({
          ...base,
          id: `call:${id}:${turn}:${call}`,
          kind: "model_call",
          name: `chat ${model}`,
          parent_id: turnID,
          turn_id: turnID,
          model,
          provider: PROVIDER[model]!,
          status: random() < 0.97 ? "ok" : "error",
          ...(random() < 0.01 ? { http_status: 429 } : {}),
          start_ms: at,
          end_ms: at + duration,
          duration_ms: duration,
          active_ms: duration,
          ttft_ms: random() < 0.8 ? 300 + Math.floor(random() * 3000) : null,
          tokens_input: Math.floor(random() * 5000),
          tokens_output: Math.floor(random() * 2000),
          tokens_cache_read: Math.floor(random() * 40_000),
          tokens_cache_write: Math.floor(random() * 2000),
          cost: callCost,
          context_tokens: Math.floor(random() * 150_000),
          source: "message",
        })
        at += duration
      }
      for (let n = 0; n < 11; n++) {
        const duration = 50 + Math.floor(random() * 8000)
        tools++
        writes.push({
          ...base,
          id: `tool:${id}:${turn}:${n}`,
          kind: "tool_call",
          name: "execute_tool",
          parent_id: turnID,
          turn_id: turnID,
          tool: pick(TOOLS),
          status: status() as OperatorTelemetryStore.Status,
          start_ms: at,
          end_ms: at + duration,
          duration_ms: duration,
          active_ms: duration,
          args_hash: String(Math.floor(random() * 1e9)),
          source: "part",
        })
        at += duration
      }
      if (turn % 4 === 0)
        writes.push({
          ...base,
          id: `perm:${id}:${turn}`,
          kind: "permission_wait",
          name: "approval bash",
          parent_id: turnID,
          turn_id: turnID,
          status: "ok",
          decision: pick(["allow", "allow-session", "deny"]),
          permission: "bash",
          start_ms: at,
          end_ms: at + 20_000,
          duration_ms: 20_000,
          wait_ms: 20_000,
          source: "decision",
        })
      if (turn % 20 === 0)
        writes.push({
          ...base,
          id: `retry:${id}:${turn}`,
          kind: "retry",
          name: "retry",
          turn_id: turnID,
          status: "ok",
          start_ms: at,
          source: "status",
        })
      if (turn % 30 === 0)
        writes.push({
          ...base,
          id: `sub:${id}:${turn}`,
          kind: "subagent",
          name: "invoke_agent explore",
          turn_id: turnID,
          agent: "explore",
          status: "ok",
          start_ms: at,
          end_ms: at + 60_000,
          source: "session",
        })
      if (turn % 50 === 0)
        writes.push({
          ...base,
          id: `compact:${id}:${turn}`,
          kind: "compaction",
          name: "gen_ai.conversation.compacted",
          turn_id: turnID,
          status: "ok",
          start_ms: at,
          end_ms: at + 5000,
          source: "message",
        })
      writes.push({
        ...base,
        id: turnID,
        kind: "turn",
        name: `invoke_agent ${agent}`,
        turn_id: turnID,
        model,
        status: turnStatus as OperatorTelemetryStore.Status,
        start_ms: time,
        end_ms: at,
        duration_ms: at - time,
        active_ms: at - time,
        ...(random() < 0.01 ? { loop: "same-call" } : {}),
        attrs: JSON.stringify({ modelCalls: 4, toolCalls: 11 }),
        message_id: `msg_${id}_${turn}`,
        source: "message",
      })
      time = at + 2 * MIN
      if (writes.length > 20_000) flush()
    }
    sessions.push({
      id,
      title: `Session ${id}`,
      agent,
      agent_type: "usual",
      project_key: project,
      directory: project,
      parent_id: null,
      root_id: id,
      status: "idle",
      first_ms: first,
      last_ms: time,
      turns,
      model_calls: calls,
      tool_calls: tools,
      errors: 0,
      denials: 0,
      retries: 0,
      wait_ms: 0,
      active_ms: time - first,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost,
      cost_total: cost,
      cost_billed: null,
      loop: null,
      trashed: 0,
      turn_start_ms: null,
      current: null,
      subagents: 0,
      model,
    })
  }
  for (let n = 0; n < 2_999; n++) session(`ses_${n}`, 10)
  // One long session, for the detail's budget.
  session("ses_big", 200)
  flush()
  store.transaction(() => {
    for (const row of sessions) store.upsertSession(row)
    for (let n = 0; n < 50_000; n++) {
      store.insertLog({
        id: `log:${n}`,
        time_ms: NOW - Math.floor(random() * 30 * DAY),
        level: pick(["ERROR", "WARN", "WARN", "INFO"]),
        message: "stream error",
        run: null,
        service: pick(["llm", "session", "mcp"]),
        session_id: `ses_${Math.floor(random() * 2999)}`,
        fields: JSON.stringify({ provider: "anthropic" }),
      })
      store.insertSample({
        time_ms: NOW - n * MIN,
        name: pick(["sessions_running", "approvals_pending", "queue_depth"]),
        dims: null,
        value: Math.floor(random() * 5),
      })
    }
    // Every hour has totals.
    OperatorTelemetryTotals.mark(
      store,
      Array.from({ length: 31 * 24 }, (_, at) => NOW - at * HOUR),
    )
  })
  store.transaction(() => OperatorTelemetryTotals.recompute(store))
  // The log checkpointed and statistics kept, as the server does (every 10 s; after purges, and minutes after start).
  store.checkpoint()
  store.optimize()
  return { store, spans, big: "ses_big", seconds: (performance.now() - started) / 1000 }
}

const time = (work: () => unknown, runs = 5) => {
  // Once first, unmeasured: a running server has its statements compiled and its pages cached.
  work()
  const samples: number[] = []
  for (let n = 0; n < runs; n++) {
    const start = performance.now()
    work()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)]!
}

describe.skipIf(!run)("telemetry performance (§19)", () => {
  test(
    "the budgets on 30 days of reference data",
    async () => {
      await using tmp = await tmpdir()
      const built = build(tmp.path)
      const { store } = built
      const context: Q.Context = {
        now: NOW,
        known: PROJECTS,
        stuckMinutes: 10,
        projectsOf: (ns) => ({
          keys: ns === "acme" ? PROJECTS.slice(0, 3) : PROJECTS.slice(3),
          rest: ns === "opencode",
        }),
      }
      const month = { range: "30d" }
      const results: Record<string, { ms: number; budget: number }> = {}
      const measure = (name: string, budget: number, work: () => unknown, runs = 5) => {
        results[name] = { ms: time(work, runs), budget }
      }

      // The hot path: handling one event only queues it.
      const h = harness(path.join(tmp.path, "hot"))
      user(h, "ses_hot", "msg_hot", NOW)
      let part = 0
      measure(
        "one event on the hot path",
        0.2,
        () =>
          tool(h, "ses_hot", "msg_hot", `prt_${part++}`, "bash", {
            status: "running",
            input: { command: "ls" },
            time: { start: NOW },
          }),
        2000,
      )
      // One flush of 500 rows, with what depends on them.
      let flushes = 0
      measure("one flush of 500 rows", 50, () => {
        const batch = new OperatorTelemetryBatch.Batch()
        const turn = `turn:ses_${flushes}:0`
        for (let n = 0; n < 500; n++)
          batch.span({
            id: `flush:${flushes}:${n}`,
            kind: "tool_call",
            name: "execute_tool bash",
            turn_id: turn,
            session_id: `ses_${flushes}`,
            tool: "bash",
            status: "ok",
            start_ms: NOW - HOUR,
            end_ms: NOW - HOUR + 100,
            source: "part",
          })
        flushes++
        OperatorTelemetryWriter.apply(store, batch, {
          contextOf: () => ({}),
          loops: OperatorTelemetryDerive.DEFAULT_LOOPS,
          now: NOW,
        })
      })
      measure("Sessions tab, first page", 400, () => Q.sessions(store, month, context, { limit: 50 }))
      measure("Events tab, first page", 300, () => Q.events(store, month, context, { limit: 100 }))
      measure("Events tab, first page of one kind", 300, () =>
        Q.events(store, { ...month, kind: "tool_call" }, context, { limit: 100 }),
      )
      measure("Events tab, first page of errors", 300, () =>
        Q.events(store, { ...month, status: "error" }, context, { limit: 100 }),
      )
      measure("Events tab, the next page", 300, () => {
        const first = Q.events(store, month, context, { limit: 100 })
        Q.events(store, month, context, { limit: 100, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) })
      })
      measure("one live fetch", 300, () =>
        Q.events(store, month, context, { after: store.lastSeq() - 200, limit: 500 }),
      )
      for (const metric of ["calls", "call_duration", "tokens", "tool_table", "turns"] as const)
        measure(`metric ${metric} over 30 days from spans`, 600, () =>
          M.compute(store, { metric, filter: month, context, eventsDays: 30 }),
        )
      for (const metric of ["calls", "call_duration", "cost"] as const)
        measure(`metric ${metric} over 400 days from totals`, 300, () =>
          M.compute(store, { metric, filter: { from: NOW - 400 * DAY, to: NOW }, context, eventsDays: 30 }),
        )
      for (const field of ["kind", "status", "tool", "model", "agent"] as const)
        measure(`facet ${field}`, 300, () => Q.facet(store, month, context, { scope: "events", field }))
      // The Dashboard (dashboard_spec.md §11).
      measure("Dashboard attention", 100, () =>
        OperatorTelemetryDashboard.attention(store, {
          scope: {},
          context,
          enabled: true,
          stuckMinutes: 10,
          queueMinutes: 10,
          dailyBudget: 10,
          dropped: 0,
          alerts: [],
          activeFolders: new Set(PROJECTS),
        }),
      )
      measure("Dashboard tiles, 30 days", 400, () =>
        OperatorTelemetryDashboard.tiles(store, {
          filter: { range: "30d" },
          scope: {},
          context,
          eventsDays: 30,
          dailyBudget: 10,
        }),
      )
      for (const by of ["agent", "tool"] as const)
        measure(`Dashboard breakdown by ${by}`, 300, () =>
          OperatorTelemetryDashboard.breakdown(store, { by, limit: 8, filter: month, context }),
        )
      measure("session detail with 200 turns", 500, () => {
        const { turns } = Q.turns(store, built.big, { all: true })
        for (const turn of turns.slice(-1)) store.spansOfTurn(turn.span.id)
      })
      measure("totals recompute for the dirty hours", 200, () => {
        store.transaction(() => {
          OperatorTelemetryTotals.mark(store, [NOW - HOUR, NOW - 2 * HOUR])
          OperatorTelemetryTotals.recompute(store)
        })
      })

      const bytes = ["", "-wal"].reduce(
        (sum, suffix) => sum + (fs.statSync(`${store.file}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
        0,
      )
      console.log(
        [
          `reference store: ${built.spans} spans, built in ${built.seconds.toFixed(1)} s, ${(bytes / 1024 / 1024).toFixed(0)} MB`,
          ...Object.entries(results).map(
            ([name, result]) =>
              `${result.ms <= result.budget ? "ok  " : "SLOW"} ${name}: ${result.ms.toFixed(2)} ms (budget ${result.budget} ms)`,
          ),
        ].join("\n"),
      )
      expect(built.spans).toBeGreaterThan(450_000)
      // Over 1 GB for 30 days would need a smaller schema: ask first (§19).
      expect(bytes).toBeLessThan(1024 * 1024 * 1024)
      for (const [name, result] of Object.entries(results))
        expect({ name, ms: result.ms }).toEqual({ name, ms: expect.any(Number) })
      expect(
        Object.entries(results)
          .filter(([, result]) => result.ms > result.budget)
          .map(([name]) => name),
      ).toEqual([])
    },
    15 * 60_000,
  )
})
