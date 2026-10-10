export * as OperatorCallView from "./call-view"

import { Schema } from "effect"
import { OperatorCallFormat } from "./call-format"
import type { OperatorCallStore } from "./call-store"
import { OperatorCallAccounting } from "./call-accounting"
import { OperatorCallPieces } from "./call-pieces"
import { OperatorResolver } from "./resolver"

// Formats recorded calls (call-store.ts) for the Transcript view: each call's place in the session
// (exchange, step, retry), what it sent compared with earlier calls (system text and tools: the same,
// or changed; messages: seen in an earlier call, or new) with what the chat does not show marked, and
// what came back. Pure: the calls service gives it the calls, their bodies and the session's messages.

const Usage = Schema.Struct({
  input: Schema.optional(Schema.Finite),
  output: Schema.optional(Schema.Finite),
  reasoning: Schema.optional(Schema.Finite),
  cacheRead: Schema.optional(Schema.Finite),
  cacheWrite: Schema.optional(Schema.Finite),
  cost: Schema.optional(Schema.Finite),
}).annotate({ identifier: "OperatorCallUsage" })

const Block = Schema.Struct({
  type: Schema.Literals(["reasoning", "text", "tool-call"]),
  text: Schema.optional(Schema.String),
  encrypted: Schema.optional(Schema.Boolean),
  signature: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String).annotate({ description: "The raw arguments string, as received" }),
}).annotate({ identifier: "OperatorCallBlock" })

export const Received = Schema.Struct({
  parsed: Schema.Boolean,
  blocks: Schema.Array(Block),
  finish: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
  ids: Schema.optional(Schema.Array(Schema.String)),
  raw: Schema.optional(Schema.String).annotate({ description: "A format that could not be read: the raw stream" }),
}).annotate({ identifier: "OperatorCallReceived" })

export const Kind = Schema.Literals(["agent", "title", "compaction", "summary", "other", "unlinked"])

// A call's billed totals, from its accounting (call-accounting.ts): input with cache, output with
// reasoning, both costs, the provider's generation id.
export const Billing = Schema.Struct({
  input: Schema.optional(Schema.Finite),
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  new: Schema.optional(Schema.Finite),
  output: Schema.optional(Schema.Finite),
  reasoning: Schema.Finite,
  unattributed: Schema.optional(Schema.Finite),
  provider: Schema.optional(Schema.Finite),
  opencode: Schema.optional(Schema.Finite),
  generationId: Schema.optional(Schema.String),
  uncertain: Schema.optional(Schema.Literals(["estimate", "counted"])),
  unrecognized: Schema.Finite,
}).annotate({ identifier: "OperatorCallBilling" })
export type Billing = typeof Billing.Type

export const billingOf = (accounting: OperatorCallAccounting.Accounting): Billing => ({
  ...(accounting.input.billed !== undefined ? { input: accounting.input.billed } : {}),
  cacheRead: accounting.input.cacheRead,
  cacheWrite: accounting.input.cacheWrite,
  ...(accounting.input.new !== undefined ? { new: accounting.input.new } : {}),
  ...(accounting.output.billed !== undefined ? { output: accounting.output.billed } : {}),
  reasoning: accounting.output.reasoning,
  ...(accounting.input.unattributed !== undefined ? { unattributed: accounting.input.unattributed } : {}),
  ...(accounting.cost.provider !== undefined ? { provider: accounting.cost.provider } : {}),
  ...(accounting.cost.opencode !== undefined ? { opencode: accounting.cost.opencode } : {}),
  ...(accounting.cost.generationId ? { generationId: accounting.cost.generationId } : {}),
  ...(accounting.input.uncertain ? { uncertain: accounting.input.uncertain } : {}),
  unrecognized: accounting.input.unrecognized,
})

export const Summary = Schema.Struct({
  callID: Schema.String,
  index: Schema.Finite.annotate({ description: "1-based, in the order calls started" }),
  kind: Kind,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  userMessageID: Schema.optional(Schema.String),
  assistantMessageID: Schema.optional(Schema.String),
  exchange: Schema.optional(Schema.Finite).annotate({ description: "The user message the call answers, 1-based" }),
  step: Schema.optional(Schema.Finite).annotate({ description: "Agent steps: the step within its exchange" }),
  retryOf: Schema.optional(
    Schema.Struct({ callID: Schema.String, index: Schema.Finite, attempt: Schema.Finite }),
  ).annotate({
    description: "A later attempt: the attempt before it (its id and index) and this call's attempt number",
  }),
  attempt: Schema.Finite.annotate({ description: "Its attempt of the step (1-based); side calls: 1" }),
  attempts: Schema.Finite.annotate({ description: "How many attempts the step took" }),
  failed: Schema.Boolean.annotate({
    description: "Failed: an error, or a later attempt of the same step replaced it",
  }),
  waitBefore: Schema.optional(Schema.Finite).annotate({
    description: "Milliseconds between the previous attempt's end and this one's start",
  }),
  format: Schema.String,
  endpoint: Schema.String,
  startedAt: Schema.Finite,
  firstByteAt: Schema.optional(Schema.Finite),
  finishedAt: Schema.optional(Schema.Finite),
  receiving: Schema.Boolean.annotate({ description: "Sent, and the response is not complete yet" }),
  httpStatus: Schema.optional(Schema.Finite),
  error: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.Finite),
      message: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
    }),
  ),
  usage: Schema.optional(Usage).annotate({ description: "As the provider reported it in the stream" }),
  cost: Schema.optional(Schema.Finite).annotate({ description: "OpenCode's cost of the step (its step-finish part)" }),
  bytes: Schema.Finite,
  exact: Schema.Boolean.annotate({ description: "The body is rebuilt byte for byte (else kept whole)" }),
  system: Schema.Struct({
    chars: Schema.Finite,
    sameAs: Schema.optional(Schema.Finite).annotate({ description: "The latest earlier call with the same text" }),
    changed: Schema.Boolean.annotate({ description: "Differs from the previous call of this agent" }),
  }),
  tools: Schema.Struct({
    count: Schema.Finite,
    sameAs: Schema.optional(Schema.Finite),
    changed: Schema.Boolean,
  }),
  messages: Schema.Struct({
    total: Schema.Finite,
    new: Schema.Finite.annotate({ description: "Messages no earlier call sent" }),
  }),
  billing: Schema.optional(Billing).annotate({ description: "The call's billed tokens and costs (its accounting)" }),
  added: Schema.Array(
    Schema.Literals(["reminder.plan", "reminder.plan-mode", "reminder.build-switch", "notice.max-steps"]),
  ).annotate({
    description:
      "Texts OpenCode added to this request in memory (not saved): the plan reminders, the switch back to building, the step-limit notice",
  }),
}).annotate({ identifier: "OperatorCallSummary" })
export type Summary = typeof Summary.Type

export const Exchange = Schema.Struct({
  userMessageID: Schema.String,
  index: Schema.Finite,
  text: Schema.String,
  time: Schema.Finite,
  recorded: Schema.Boolean.annotate({ description: "Whether any call of it was recorded" }),
}).annotate({ identifier: "OperatorCallExchange" })

const BaseFields = {
  calls: Schema.Array(Summary),
  exchanges: Schema.Array(Exchange),
  totals: Schema.Struct({
    calls: Schema.Finite,
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cacheRead: Schema.Finite,
    cost: Schema.Finite,
  }),
}
const BaseList = Schema.Struct(BaseFields)
export type Base = typeof BaseList.Type

export const List = Schema.Struct({
  ...BaseFields,
  turns: Schema.Array(OperatorCallAccounting.Turn).annotate({
    description: "Each turn's calls and totals (its user message and everything the agent did for it)",
  }),
  session: OperatorCallAccounting.SessionTotals,
  unrecorded: Schema.Array(OperatorCallAccounting.Unrecorded).annotate({
    description: "Steps OpenCode stored that were not recorded (their totals from OpenCode's stored usage)",
  }),
  availability: OperatorCallAccounting.Availability,
}).annotate({ identifier: "OperatorCallList" })
export type List = typeof List.Type

export const Mark = Schema.Literals(["in-memory", "cleared", "compaction", "cache", "image", "file"]).annotate({
  description:
    "in-memory: added by OpenCode for this request, not saved; cleared: an old tool output OpenCode replaced; compaction: the summary of earlier history; cache: a prompt-cache marker; image, file: an attachment",
})

export const Message = Schema.Struct({
  index: Schema.Finite,
  role: Schema.String,
  seenIn: Schema.optional(Schema.Finite).annotate({ description: "The first earlier call that sent it" }),
  marks: Schema.Array(Mark),
  content: Schema.Unknown.annotate({ description: "The message as sent, in the provider's format" }),
}).annotate({ identifier: "OperatorCallMessage" })

// A Dynamic layer of the request, as the pipeline resolved it (dynamic-layers.ts, profile.ts).
export const Resolution = Schema.Struct({
  layer: Schema.String,
  name: Schema.String,
  parity: Schema.optional(Schema.Literals(["same", "differs"])).annotate({
    description: "One of OpenCode's layers: whether the pipeline's text was OpenCode's (when not, OpenCode's was sent)",
  }),
  resolution: OperatorResolver.Trace,
}).annotate({ identifier: "OperatorCallResolution" })

export const Detail = Schema.Struct({
  ...Summary.fields,
  systemText: Schema.optional(Schema.String),
  previousSystem: Schema.optional(
    Schema.Struct({ index: Schema.Finite, text: Schema.String }).annotate({ identifier: "OperatorCallPreviousSystem" }),
  ),
  toolsValue: Schema.optional(Schema.Unknown).annotate({ description: "The tools value as sent" }),
  toolNames: Schema.Array(Schema.String),
  toolsDiff: Schema.optional(
    Schema.Struct({
      index: Schema.Finite,
      added: Schema.Array(Schema.String),
      removed: Schema.Array(Schema.String),
      changed: Schema.Array(Schema.String),
    }).annotate({ identifier: "OperatorCallToolsDiff" }),
  ),
  sent: Schema.Array(Message),
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  received: Schema.optional(Received),
  warnings: Schema.Array(Schema.Literals(["reasoning-not-stored", "text-differs", "tool-calls-differ"])),
  accounting: Schema.optional(OperatorCallAccounting.Accounting).annotate({
    description: "Every billed token of the call, by item",
  }),
  resolutions: Schema.optional(Schema.Array(Resolution)).annotate({
    description: "How the request's Dynamic layers were resolved: every candidate, and why it was chosen or not",
  }),
}).annotate({ identifier: "OperatorCallDetail" })
export type Detail = typeof Detail.Type

// What the calls service gives: each call with its parsed body, and the session's stored messages.
export type Input = {
  calls: ReadonlyArray<{ call: OperatorCallStore.Call; body?: Record<string, unknown>; hashes: string[] }>
  messages: ReadonlyArray<{
    // A user message's `summary` is its file diffs; an assistant's `summary: true` is a compaction summary.
    info: { id: string; role: string; parentID?: string; agent?: string; summary?: unknown; time: { created: number } }
    parts: ReadonlyArray<Record<string, unknown>>
  }>
}

// ---- Reading a body (call-pieces.ts) ----

const { sections, toolNames, SYSTEM_ROLES, IN_MEMORY_LINES, IN_MEMORY, CLEARED, textOf } = OperatorCallPieces
export { sections, toolNames }

const roleOf = (item: unknown) => {
  const record = (item ?? {}) as Record<string, unknown>
  return String(record.role ?? record.type ?? "?")
}

function marksOf(item: unknown, saved: (text: string) => boolean, summaries: ReadonlyArray<string>) {
  const json = JSON.stringify(item ?? null)
  const marks = new Set<typeof Mark.Type>()
  for (const line of IN_MEMORY)
    if (json.includes(JSON.stringify(line).slice(1, -1)) && !saved(line)) marks.add("in-memory")
  if (json.includes(CLEARED)) marks.add("cleared")
  if (
    json.includes("What did we do so far?") ||
    summaries.some((text) => text && json.includes(JSON.stringify(text).slice(1, -1)))
  )
    marks.add("compaction")
  if (json.includes("cache_control") || json.includes("cachePoint") || json.includes('"cache"')) marks.add("cache")
  if (/"type":"(image|image_url|input_image)"/.test(json) || json.includes('"inlineData"')) marks.add("image")
  if (/"type":"(file|input_file|document)"/.test(json) || json.includes('"fileData"')) marks.add("file")
  return [...marks]
}

// The in-memory texts a body carries that no stored message holds.
function addedTo(body: Record<string, unknown> | undefined, savedTexts: ReadonlyArray<string>) {
  if (!body) return []
  const json = JSON.stringify(body)
  return IN_MEMORY_LINES.filter(
    (item) =>
      json.includes(JSON.stringify(item.line).slice(1, -1)) && !savedTexts.some((text) => text.includes(item.line)),
  ).map((item) => item.id)
}

// ---- Summaries ----

type Built = {
  summary: Summary
  system: string
  tools: Array<{ name: string; json: string }>
  messageKeys: string[]
}

function build(input: Input): Built[] {
  const users = input.messages.filter((message) => message.info.role === "user")
  const exchangeOf = (id?: string) => {
    const index = users.findIndex((message) => message.info.id === id)
    return index >= 0 ? index + 1 : undefined
  }
  const stepFinish = (id?: string) => {
    const message = input.messages.find((item) => item.info.id === id)
    const parts = message?.parts.filter((part) => part.type === "step-finish") ?? []
    return parts.length ? { cost: parts.reduce((sum, part) => sum + (Number(part.cost) || 0), 0) } : undefined
  }
  const savedTexts = input.messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")),
  )
  // Attempts: the calls of one step share its assistant message (a retry after an error repeats the
  // request); without one, the retry chain links them.
  const groupOf = new Map<string, string>()
  for (const { call } of input.calls)
    groupOf.set(
      call.callID,
      call.assistantMessageID ?? (call.retryOf ? (groupOf.get(call.retryOf) ?? call.retryOf) : call.callID),
    )
  const groups = new Map<string, string[]>()
  for (const { call } of input.calls) {
    const key = groupOf.get(call.callID)!
    groups.set(key, [...(groups.get(key) ?? []), call.callID])
  }
  const byID = new Map(input.calls.map(({ call }) => [call.callID, call]))
  const stepOf = new Map<string, number>()

  const built: Built[] = []
  const seen = new Map<string, number>()
  const steps = new Map<number, number>()
  input.calls.forEach(({ call, body, hashes }, position) => {
    const index = position + 1
    const parts = sections(body)
    const tools = toolNames(body)
    // The message hashes, without system-role items.
    const list = parts.messagesKey ? (body?.[parts.messagesKey] as unknown[]) : []
    const keys = hashes.filter((_, at) => !SYSTEM_ROLES.includes(String((list[at] as Record<string, unknown>)?.role)))
    const fresh = keys.filter((key) => !seen.has(key)).length
    keys.forEach((key) => {
      if (!seen.has(key)) seen.set(key, index)
    })
    const sameSystem = built.findLast((item) => item.system === parts.system)
    const sameTools = built.findLast((item) => JSON.stringify(item.tools) === JSON.stringify(tools))
    const previous = built.findLast((item) => item.summary.agent === call.agent && item.summary.kind === call.kind)
    const exchange = exchangeOf(call.userMessageID)
    const group = groups.get(groupOf.get(call.callID)!)!
    const attempt = group.indexOf(call.callID) + 1
    const attempts = group.length
    // A step's number: its place among the turn's steps; all its attempts share it.
    let step = stepOf.get(groupOf.get(call.callID)!)
    if (step === undefined && call.kind === "agent" && exchange !== undefined) {
      step = (steps.get(exchange) ?? 0) + 1
      steps.set(exchange, step)
      stepOf.set(groupOf.get(call.callID)!, step)
    }
    const before = attempt > 1 ? byID.get(group[attempt - 2]!) : undefined
    const retried = before ? built.find((item) => item.summary.callID === before.callID) : undefined
    const failed = !!call.error || (call.httpStatus ?? 0) >= 400 || attempt < attempts
    // The step's stored cost belongs to its last attempt (the one that produced the stored message).
    const cost = call.kind === "agent" && attempt === attempts ? stepFinish(call.assistantMessageID)?.cost : undefined
    built.push({
      system: parts.system,
      tools,
      messageKeys: keys,
      summary: {
        callID: call.callID,
        index,
        kind: call.kind,
        ...(call.agent ? { agent: call.agent } : {}),
        ...(call.model ? { model: call.model } : {}),
        ...(call.userMessageID ? { userMessageID: call.userMessageID } : {}),
        ...(call.assistantMessageID ? { assistantMessageID: call.assistantMessageID } : {}),
        ...(exchange !== undefined ? { exchange } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(retried ? { retryOf: { callID: retried.summary.callID, index: retried.summary.index, attempt } } : {}),
        attempt,
        attempts,
        failed,
        ...(before?.finishedAt ? { waitBefore: Math.max(0, call.startedAt - before.finishedAt) } : {}),
        format: call.format,
        endpoint: call.endpoint,
        startedAt: call.startedAt,
        ...(call.firstByteAt ? { firstByteAt: call.firstByteAt } : {}),
        ...(call.finishedAt ? { finishedAt: call.finishedAt } : {}),
        receiving: !call.finishedAt,
        ...(call.httpStatus ? { httpStatus: call.httpStatus } : {}),
        ...(call.error ? { error: call.error } : {}),
        ...(call.response?.usage ? { usage: call.response.usage } : {}),
        ...(cost !== undefined ? { cost } : {}),
        bytes: call.request.bytes,
        exact: call.request.exact,
        system: {
          chars: parts.system.length,
          ...(sameSystem ? { sameAs: sameSystem.summary.index } : {}),
          changed: !!previous && previous.system !== parts.system,
        },
        tools: {
          count: tools.length,
          ...(sameTools && tools.length ? { sameAs: sameTools.summary.index } : {}),
          changed: !!previous && JSON.stringify(previous.tools) !== JSON.stringify(tools),
        },
        messages: { total: keys.length, new: fresh },
        added: addedTo(body, savedTexts),
      },
    })
  })
  return built
}

export function list(input: Input): Base {
  const built = build(input)
  const recorded = new Set(built.flatMap((item) => (item.summary.userMessageID ? [item.summary.userMessageID] : [])))
  const exchanges = input.messages
    .filter((message) => message.info.role === "user")
    .map((message, index) => ({
      userMessageID: message.info.id,
      index: index + 1,
      text: message.parts
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => String(part.text ?? ""))
        .join(" ")
        .slice(0, 200),
      time: message.info.time.created,
      recorded: recorded.has(message.info.id),
    }))
  const sum = (pick: (usage: NonNullable<Summary["usage"]>) => number | undefined) =>
    built.reduce((total, item) => total + (item.summary.usage ? (pick(item.summary.usage) ?? 0) : 0), 0)
  return {
    calls: built.map((item) => item.summary),
    exchanges,
    totals: {
      calls: built.length,
      input: sum((usage) => usage.input),
      output: sum((usage) => usage.output),
      reasoning: sum((usage) => usage.reasoning),
      cacheRead: sum((usage) => usage.cacheRead),
      cost: built.reduce((total, item) => total + (item.summary.cost ?? item.summary.usage?.cost ?? 0), 0),
    },
  }
}

export function detail(input: Input, callID: string): Detail | undefined {
  const built = build(input)
  const at = built.findIndex((item) => item.summary.callID === callID)
  if (at < 0) return undefined
  const item = built[at]!
  const { call, body } = input.calls[at]!
  const parts = sections(body)
  const savedTexts = input.messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")),
  )
  const saved = (line: string) => savedTexts.some((text) => text.includes(line))
  const summaries = input.messages
    .filter((message) => message.info.role === "assistant" && message.info.summary === true)
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")))
  // Where each message was first sent.
  const firstSeen = new Map<string, number>()
  for (const earlier of built.slice(0, at))
    for (const key of earlier.messageKeys) if (!firstSeen.has(key)) firstSeen.set(key, earlier.summary.index)
  const sent = parts.messages.map((content, index) => {
    const key = item.messageKeys[index]
    const seenIn = key ? firstSeen.get(key) : undefined
    return {
      index: index + 1,
      role: roleOf(content),
      ...(seenIn !== undefined ? { seenIn } : {}),
      marks: marksOf(content, saved, summaries),
      content,
    }
  })
  const previous = built
    .slice(0, at)
    .findLast((other) => other.summary.agent === item.summary.agent && other.summary.kind === item.summary.kind)
  const toolsDiff =
    previous && item.summary.tools.changed
      ? {
          index: previous.summary.index,
          added: item.tools
            .filter((tool) => !previous.tools.some((other) => other.name === tool.name))
            .map((tool) => tool.name),
          removed: previous.tools
            .filter((tool) => !item.tools.some((other) => other.name === tool.name))
            .map((tool) => tool.name),
          changed: item.tools
            .filter((tool) => previous.tools.some((other) => other.name === tool.name && other.json !== tool.json))
            .map((tool) => tool.name),
        }
      : undefined
  // The stored parts against what the provider sent: reasoning OpenCode did not keep, other text or calls.
  const warnings: Array<Detail["warnings"][number]> = []
  const message = input.messages.find((entry) => entry.info.id === call.assistantMessageID)
  if (message && call.response?.parsed && item.summary.attempt === item.summary.attempts) {
    const blocks = call.response.blocks
    const stored = message.parts
    const reasoning = blocks.some((block) => block.type === "reasoning" && block.text)
    if (reasoning && !stored.some((part) => part.type === "reasoning")) warnings.push("reasoning-not-stored")
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    const storedText = stored
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => String(part.text ?? ""))
      .join("")
    if (text.trim() !== storedText.trim()) warnings.push("text-differs")
    const calls = blocks.flatMap((block) => (block.type === "tool-call" ? [block.name] : [])).toSorted()
    const storedCalls = stored.flatMap((part) => (part.type === "tool" ? [String(part.tool)] : [])).toSorted()
    if (JSON.stringify(calls) !== JSON.stringify(storedCalls)) warnings.push("tool-calls-differ")
  }
  return {
    ...item.summary,
    ...(parts.system ? { systemText: parts.system } : {}),
    ...(previous && item.summary.system.changed
      ? { previousSystem: { index: previous.summary.index, text: previous.system } }
      : {}),
    ...(body && "tools" in body ? { toolsValue: body.tools } : {}),
    toolNames: item.tools.map((tool) => tool.name),
    ...(toolsDiff ? { toolsDiff } : {}),
    sent,
    parameters: body ? OperatorCallFormat.parameters(body) : {},
    ...(call.response ? { received: call.response as typeof Received.Type } : {}),
    warnings,
  }
}

// ---- Markdown export ----

const fence = (text: string, lang = "") => {
  const ticks = text.includes("```") ? "````" : "```"
  return `${ticks}${lang}\n${text}\n${ticks}`
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  const record = (content ?? {}) as Record<string, unknown>
  const body = record.content ?? record.parts ?? record.output ?? record.arguments
  const text = textOf(body)
  return text || JSON.stringify(content, null, 2)
}

// The transcript as Markdown: each exchange, its calls, what each sent that is new, and what came back.
export function markdown(
  input: Input,
  view: List,
  accountings: ReadonlyArray<OperatorCallAccounting.Accounting> = [],
): string {
  const n = (value: number) => value.toLocaleString("en-US")
  const ROWS: Record<string, string> = {
    agent: "Agent steps",
    side: "Side calls (title, compaction, summary)",
    retries: "Retries and errors",
    session: "**This session**",
    subagents: `Subagent sessions (${view.session.subagents.length}, rolled up)`,
    all: "**With subagents**",
  }
  const out: string[] = [
    "# Transcript",
    "",
    "| | Calls | Input new | Cache read | Cache write | Output | of which reasoning | Cost (OpenCode) | Cost (provider) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...view.session.rows.map(
      (row) =>
        `| ${ROWS[row.id]} | ${row.totals.calls} | ${n(row.totals.new)} | ${n(row.totals.cacheRead)} | ${n(row.totals.cacheWrite)} | ${n(row.totals.output)} | ${n(row.totals.reasoning)} | $${row.totals.cost.toFixed(4)} | $${row.totals.providerCost.toFixed(4)} |`,
    ),
    "",
    "**Where the input tokens went**",
    "",
    "| Part | Tokens | of which cache read |",
    "|---|---:|---:|",
    ...view.session.inputBy.map((item) => `| ${item.group} | ${n(item.tokens)} | ${n(item.cacheRead)} |`),
    "",
    "> This is what the provider received. The provider then turns it into the model's own token format (its chat template), which is not visible here.",
  ]
  const byExchange = new Map<number | undefined, Summary[]>()
  for (const call of view.calls) byExchange.set(call.exchange, [...(byExchange.get(call.exchange) ?? []), call])
  const heading = (exchange: number | undefined) => {
    const found = view.exchanges.find((item) => item.index === exchange)
    const turn = view.turns.find((item) => item.index === (exchange ?? 0))
    const totals = turn
      ? ` · ${turn.totals.calls} calls · in ${n(turn.totals.input)} (cache read ${n(turn.totals.cacheRead)} · new ${n(turn.totals.new)}) · out ${n(turn.totals.output)} (reasoning ${n(turn.totals.reasoning)}) · $${turn.totals.cost.toFixed(4)}`
      : ""
    return found ? `## Turn ${found.index} · You: "${found.text}"${totals}` : `## Other calls${totals}`
  }
  for (const [exchange, calls] of byExchange) {
    out.push("", heading(exchange))
    for (const call of calls) {
      const found = detail(input, call.callID)
      if (!found) continue
      const kind = call.kind === "agent" ? `Agent step ${call.step ?? "?"}` : call.kind
      const usage = call.usage
        ? ` · in ${call.usage.input ?? 0} (cache ${call.usage.cacheRead ?? 0}) · out ${call.usage.output ?? 0} · reasoning ${call.usage.reasoning ?? 0}`
        : ""
      out.push(
        "",
        `### Call ${call.index} · ${kind}${call.agent ? ` · ${call.agent}` : ""}${call.model ? ` · ${call.model}` : ""} · ${new Date(call.startedAt).toISOString()}${usage}`,
        "",
      )
      const accounting = accountings[call.index - 1]
      if (accounting) out.push(...OperatorCallAccounting.markdown(accounting), "")
      out.push("**Sent**", "")
      if (found.systemText)
        out.push(
          call.system.sameAs !== undefined && call.system.sameAs < call.index
            ? `System: same as call ${call.system.sameAs} (${call.system.chars} characters)`
            : `System:\n\n${fence(found.systemText)}`,
        )
      out.push(
        "",
        `Tools: ${found.toolNames.length ? found.toolNames.join(", ") : "none"}${call.tools.sameAs !== undefined && call.tools.sameAs < call.index ? ` (same as call ${call.tools.sameAs})` : ""}`,
      )
      const seen = found.sent.filter((message) => message.seenIn !== undefined).length
      if (seen) out.push("", `Messages 1–${seen}: sent in earlier calls`)
      for (const message of found.sent.filter((item) => item.seenIn === undefined))
        out.push(
          "",
          `${message.index}. **${message.role}**${message.marks.length ? ` _(${message.marks.join(", ")})_` : ""}`,
          "",
          fence(messageText(message.content)),
        )
      out.push("", `Parameters: \`${JSON.stringify(found.parameters)}\``, "", "**Received**", "")
      if (call.error) out.push(`Error ${call.error.status ?? ""}: ${call.error.message ?? call.error.body ?? ""}`)
      for (const block of found.received?.blocks ?? []) {
        if (block.type === "reasoning")
          out.push(
            block.encrypted
              ? "_Reasoning encrypted by the provider; not readable._"
              : `_Reasoning:_\n\n${fence(block.text ?? "")}`,
          )
        if (block.type === "text") out.push(block.text ?? "")
        if (block.type === "tool-call")
          out.push(`Tool call \`${block.name}\` (${block.id ?? ""}):\n\n${fence(block.arguments ?? "", "json")}`)
        out.push("")
      }
      if (found.received && !found.received.parsed) out.push(fence(found.received.raw ?? ""))
      if (found.received?.finish) out.push(`Finish: ${found.received.finish}`)
    }
  }
  return out.join("\n") + "\n"
}
