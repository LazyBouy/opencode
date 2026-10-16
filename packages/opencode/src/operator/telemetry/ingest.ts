export * as OperatorTelemetryIngest from "./ingest"

import crypto from "crypto"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { OperatorTelemetryBatch } from "./batch"
import { OperatorTelemetryNames } from "./names"
import type { OperatorTelemetryStore } from "./store"

// Events the server already emits, turned into spans (observability_spec.md §5.1–§5.5). Handlers only put rows in the
// batch: no disk access, no awaiting (§5.6). A little state per session assembles turns: a user message starts one
// (unless it is a compaction, or the follow-up OpenCode adds after an automatic compaction), the session going idle or
// the next user message ends it, and its status comes from its last assistant message. Recorded calls and queue items
// are read at the flush (calls.ts, telemetry.ts), from the ids these events carry.

type SpanWrite = OperatorTelemetryStore.SpanWrite

const CUT_ERROR = 500
const cut = (text: string | undefined, length = CUT_ERROR) =>
  text === undefined ? undefined : text.length > length ? text.slice(0, length) : text

// The permission module's own messages (core v1/permission.ts), so a denied tool call is told from a failed one without
// copying their text: a rule's denial ends with the rules, a correction with the feedback.
const REJECTED = new PermissionV1.RejectedError({}).message
const CORRECTED = new PermissionV1.CorrectedError({ feedback: "" }).message
const RULE_DENIED = (() => {
  const message = new PermissionV1.DeniedError({ ruleset: [] }).message
  return message.slice(0, message.length - JSON.stringify([]).length)
})()

/** How a failed tool call's error reads: a person's rejection, a rule's denial, or an error. */
export function toolError(error: string): { status: OperatorTelemetryStore.Status; errorType: string } {
  if (error === REJECTED || (CORRECTED && error.startsWith(CORRECTED)))
    return { status: "denied", errorType: "user_denied" }
  if (error.startsWith(RULE_DENIED)) return { status: "denied", errorType: "rule_denied" }
  return { status: "error", errorType: "tool_error" }
}

type MessageError = { name?: string; data?: { message?: string; statusCode?: number } }

type Assistant = {
  id: string
  userMessageID: string
  turnID?: string
  parentID?: string
  mode?: string
  agent?: string
  model?: string
  provider?: string
  created: number
  completed?: number
  error?: MessageError
  finish?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number; read: number; write: number }
}

type Turn = {
  id: string
  userMessageID: string
  start: number
  lastAssistant?: string
  /** Assistant messages with a tool call a person rejected. */
  denied: Set<string>
  retries: number
}

type User = {
  id: string
  created: number
  agent?: string
  model?: string
  provider?: string
}

type SessionState = {
  id: string
  parentID?: string
  turn?: Turn
  /** Where a user message's assistant messages go: its turn, and the span they sit under. */
  owners: Map<string, { turnID: string; parentID: string }>
  /** User messages waiting for their first part, which says whether they start a turn. */
  pending: Map<string, User>
  assistants: Map<string, Assistant>
  /** Tool call id to its part id (a permission request names the call). */
  parts: Map<string, string>
  /** Tool calls denied by a decision. */
  denied: Set<string>
  /** Assistant messages a recorded call stands for (their `msg:` row is replaced). */
  recorded: Set<string>
  /** Tool parts' argument hashes, worked out once (a running part is updated many times). */
  hashes: Map<string, string>
  compaction?: string
  seen: number
}

/** A session's details as its events give them, for its summary and its spans' context. */
export type Info = { title?: string; directory?: string; projectID?: string; parentID?: string; agent?: string }

/** A permission decision record (permission-decisions.ts `Decided`), as far as telemetry reads it. */
export type Decision = {
  requestID: string
  sessionID: string
  agent?: string
  directory?: string
  project?: string
  permission: string
  patterns: ReadonlyArray<string>
  askedAt: number
  decidedAt: number
  decision: string
  cause?: string
  by?: string
  who?: string
  tool?: { messageID: string; callID: string }
}

/** A helper run (generate.ts), with its own totals: helper calls have no session to be recorded in. */
export type HelperRun = {
  id: string
  helper: string
  purpose?: string
  sessionID?: string
  model?: string
  provider?: string
  startedAt: number
  endedAt: number
  ok: boolean
  error?: string
  tokens?: { input: number; output: number }
  cost?: number
}

export type Options = {
  /** The store's secret, salting argument and result hashes (§4.7). */
  secret: string
  /** The MCP server a tool comes from, when the folder's servers are known. */
  mcpServerOf?: (directory: string | undefined, tool: string) => string | undefined
  now?: () => number
}

export class Ingest {
  private readonly sessions = new Map<string, SessionState>()
  /** Sessions' details from their events (title, folder, parent), for the flush to resolve their context. */
  readonly infos = new Map<string, Info>()
  /** Folders an event came from, by when (an instance is loaded there). */
  readonly folders = new Map<string, number>()
  /** Permission requests waiting for an answer, by request id. */
  private readonly waits = new Map<string, { sessionID: string; start: number }>()
  private readonly now: () => number

  constructor(
    private readonly batch: () => OperatorTelemetryBatch.Batch,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now
  }

  private state(sessionID: string): SessionState {
    let found = this.sessions.get(sessionID)
    if (!found) {
      found = {
        id: sessionID,
        parentID: this.infos.get(sessionID)?.parentID,
        owners: new Map(),
        pending: new Map(),
        assistants: new Map(),
        parts: new Map(),
        denied: new Set(),
        recorded: new Set(),
        hashes: new Map(),
        seen: this.now(),
      }
      this.sessions.set(sessionID, found)
    }
    found.seen = this.now()
    return found
  }

  private write(span: SpanWrite) {
    this.batch().span(span)
  }

  private argsHash(state: SessionState, partID: string, tool: string, input: unknown) {
    const known = state.hashes.get(partID)
    if (known) return known
    const value = this.hash(state.id, `${tool}\u0000${canonical(input)}`)
    state.hashes.set(partID, value)
    return value
  }

  private hash(sessionID: string, value: string) {
    return crypto.createHash("sha256").update(`${sessionID}\u0000${this.options.secret}\u0000${value}`).digest("hex")
  }

  /** One GlobalBus event. */
  handle(event: { directory?: string; payload?: { type?: string; properties?: unknown } }) {
    const type = event.payload?.type
    const properties = (event.payload?.properties ?? {}) as Record<string, any>
    if (event.directory) this.folders.set(event.directory, this.now())
    if (type === "server.instance.disposed" && typeof properties.directory === "string")
      this.folders.delete(properties.directory)
    switch (type) {
      case "message.updated":
        return this.message(properties.info, event.directory)
      case "message.part.updated":
        return this.part(properties.part, event.directory, properties.time)
      case "session.status":
        return this.status(properties.sessionID, properties.status)
      case "session.idle":
        return this.status(properties.sessionID, { type: "idle" })
      case "session.created":
      case "session.updated":
        return this.sessionInfo(properties.info)
      case "session.deleted":
        return this.deleted(properties.sessionID ?? properties.info?.id)
      case "session.compacted":
        return this.compacted(properties.sessionID)
      case "permission.asked":
        return this.asked(properties as PermissionV1.Request, event.directory)
      case "permission.replied":
        if (typeof properties.requestID === "string") this.waits.delete(properties.requestID)
        return
      case "operator.call.recorded":
      case "operator.call.updated":
        if (typeof properties.sessionID === "string") this.batch().calls.add(properties.sessionID)
        return
      case "operator.queue.updated":
        if (typeof properties.id === "string") this.batch().queue.add(properties.id)
        return
    }
  }

  private sessionInfo(info: any) {
    if (!info?.id) return
    const known = this.infos.get(info.id)
    this.infos.set(info.id, {
      title: info.title,
      directory: info.directory,
      projectID: info.projectID,
      parentID: info.parentID,
      agent: info.agent ?? known?.agent,
    })
    const state = this.sessions.get(info.id)
    if (state && info.parentID) state.parentID = info.parentID
    // The title shows in the summary.
    if (known && known.title !== info.title) this.batch().sessions.add(info.id)
  }

  private deleted(sessionID: unknown) {
    if (typeof sessionID !== "string") return
    this.sessions.delete(sessionID)
    this.infos.delete(sessionID)
    this.batch().deleteSession(sessionID)
  }

  /** The span a session's turns sit under: its subagent span, for a child session. */
  private turnParent(state: SessionState) {
    return state.parentID ? `sub:${state.id}` : undefined
  }

  private startTurn(state: SessionState, user: User) {
    if (state.turn) this.endTurn(state, user.created)
    const turn: Turn = {
      id: `turn:${user.id}`,
      userMessageID: user.id,
      start: user.created,
      denied: new Set(),
      retries: 0,
    }
    state.turn = turn
    state.owners.set(user.id, { turnID: turn.id, parentID: turn.id })
    this.write({
      id: turn.id,
      kind: "turn",
      name: OperatorTelemetryNames.name("turn", user.agent),
      parent_id: this.turnParent(state) ?? null,
      turn_id: turn.id,
      session_id: state.id,
      agent: user.agent,
      model: user.model,
      provider: user.provider,
      status: "running",
      start_ms: user.created,
      message_id: user.id,
      source: "message",
    })
    return turn
  }

  private endTurn(state: SessionState, end: number) {
    const turn = state.turn
    if (!turn) return
    state.turn = undefined
    const last = turn.lastAssistant ? state.assistants.get(turn.lastAssistant) : undefined
    const error = last?.error
    const outcome: Pick<SpanWrite, "status" | "error_type" | "error_message"> = error
      ? error.name === "MessageAbortedError"
        ? { status: "cancelled", error_type: "MessageAbortedError" }
        : {
            status: "error",
            error_type: turn.retries > 0 && error.name === "APIError" ? "retries_exhausted" : (error.name ?? "error"),
            ...(error.data?.message ? { error_message: cut(error.data.message) } : {}),
          }
      : last && turn.denied.has(last.id)
        ? { status: "denied", error_type: "user_denied" }
        : { status: "ok" }
    this.write({
      id: turn.id,
      kind: "turn",
      session_id: state.id,
      end_ms: Math.max(end, turn.start),
      ...outcome,
      ...(last?.finish ? { finish_reason: last.finish } : {}),
    })
  }

  private message(info: any, directory: string | undefined) {
    if (!info?.id || !info.sessionID) return
    const state = this.state(info.sessionID)
    if (info.role === "user") {
      if (state.owners.has(info.id)) return
      state.pending.set(info.id, {
        id: info.id,
        created: info.time?.created ?? this.now(),
        agent: info.agent,
        model: info.model?.modelID,
        provider: info.model?.providerID,
      })
      return
    }
    if (info.role !== "assistant") return
    // An assistant message whose user message's parts were not seen: that message started a turn.
    const waiting = state.pending.get(info.parentID)
    if (waiting) {
      state.pending.delete(info.parentID)
      this.startTurn(state, waiting)
    }
    const owner = state.owners.get(info.parentID)
    const assistant: Assistant = {
      id: info.id,
      userMessageID: info.parentID,
      turnID: owner?.turnID,
      parentID: owner?.parentID,
      mode: info.mode,
      agent: info.agent,
      model: info.modelID,
      provider: info.providerID,
      created: info.time?.created ?? this.now(),
      completed: info.time?.completed,
      error: info.error,
      finish: info.finish,
      cost: Number(info.cost) || 0,
      tokens: {
        input: Number(info.tokens?.input) || 0,
        output: Number(info.tokens?.output) || 0,
        reasoning: Number(info.tokens?.reasoning) || 0,
        read: Number(info.tokens?.cache?.read) || 0,
        write: Number(info.tokens?.cache?.write) || 0,
      },
    }
    state.assistants.set(info.id, assistant)
    if (state.turn && owner?.turnID === state.turn.id) state.turn.lastAssistant = info.id
    // A recorded call stands for it, with its timing (calls.ts): its own row would count twice.
    if (!state.recorded.has(info.id)) this.write(this.messageCall(state, assistant, directory))
    else this.batch().calls.add(state.id)
    // The compaction's summary message ends the compaction.
    if (
      info.mode === "compaction" &&
      owner &&
      owner.parentID !== owner.turnID &&
      (info.time?.completed || info.error)
    ) {
      if (state.compaction === owner.parentID) state.compaction = undefined
      this.write({
        id: owner.parentID,
        kind: "compaction",
        session_id: state.id,
        end_ms: info.time?.completed ?? this.now(),
        status: info.error ? "error" : "ok",
        ...(info.error?.name ? { error_type: info.error.name } : {}),
      })
    }
  }

  /** A model call from an assistant message, when its call was not recorded (§5.1): no first byte, status or attempts. */
  private messageCall(state: SessionState, assistant: Assistant, directory: string | undefined): SpanWrite {
    const error = assistant.error
    const status = error
      ? error.name === "MessageAbortedError"
        ? "cancelled"
        : "error"
      : assistant.completed
        ? "ok"
        : "running"
    const http = error?.data?.statusCode
    return {
      id: `msg:${assistant.id}`,
      kind: "model_call",
      name: OperatorTelemetryNames.name("model_call", assistant.model),
      parent_id: assistant.parentID ?? null,
      turn_id: assistant.turnID ?? null,
      session_id: state.id,
      ...(directory ? { directory } : {}),
      agent: assistant.agent,
      model: assistant.model,
      provider: assistant.provider,
      status,
      ...(error ? { error_type: http === 429 ? "http_429" : (error.name ?? "error") } : {}),
      ...(error?.data?.message ? { error_message: cut(error.data.message) } : {}),
      ...(http ? { http_status: http } : {}),
      ...(assistant.finish ? { finish_reason: assistant.finish } : {}),
      start_ms: assistant.created,
      ...(assistant.completed
        ? { end_ms: assistant.completed, duration_ms: Math.max(0, assistant.completed - assistant.created) }
        : {}),
      ...(assistant.completed ? { active_ms: Math.max(0, assistant.completed - assistant.created) } : {}),
      ...this.usage(assistant),
      message_id: assistant.id,
      source: "message",
      attrs: JSON.stringify({ mode: assistant.mode }),
    }
  }

  /** An assistant message's tokens and cost, as OpenCode counts them (input without the cached part). */
  usage(assistant: Pick<Assistant, "tokens" | "cost">) {
    return {
      tokens_input: assistant.tokens.input,
      tokens_output: assistant.tokens.output,
      tokens_reasoning: assistant.tokens.reasoning,
      tokens_cache_read: assistant.tokens.read,
      tokens_cache_write: assistant.tokens.write,
      cost: assistant.cost,
      context_tokens: assistant.tokens.input + assistant.tokens.read + assistant.tokens.write,
    }
  }

  private part(part: any, directory: string | undefined, time: unknown) {
    if (!part?.sessionID || !part.messageID) return
    const state = this.state(part.sessionID)
    const user = state.pending.get(part.messageID)
    if (user) return this.firstPart(state, user, part)
    if (part.type === "tool") return this.tool(state, part, directory, typeof time === "number" ? time : this.now())
  }

  /** A user message's first part says what it is: a compaction, the follow-up after one, or a new turn. */
  private firstPart(state: SessionState, user: User, part: any) {
    state.pending.delete(user.id)
    if (part.type === "compaction") {
      const turn = state.turn ?? this.startTurn(state, user)
      const id = `compact:${user.id}`
      state.compaction = id
      state.owners.set(user.id, { turnID: turn.id, parentID: id })
      this.write({
        id,
        kind: "compaction",
        name: OperatorTelemetryNames.name("compaction"),
        parent_id: turn.id,
        turn_id: turn.id,
        session_id: state.id,
        agent: user.agent,
        status: "running",
        start_ms: user.created,
        message_id: user.id,
        source: "message",
        attrs: JSON.stringify({ auto: part.auto === true }),
      })
      return
    }
    if (part.type === "text" && part.synthetic && part.metadata?.compaction_continue && state.turn) {
      state.owners.set(user.id, { turnID: state.turn.id, parentID: state.turn.id })
      return
    }
    this.startTurn(state, user)
  }

  private tool(state: SessionState, part: any, directory: string | undefined, time: number) {
    const assistant = state.assistants.get(part.messageID)
    const turnID = assistant?.turnID ?? state.turn?.id
    const tool = String(part.tool ?? "")
    const id = `tool:${part.id}`
    state.parts.set(part.callID, part.id)
    const toolState = part.state ?? {}
    const started = toolState.time?.start ?? time
    const ended = toolState.time?.end
    let status: OperatorTelemetryStore.Status = "running"
    let errorType: string | undefined
    if (toolState.status === "completed") status = "ok"
    if (toolState.status === "error") {
      const read = state.denied.has(part.callID)
        ? { status: "denied" as const, errorType: "user_denied" }
        : toolError(String(toolState.error ?? ""))
      status = read.status
      errorType = read.errorType
      if (read.errorType === "user_denied" && assistant) state.turn?.denied.add(assistant.id)
    }
    const input = toolState.status === "pending" ? undefined : toolState.input
    const mcp = this.options.mcpServerOf?.(directory, tool)
    this.write({
      id,
      kind: "tool_call",
      name: OperatorTelemetryNames.name("tool_call", tool),
      parent_id: turnID ?? null,
      turn_id: turnID ?? null,
      session_id: state.id,
      ...(directory ? { directory } : {}),
      agent: assistant?.agent,
      tool,
      ...(mcp ? { mcp_server: mcp } : {}),
      status,
      ...(errorType ? { error_type: errorType } : {}),
      ...(toolState.status === "error" && errorType === "tool_error"
        ? { error_message: cut(String(toolState.error ?? "")) }
        : {}),
      start_ms: started,
      ...(ended ? { end_ms: ended } : {}),
      ...(input !== undefined ? { args_hash: this.argsHash(state, part.id, tool, input) } : {}),
      ...(toolState.status === "completed" ? { result_hash: this.hash(state.id, String(toolState.output ?? "")) } : {}),
      call_id: part.callID,
      message_id: part.messageID,
      part_id: part.id,
      source: "part",
    })
    // The task tool runs a subagent in a child session (§4.3): its turns sit under this span.
    const child = toolState.metadata?.sessionId
    if (tool === "task" && typeof child === "string") {
      const subagent = typeof input?.subagent_type === "string" ? input.subagent_type : undefined
      this.write({
        id: `sub:${child}`,
        kind: "subagent",
        name: OperatorTelemetryNames.name("subagent", subagent),
        parent_id: id,
        turn_id: turnID ?? null,
        session_id: state.id,
        agent: subagent,
        status: status === "denied" ? "error" : status,
        start_ms: started,
        ...(ended ? { end_ms: ended, duration_ms: Math.max(0, ended - started) } : {}),
        part_id: part.id,
        source: "part",
        attrs: JSON.stringify({ sessionID: child }),
      })
      const childState = this.state(child)
      childState.parentID = state.id
    }
  }

  private status(sessionID: unknown, status: any) {
    if (typeof sessionID !== "string" || !status?.type) return
    const state = this.state(sessionID)
    if (status.type === "idle") return this.endTurn(state, this.now())
    if (status.type !== "retry" || !state.turn) return
    const turn = state.turn
    turn.retries += 1
    const attempt = Number(status.attempt) || turn.retries
    const reason = String(status.action?.reason ?? "")
    const message = String(status.message ?? "")
    const limited = /rate.?limit/i.test(reason) || /\b429\b|rate.?limit|too many requests/i.test(message)
    const now = this.now()
    this.write({
      id: `retry:${sessionID}:${turn.id}:${attempt}`,
      kind: "retry",
      name: OperatorTelemetryNames.name("retry", `attempt ${attempt}`),
      parent_id: turn.id,
      turn_id: turn.id,
      session_id: sessionID,
      status: "ok",
      ...(message ? { error_message: cut(message) } : {}),
      ...(limited ? { http_status: 429, error_type: "http_429" } : {}),
      start_ms: now,
      end_ms: now,
      duration_ms: 0,
      attempt,
      source: "status",
      attrs: JSON.stringify({ next: status.next, ...(reason ? { reason } : {}) }),
    })
  }

  private compacted(sessionID: unknown) {
    if (typeof sessionID !== "string") return
    const state = this.sessions.get(sessionID)
    if (!state?.compaction) return
    this.write({ id: state.compaction, kind: "compaction", session_id: sessionID, status: "ok", end_ms: this.now() })
    state.compaction = undefined
  }

  private asked(request: PermissionV1.Request, directory: string | undefined) {
    if (!request?.id || !request.sessionID) return
    const state = this.state(request.sessionID)
    const partID = request.tool ? state.parts.get(request.tool.callID) : undefined
    const turnID = state.turn?.id
    this.waits.set(request.id, { sessionID: request.sessionID, start: this.now() })
    this.write({
      id: `perm:${request.id}`,
      kind: "permission_wait",
      name: OperatorTelemetryNames.name(
        "permission_wait",
        `${request.permission}${request.patterns[0] ? ` (${request.patterns[0]})` : ""}`,
      ),
      parent_id: partID ? `tool:${partID}` : (turnID ?? null),
      turn_id: turnID ?? null,
      session_id: request.sessionID,
      ...(directory ? { directory } : {}),
      status: "running",
      start_ms: this.now(),
      permission: request.permission,
      ...(request.patterns[0] ? { pattern: cut(request.patterns[0]) } : {}),
      ...(request.tool ? { call_id: request.tool.callID, message_id: request.tool.messageID } : {}),
      request_id: request.id,
      source: "decision",
    })
  }

  /** A decision record being written (permission-decisions.ts): it ends the wait, and a denial denies the tool call. */
  decision(record: Decision) {
    this.waits.delete(record.requestID)
    const state = this.state(record.sessionID)
    const partID = record.tool ? state.parts.get(record.tool.callID) : undefined
    const turnID = state.turn?.id
    const cancelled = record.decision === "cancelled"
    this.write({
      id: `perm:${record.requestID}`,
      kind: "permission_wait",
      name: OperatorTelemetryNames.name(
        "permission_wait",
        `${record.permission}${record.patterns[0] ? ` (${record.patterns[0]})` : ""}`,
      ),
      ...(partID ? { parent_id: `tool:${partID}` } : turnID ? { parent_id: turnID } : {}),
      ...(turnID ? { turn_id: turnID } : {}),
      session_id: record.sessionID,
      ...(record.directory ? { directory: record.directory } : {}),
      ...(record.agent ? { agent: record.agent } : {}),
      status: cancelled ? "cancelled" : "ok",
      ...(cancelled && record.cause ? { error_type: record.cause } : {}),
      start_ms: record.askedAt,
      end_ms: record.decidedAt,
      duration_ms: Math.max(0, record.decidedAt - record.askedAt),
      wait_ms: Math.max(0, record.decidedAt - record.askedAt),
      decision: record.decision,
      decision_source: record.cause === "covered" ? "rule" : "user",
      ...(record.who ? { decided_by: record.who } : {}),
      permission: record.permission,
      ...(record.patterns[0] ? { pattern: cut(record.patterns[0]) } : {}),
      ...(record.tool ? { call_id: record.tool.callID, message_id: record.tool.messageID } : {}),
      request_id: record.requestID,
      source: "decision",
    })
    if (record.decision !== "deny" || !record.tool) return
    state.denied.add(record.tool.callID)
    if (partID)
      this.write({
        id: `tool:${partID}`,
        kind: "tool_call",
        session_id: record.sessionID,
        status: "denied",
        error_type: "user_denied",
      })
    const assistant = state.assistants.get(record.tool.messageID)
    if (assistant && state.turn && assistant.turnID === state.turn.id) state.turn.denied.add(assistant.id)
  }

  /** A helper run (generate.ts): a span with its own totals, under the session's turn when a session started it. */
  helper(run: HelperRun) {
    const state = run.sessionID ? this.sessions.get(run.sessionID) : undefined
    const turnID = state?.turn?.id
    this.write({
      id: `helper:${run.id}`,
      kind: "helper_run",
      name: OperatorTelemetryNames.name("helper_run", run.helper),
      parent_id: turnID ?? null,
      turn_id: turnID ?? null,
      ...(run.sessionID ? { session_id: run.sessionID } : {}),
      agent: run.helper,
      agent_type: "helper",
      ...(run.model ? { model: run.model } : {}),
      ...(run.provider ? { provider: run.provider } : {}),
      status: run.ok ? "ok" : "error",
      ...(run.error ? { error_type: "helper_error", error_message: cut(run.error) } : {}),
      start_ms: run.startedAt,
      end_ms: run.endedAt,
      duration_ms: Math.max(0, run.endedAt - run.startedAt),
      active_ms: Math.max(0, run.endedAt - run.startedAt),
      ...(run.tokens ? { tokens_input: run.tokens.input, tokens_output: run.tokens.output } : {}),
      ...(run.cost !== undefined ? { cost: run.cost } : {}),
      source: "helper",
      attrs: JSON.stringify({ ...(run.purpose ? { purpose: run.purpose } : {}), side: true }),
    })
  }

  /** Sessions moved to Trash or restored from it (trash.ts). */
  trash(sessionIDs: ReadonlyArray<string>, trashed: boolean) {
    for (const id of sessionIDs) {
      this.batch().trash.set(id, trashed)
      this.batch().sessions.add(id)
    }
  }

  // ---- what the flush reads ----

  /** A session's assistant message, its turn and the span its calls sit under (calls.ts). */
  assistant(sessionID: string, messageID: string) {
    return this.sessions.get(sessionID)?.assistants.get(messageID)
  }

  /** Where a user message's calls go: its turn and the span under it. */
  owner(sessionID: string, userMessageID: string) {
    return this.sessions.get(sessionID)?.owners.get(userMessageID)
  }

  /** The session's turn that is running. */
  currentTurn(sessionID: string) {
    return this.sessions.get(sessionID)?.turn?.id
  }

  /** A recorded call now stands for this assistant message: its `msg:` row goes. */
  recorded(sessionID: string, messageID: string) {
    const state = this.state(sessionID)
    if (state.recorded.has(messageID)) return
    state.recorded.add(messageID)
    this.batch().deleteSpan(`msg:${messageID}`)
  }

  /** Open approvals and running sessions, for the sampler (§5.9). */
  snapshot() {
    const now = this.now()
    const waiting = new Set([...this.waits.values()].map((wait) => wait.sessionID))
    const oldest = [...this.waits.values()].reduce((low, wait) => Math.min(low, wait.start), Infinity)
    const running = [...this.sessions.values()].filter((state) => state.turn).map((state) => state.id)
    return {
      pending: this.waits.size,
      oldestPendingMs: Number.isFinite(oldest) ? now - oldest : 0,
      running: running.length,
      waitingSessions: waiting.size,
    }
  }

  /** Forgets sessions with nothing running that were quiet for an hour. */
  sweep(maxAge = 60 * 60 * 1000) {
    const now = this.now()
    for (const [id, state] of this.sessions)
      if (!state.turn && now - state.seen > maxAge) {
        this.sessions.delete(id)
        this.infos.delete(id)
      }
    for (const [folder, time] of this.folders) if (now - time > maxAge) this.folders.delete(folder)
  }
}

/** JSON with keys sorted, so the same arguments hash the same (§5.5). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}
