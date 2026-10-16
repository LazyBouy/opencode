import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { OperatorCallStore } from "@/operator/call-store"
import { OperatorTelemetryBatch } from "@/operator/telemetry/batch"
import { OperatorTelemetryCalls } from "@/operator/telemetry/calls"
import { OperatorTelemetryNames } from "@/operator/telemetry/names"
import { OperatorTelemetryWriter } from "@/operator/telemetry/writer"
import { tmpdir } from "../../fixture/fixture"
import { assistant, harness, idle, T0, tool, user } from "./harness"

// observability_spec.md §21.1: each source in §5.1 gives the expected span, with the right parent, ids, status and
// times; turns, waits, denials, loops, ids and restarts.

const S = "ses_main"

describe("telemetry ingestion", () => {
  test("a turn: the prompt starts it, its model call and tool call sit under it, idle ends it with its totals", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 100 })
    tool(h, S, "msg_a1", "prt_t1", "bash", { status: "running", input: { command: "ls" }, time: { start: T0 + 500 } })
    tool(h, S, "msg_a1", "prt_t1", "bash", {
      status: "completed",
      input: { command: "ls" },
      output: "a\nb",
      title: "ls",
      metadata: {},
      time: { start: T0 + 500, end: T0 + 1500 },
    })
    assistant(h, S, "msg_a1", "msg_u1", {
      created: T0 + 100,
      completed: T0 + 2000,
      finish: "stop",
      cost: 0.02,
      tokens: { input: 100, output: 20, read: 400, write: 50 },
    })
    h.at(T0 + 3000)
    idle(h, S)
    h.flush()

    const turn = h.store.span("turn:msg_u1")!
    expect(turn).toMatchObject({
      kind: "turn",
      name: "invoke_agent build",
      session_id: S,
      status: "ok",
      start_ms: T0,
      end_ms: T0 + 3000,
      duration_ms: 3000,
      active_ms: 3000,
      wait_ms: 0,
      tokens_input: 100,
      tokens_output: 20,
      tokens_cache_read: 400,
      tokens_cache_write: 50,
      cost: 0.02,
      finish_reason: "stop",
    })
    expect(JSON.parse(turn.attrs!)).toMatchObject({ modelCalls: 1, toolCalls: 1 })
    expect(h.store.span("msg:msg_a1")).toMatchObject({
      kind: "model_call",
      name: "chat claude-sonnet-4-5",
      parent_id: "turn:msg_u1",
      turn_id: "turn:msg_u1",
      status: "ok",
      context_tokens: 550,
      source: "message",
    })
    const call = h.store.span("tool:prt_t1")!
    expect(call).toMatchObject({
      kind: "tool_call",
      name: "execute_tool bash",
      parent_id: "turn:msg_u1",
      status: "ok",
      duration_ms: 1000,
      active_ms: 1000,
      call_id: "call_prt_t1",
    })
    expect(call.args_hash).toHaveLength(64)
    expect(call.result_hash).toHaveLength(64)
    expect(h.store.session(S)).toMatchObject({ turns: 1, model_calls: 1, tool_calls: 1, status: "idle", cost: 0.02 })
  })

  test("a new prompt ends the running turn; statuses come from the last assistant message", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const turns: Array<[string, Parameters<typeof assistant>[4], string, string | undefined]> = [
      ["1", { created: T0, completed: T0 + 10, finish: "stop" }, "ok", undefined],
      [
        "2",
        { created: T0 + 100, error: { name: "APIError", data: { message: "bad gateway", statusCode: 502 } } },
        "error",
        "APIError",
      ],
      ["3", { created: T0 + 200, error: { name: "MessageAbortedError" } }, "cancelled", "MessageAbortedError"],
      [
        "4",
        { created: T0 + 300, error: { name: "ContextOverflowError", data: { message: "too long" } } },
        "error",
        "ContextOverflowError",
      ],
    ]
    for (const [n, fields] of turns) {
      user(h, S, `msg_u${n}`, fields.created - 1)
      assistant(h, S, `msg_a${n}`, `msg_u${n}`, fields)
    }
    h.at(T0 + 1000)
    idle(h, S)
    h.flush()
    for (const [n, , status, errorType] of turns)
      expect(h.store.span(`turn:msg_u${n}`)).toMatchObject({ status, error_type: errorType ?? null })
    // The second turn ended when the third prompt came.
    expect(h.store.span("turn:msg_u2")!.end_ms).toBe(T0 + 199)
    expect(h.store.span("turn:msg_u2")!.error_message).toBe("bad gateway")
    expect(h.store.session(S)).toMatchObject({ turns: 4, errors: 2, status: "error" })
  })

  test("a turn with retries that ends in an API error has exhausted its retries; retry notices are rows", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    h.at(T0 + 10)
    h.event("session.status", {
      sessionID: S,
      status: { type: "retry", attempt: 1, message: "Rate limited: 429 Too Many Requests", next: T0 + 4000 },
    })
    h.at(T0 + 20)
    h.event("session.status", {
      sessionID: S,
      status: { type: "retry", attempt: 2, message: "overloaded", next: T0 + 9000 },
    })
    assistant(h, S, "msg_a1", "msg_u1", {
      created: T0 + 5,
      error: { name: "APIError", data: { message: "overloaded" } },
    })
    idle(h, S)
    h.flush()
    expect(h.store.span("turn:msg_u1")).toMatchObject({ status: "error", error_type: "retries_exhausted" })
    expect(h.store.span("retry:ses_main:turn:msg_u1:1")).toMatchObject({
      kind: "retry",
      parent_id: "turn:msg_u1",
      http_status: 429,
      error_type: "http_429",
      start_ms: T0 + 10,
      end_ms: T0 + 10,
    })
    expect(h.store.span("retry:ses_main:turn:msg_u1:2")!.http_status).toBeNull()
    expect(JSON.parse(h.store.span("turn:msg_u1")!.attrs!).retries).toBe(2)
    expect(h.store.session(S)!.retries).toBe(2)
  })

  test("a compaction sits under its turn, its summary call under it; the follow-up OpenCode adds starts no turn", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    assistant(h, S, "msg_a1", "msg_u1", {
      created: T0 + 1,
      completed: T0 + 2,
      cost: 0.01,
      tokens: { input: 10, output: 1 },
    })
    // The automatic compaction's message, then its summary, then the follow-up.
    h.event("message.updated", {
      sessionID: S,
      info: { id: "msg_c", sessionID: S, role: "user", time: { created: T0 + 3 }, agent: "build", model: {} },
    })
    h.event("message.part.updated", {
      sessionID: S,
      part: { id: "prt_c", sessionID: S, messageID: "msg_c", type: "compaction", auto: true },
    })
    assistant(h, S, "msg_s", "msg_c", {
      created: T0 + 4,
      mode: "compaction",
      agent: "compaction",
      cost: 0.005,
      tokens: { input: 5, output: 2 },
    })
    assistant(h, S, "msg_s", "msg_c", {
      created: T0 + 4,
      completed: T0 + 9,
      mode: "compaction",
      agent: "compaction",
      cost: 0.005,
      tokens: { input: 5, output: 2 },
    })
    h.event("message.updated", {
      sessionID: S,
      info: { id: "msg_f", sessionID: S, role: "user", time: { created: T0 + 10 }, agent: "build", model: {} },
    })
    h.event("message.part.updated", {
      sessionID: S,
      part: {
        id: "prt_f",
        sessionID: S,
        messageID: "msg_f",
        type: "text",
        text: "Continue if you have next steps",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    })
    assistant(h, S, "msg_a2", "msg_f", {
      created: T0 + 11,
      completed: T0 + 12,
      cost: 0.01,
      tokens: { input: 10, output: 1 },
    })
    h.event("session.compacted", { sessionID: S })
    h.at(T0 + 20)
    idle(h, S)
    h.flush()
    expect(
      h.store
        .spansOfSession(S)
        .filter((span) => span.kind === "turn")
        .map((span) => span.id),
    ).toEqual(["turn:msg_u1"])
    expect(h.store.span("compact:msg_c")).toMatchObject({
      kind: "compaction",
      parent_id: "turn:msg_u1",
      status: "ok",
      end_ms: T0 + 9,
    })
    expect(h.store.span("msg:msg_s")).toMatchObject({ parent_id: "compact:msg_c", turn_id: "turn:msg_u1" })
    expect(h.store.span("msg:msg_a2")!.parent_id).toBe("turn:msg_u1")
    const turn = h.store.span("turn:msg_u1")!
    expect(turn.cost).toBeCloseTo(0.025)
    expect(JSON.parse(turn.attrs!)).toMatchObject({ modelCalls: 3, compactions: 1 })
  })

  test("a tool call's approval wait is its own span; latency is active time, overlapping waits count once", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 1 })
    tool(
      h,
      S,
      "msg_a1",
      "prt_a",
      "bash",
      { status: "running", input: { command: "git push" }, time: { start: T0 + 1000 } },
      "call_a",
    )
    tool(
      h,
      S,
      "msg_a1",
      "prt_b",
      "edit",
      { status: "running", input: { path: "x" }, time: { start: T0 + 2000 } },
      "call_b",
    )
    h.at(T0 + 1000)
    h.event("permission.asked", {
      id: "per_a",
      sessionID: S,
      permission: "bash",
      patterns: ["git push*"],
      metadata: {},
      always: [],
      tool: { messageID: "msg_a1", callID: "call_a" },
    })
    h.at(T0 + 2000)
    h.event("permission.asked", {
      id: "per_b",
      sessionID: S,
      permission: "edit",
      patterns: ["x"],
      metadata: {},
      always: [],
      tool: { messageID: "msg_a1", callID: "call_b" },
    })
    const decide = (requestID: string, permission: string, askedAt: number, decidedAt: number, callID: string) =>
      h.ingest.decision({
        requestID,
        sessionID: S,
        permission,
        patterns: ["*"],
        askedAt,
        decidedAt,
        decision: "allow",
        who: "me",
        tool: { messageID: "msg_a1", callID },
      })
    decide("per_a", "bash", T0 + 1000, T0 + 53_000, "call_a")
    decide("per_b", "edit", T0 + 2000, T0 + 30_000, "call_b")
    tool(
      h,
      S,
      "msg_a1",
      "prt_a",
      "bash",
      {
        status: "completed",
        input: { command: "git push" },
        output: "done",
        title: "",
        metadata: {},
        time: { start: T0 + 1000, end: T0 + 60_000 },
      },
      "call_a",
    )
    tool(
      h,
      S,
      "msg_a1",
      "prt_b",
      "edit",
      {
        status: "completed",
        input: { path: "x" },
        output: "ok",
        title: "",
        metadata: {},
        time: { start: T0 + 2000, end: T0 + 31_000 },
      },
      "call_b",
    )
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 1, completed: T0 + 61_000, finish: "stop" })
    h.at(T0 + 62_000)
    idle(h, S)
    h.flush()
    expect(h.store.span("perm:per_a")).toMatchObject({
      kind: "permission_wait",
      parent_id: "tool:prt_a",
      turn_id: "turn:msg_u1",
      status: "ok",
      decision: "allow",
      decided_by: "me",
      decision_source: "user",
      wait_ms: 52_000,
    })
    // 52 s waiting for a person: not the tool's latency.
    expect(h.store.span("tool:prt_a")).toMatchObject({ duration_ms: 59_000, wait_ms: 52_000, active_ms: 7_000 })
    // The waits overlap from 2 s to 30 s: the turn waited 52 s, not 80 s.
    expect(h.store.span("turn:msg_u1")).toMatchObject({ duration_ms: 62_000, wait_ms: 52_000, active_ms: 10_000 })
    expect(h.store.session(S)).toMatchObject({ wait_ms: 52_000, active_ms: 10_000 })
  })

  test("a person's denial and a rule's denial are denied, counted as denials, not errors", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 1 })
    tool(h, S, "msg_a1", "prt_rule", "webfetch", {
      status: "error",
      input: { url: "https://x" },
      error: new PermissionV1.DeniedError({ ruleset: [{ permission: "webfetch", pattern: "*", action: "deny" }] })
        .message,
      time: { start: T0 + 2, end: T0 + 3 },
    })
    tool(
      h,
      S,
      "msg_a1",
      "prt_user",
      "bash",
      { status: "running", input: { command: "rm -rf /tmp/x" }, time: { start: T0 + 4 } },
      "call_u",
    )
    h.ingest.decision({
      requestID: "per_u",
      sessionID: S,
      permission: "bash",
      patterns: ["rm *"],
      askedAt: T0 + 5,
      decidedAt: T0 + 6,
      decision: "deny",
      who: "me",
      tool: { messageID: "msg_a1", callID: "call_u" },
    })
    tool(
      h,
      S,
      "msg_a1",
      "prt_user",
      "bash",
      {
        status: "error",
        input: { command: "rm -rf /tmp/x" },
        error: new PermissionV1.RejectedError({}).message,
        time: { start: T0 + 4, end: T0 + 7 },
      },
      "call_u",
    )
    tool(h, S, "msg_a1", "prt_fail", "read", {
      status: "error",
      input: { path: "/nope" },
      error: "File not found",
      time: { start: T0 + 8, end: T0 + 9 },
    })
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 1, completed: T0 + 10, finish: "tool-calls" })
    idle(h, S)
    h.flush()
    expect(h.store.span("tool:prt_rule")).toMatchObject({ status: "denied", error_type: "rule_denied" })
    expect(h.store.span("tool:prt_user")).toMatchObject({ status: "denied", error_type: "user_denied" })
    expect(h.store.span("tool:prt_fail")).toMatchObject({
      status: "error",
      error_type: "tool_error",
      error_message: "File not found",
    })
    // The turn stopped on the person's rejection.
    expect(h.store.span("turn:msg_u1")).toMatchObject({ status: "denied", error_type: "user_denied" })
    expect(h.store.session(S)).toMatchObject({ denials: 2, errors: 1, status: "denied" })
    expect(h.store.span("perm:per_u")).toMatchObject({ decision: "deny", end_ms: T0 + 6 })
  })

  test("possible loops: each rule matches its case; a poll whose result changes doesn't match", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const run = (turn: string, calls: Array<{ input: unknown; output: string; tool?: string }>) => {
      user(h, S, `msg_${turn}`, h.now())
      assistant(h, S, `msg_${turn}_a`, `msg_${turn}`, { created: h.now() })
      calls.forEach((call, index) => {
        h.at(h.now() + 10)
        tool(h, S, `msg_${turn}_a`, `prt_${turn}_${index}`, call.tool ?? "bash", {
          status: "completed",
          input: call.input,
          output: call.output,
          title: "",
          metadata: {},
          time: { start: h.now(), end: h.now() + 5 },
        })
      })
      assistant(h, S, `msg_${turn}_a`, `msg_${turn}`, { created: h.now(), completed: h.now() + 1, finish: "stop" })
      idle(h, S)
    }
    const same = { input: { command: "npm test", flags: { b: 1, a: 2 } }, output: "fail" }
    run("t1", [same, { input: { flags: { a: 2, b: 1 }, command: "npm test" }, output: "fail" }, same])
    run(
      "t2",
      Array.from({ length: 5 }, (_, i) => ({ input: { command: "curl status" }, output: `progress ${i}` })),
    )
    run(
      "t3",
      Array.from({ length: 4 }, (_, i) => ({ input: { command: "curl status" }, output: `progress ${i}` })),
    )
    run(
      "t4",
      Array.from({ length: 51 }, (_, i) => ({ input: { path: `f${i}` }, output: "x", tool: "read" })),
    )
    user(h, S, "msg_t5", h.now())
    h.event("permission.asked", {
      id: "per_doom",
      sessionID: S,
      permission: "doom_loop",
      patterns: ["bash"],
      metadata: {},
      always: [],
    })
    idle(h, S)
    h.flush()
    expect(h.store.span("turn:msg_t1")!.loop).toBe("same-call-same-result")
    expect(h.store.span("turn:msg_t2")!.loop).toBe("same-call")
    expect(h.store.span("turn:msg_t3")!.loop).toBeNull()
    expect(h.store.span("turn:msg_t4")!.loop).toBe("many-tool-calls")
    expect(h.store.span("turn:msg_t5")!.loop).toBe("opencode-doom-loop")
  })

  test("a recorded call replaces its message's row; attempts are numbered, and totals don't double", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    assistant(h, S, "msg_a1", "msg_u1", {
      created: T0 + 1,
      completed: T0 + 900,
      finish: "stop",
      cost: 0.03,
      tokens: { input: 200, output: 30, read: 1000 },
    })
    h.flush()
    expect(h.store.span("msg:msg_a1")).toBeDefined()
    const call = (id: string, fields: Partial<OperatorCallStore.Call>): OperatorCallStore.Call => ({
      callID: id,
      sessionID: S,
      kind: "agent",
      userMessageID: "msg_u1",
      assistantMessageID: "msg_a1",
      model: "claude-sonnet-4-5",
      providerID: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      format: "anthropic",
      startedAt: T0 + 10,
      request: { body: {} as never, bytes: 10, exact: true, headers: {} },
      ...fields,
    })
    const calls = [
      call("c1", { finishedAt: T0 + 200, httpStatus: 429, error: { status: 429, message: "rate limited" } }),
      call("c2", { startedAt: T0 + 300, firstByteAt: T0 + 450, finishedAt: T0 + 880, httpStatus: 200, retryOf: "c1" }),
      call("c3", {
        kind: "title",
        assistantMessageID: undefined,
        startedAt: T0 + 5,
        finishedAt: T0 + 50,
        httpStatus: 200,
      }),
    ]
    const batch = h.batch()
    for (const span of OperatorTelemetryCalls.spans({ sessionID: S, calls, ingest: h.ingest })) batch.span(span)
    // The message updated again: still the call stands for it.
    assistant(h, S, "msg_a1", "msg_u1", {
      created: T0 + 1,
      completed: T0 + 900,
      finish: "stop",
      cost: 0.03,
      tokens: { input: 200, output: 30, read: 1000 },
    })
    h.flush()
    expect(h.store.span("msg:msg_a1")).toBeUndefined()
    expect(h.store.span("call:c1")).toMatchObject({
      attempt: 1,
      attempts: 2,
      status: "error",
      http_status: 429,
      error_type: "http_429",
      tokens_input: null,
    })
    expect(h.store.span("call:c2")).toMatchObject({
      attempt: 2,
      attempts: 2,
      status: "ok",
      ttft_ms: 150,
      tokens_input: 200,
      tokens_cache_read: 1000,
      cost: 0.03,
      parent_id: "turn:msg_u1",
      source: "recorded-call",
    })
    expect(JSON.parse(h.store.span("call:c3")!.attrs!)).toMatchObject({ callKind: "title", side: true })
    idle(h, S)
    h.flush()
    expect(h.store.span("turn:msg_u1")).toMatchObject({ cost: 0.03, tokens_input: 200 })
    expect(JSON.parse(h.store.span("turn:msg_u1")!.attrs!).modelCalls).toBe(3)
    expect(h.store.session(S)).toMatchObject({ cost: 0.03, model_calls: 3 })
  })

  test("a subagent sits under its task tool call; its session's cost goes into the parent's total", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    h.contexts.set("ses_child", { parentID: S, rootID: S, agentType: "subagent" })
    h.contexts.set(S, { rootID: S, agentType: "usual" })
    user(h, S, "msg_u1", T0)
    assistant(h, S, "msg_a1", "msg_u1", {
      created: T0 + 1,
      completed: T0 + 100,
      cost: 0.1,
      tokens: { input: 1, output: 1 },
    })
    tool(h, S, "msg_a1", "prt_task", "task", {
      status: "running",
      input: { subagent_type: "explore", prompt: "look" },
      metadata: { sessionId: "ses_child" },
      time: { start: T0 + 10 },
    })
    h.event("session.created", {
      sessionID: "ses_child",
      info: { id: "ses_child", parentID: S, title: "explore", directory: "/work/app" },
    })
    user(h, "ses_child", "msg_cu", T0 + 11, "look", "explore")
    assistant(h, "ses_child", "msg_ca", "msg_cu", {
      created: T0 + 12,
      completed: T0 + 40,
      cost: 0.2,
      tokens: { input: 1, output: 1 },
      agent: "explore",
    })
    idle(h, "ses_child")
    idle(h, S)
    h.flush()
    expect(h.store.span("sub:ses_child")).toMatchObject({
      kind: "subagent",
      parent_id: "tool:prt_task",
      name: "invoke_agent explore",
      session_id: S,
    })
    expect(h.store.span("turn:msg_cu")).toMatchObject({ parent_id: "sub:ses_child", session_id: "ses_child" })
    expect(h.store.session("ses_child")).toMatchObject({ parent_id: S, cost: 0.2 })
    const parent = h.store.session(S)!
    expect(parent.cost).toBeCloseTo(0.1)
    expect(parent.cost_total).toBeCloseTo(0.3)
    expect(parent.subagents).toBe(1)
    // The parent's turn counts its own calls only.
    expect(h.store.span("turn:msg_u1")!.cost).toBeCloseTo(0.1)
  })

  test("helper runs carry their own totals beside the session's turn; they aren't the session's cost", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    h.ingest.helper({
      id: "run1",
      helper: "dynamic-generator",
      purpose: "dynamic layer",
      sessionID: S,
      model: "claude-haiku",
      startedAt: T0 + 1,
      endedAt: T0 + 801,
      ok: true,
      tokens: { input: 300, output: 40 },
      cost: 0.001,
    })
    h.ingest.helper({
      id: "run2",
      helper: "purpose-generator",
      startedAt: T0,
      endedAt: T0 + 5,
      ok: false,
      error: "no model",
    })
    h.flush()
    expect(h.store.span("helper:run1")).toMatchObject({
      kind: "helper_run",
      name: "invoke_agent dynamic-generator",
      parent_id: "turn:msg_u1",
      agent_type: "helper",
      duration_ms: 800,
      tokens_input: 300,
      cost: 0.001,
      status: "ok",
    })
    expect(JSON.parse(h.store.span("helper:run1")!.attrs!)).toMatchObject({ purpose: "dynamic layer" })
    expect(h.store.span("helper:run2")).toMatchObject({ status: "error", error_message: "no model", session_id: null })
    expect(h.store.session(S)!.cost).toBe(0)
  })

  test("Trash shows a session In Trash and keeps its rows; deleted for good, its rows and title go, its log lines lose the link", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    idle(h, S)
    h.batch().log({
      id: "log:1:0",
      time_ms: T0,
      level: "ERROR",
      message: "boom",
      run: null,
      service: null,
      session_id: S,
      fields: null,
    })
    h.contexts.set(S, { title: "Fix the test" })
    h.flush()
    h.ingest.trash([S], true)
    h.contexts.set(S, { title: "Fix the test", trashed: true })
    h.flush()
    expect(h.store.session(S)).toMatchObject({ status: "trash", trashed: 1, title: "Fix the test" })
    h.ingest.trash([S], false)
    h.contexts.set(S, { title: "Fix the test", trashed: false })
    h.flush()
    expect(h.store.session(S)!.status).toBe("idle")
    h.event("session.deleted", { sessionID: S, info: { id: S } })
    h.flush()
    expect(h.store.session(S)).toBeUndefined()
    expect(h.store.spansOfSession(S)).toEqual([])
    expect(h.store.logs()[0]!.session_id).toBeNull()
  })

  test("processing the same events twice gives the same rows", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    const feed = () => {
      user(h, S, "msg_u1", T0)
      assistant(h, S, "msg_a1", "msg_u1", {
        created: T0 + 1,
        completed: T0 + 2,
        cost: 0.01,
        tokens: { input: 1, output: 1 },
      })
      tool(h, S, "msg_a1", "prt_t1", "bash", {
        status: "completed",
        input: { command: "ls" },
        output: "",
        title: "",
        metadata: {},
        time: { start: T0 + 1, end: T0 + 2 },
      })
      idle(h, S)
      h.flush()
    }
    feed()
    const first = h.store.spansOfSession(S).map(({ seq, ...span }) => span)
    feed()
    expect(h.store.spansOfSession(S).map(({ seq, ...span }) => span)).toEqual(first)
    expect(h.store.session(S)!.turns).toBe(1)
  })

  test("spans a stopped server left running become interrupted, ended at its last write", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0)
    tool(h, S, "msg_u1", "prt_t1", "bash", { status: "running", input: {}, time: { start: T0 + 5 } })
    h.at(T0 + 100)
    h.flush()
    OperatorTelemetryWriter.interrupt(h.store, { started: T0 + 1000, loops: h.loops, now: T0 + 2000 })
    expect(h.store.span("turn:msg_u1")).toMatchObject({
      status: "interrupted",
      error_type: "server_restart",
      end_ms: T0 + 100,
    })
    expect(h.store.span("tool:prt_t1")).toMatchObject({ status: "interrupted", end_ms: T0 + 100 })
    expect(h.store.session(S)!.status).toBe("interrupted")
  })

  test("past the backlog limit rows are dropped and counted; nothing throws", async () => {
    const batch = new OperatorTelemetryBatch.Batch(3)
    for (let i = 0; i < 5; i++) batch.span({ id: `turn:${i}`, kind: "turn", start_ms: i })
    // A row already waiting still merges.
    batch.span({ id: "turn:0", kind: "turn", status: "ok" })
    expect(batch.spans.size).toBe(3)
    expect(batch.dropped).toBe(2)
    expect(batch.spans.get("turn:0")).toMatchObject({ status: "ok", start_ms: 0 })
  })

  test("nothing of a session's content reaches the store", async () => {
    await using tmp = await tmpdir()
    const h = harness(tmp.path)
    user(h, S, "msg_u1", T0, "my prompt SECRET-PROMPT-7731")
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 1 })
    tool(h, S, "msg_a1", "prt_t1", "bash", {
      status: "completed",
      input: { command: "echo SECRET-ARGS-4410" },
      output: "SECRET-OUTPUT-9902",
      title: "echo",
      metadata: {},
      time: { start: T0 + 2, end: T0 + 3 },
    })
    assistant(h, S, "msg_a1", "msg_u1", { created: T0 + 1, completed: T0 + 4, finish: "stop" })
    idle(h, S)
    h.flush()
    h.store.close()
    const files = await fs.readdir(tmp.path)
    for (const file of files) {
      const bytes = await fs.readFile(path.join(tmp.path, file), "latin1")
      for (const secret of ["SECRET-PROMPT-7731", "SECRET-ARGS-4410", "SECRET-OUTPUT-9902"])
        expect(bytes).not.toContain(secret)
    }
  })

  test("names follow the OpenTelemetry GenAI conventions", () => {
    expect(OperatorTelemetryNames.name("turn", "build")).toBe("invoke_agent build")
    expect(OperatorTelemetryNames.name("model_call", "gpt-5")).toBe("chat gpt-5")
    expect(OperatorTelemetryNames.name("tool_call", "bash")).toBe("execute_tool bash")
    expect(OperatorTelemetryNames.name("compaction")).toBe("gen_ai.conversation.compacted")
    expect(OperatorTelemetryNames.ATTRIBUTES.tokens_cache_read).toBe("gen_ai.usage.cache_read.input_tokens")
  })
})
