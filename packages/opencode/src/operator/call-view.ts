export * as OperatorCallView from "./call-view"

import { Schema } from "effect"
import { OperatorCallFormat } from "./call-format"
import type { OperatorCallStore } from "./call-store"
import { OperatorPromptText } from "./prompt-text"

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
  retryOf: Schema.optional(Schema.Struct({ callID: Schema.String, index: Schema.Finite, attempt: Schema.Finite })),
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

export const List = Schema.Struct({
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
}).annotate({ identifier: "OperatorCallDetail" })
export type Detail = typeof Detail.Type

// What the calls service gives: each call with its parsed body, and the session's stored messages.
export type Input = {
  calls: ReadonlyArray<{ call: OperatorCallStore.Call; body?: Record<string, unknown>; hashes: string[] }>
  messages: ReadonlyArray<{
    info: { id: string; role: string; parentID?: string; agent?: string; summary?: boolean; time: { created: number } }
    parts: ReadonlyArray<Record<string, unknown>>
  }>
}

// ---- Reading a body ----

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((item) => {
        if (typeof item === "string") return item
        const record = item as Record<string, unknown>
        if (typeof record?.text === "string") return record.text
        return ""
      })
      .filter(Boolean)
      .join("\n")
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).parts))
    return textOf((value as Record<string, unknown>).parts)
  return ""
}

const SYSTEM_ROLES = ["system", "developer"]

// The system text as sent, and the message list without system-role items.
export function sections(body: Record<string, unknown> | undefined) {
  if (!body) return { system: "", messages: [] as unknown[], messagesKey: undefined as string | undefined }
  const key = ["messages", "input", "contents"].find((name) => Array.isArray(body[name]))
  const list = key ? (body[key] as unknown[]) : []
  const isSystem = (item: unknown) =>
    !!item && typeof item === "object" && SYSTEM_ROLES.includes(String((item as Record<string, unknown>).role))
  const inline = list.filter(isSystem).map((item) => textOf((item as Record<string, unknown>).content))
  const own = [body.system, body.instructions, body.systemInstruction].map(textOf).filter(Boolean)
  return { system: [...own, ...inline].join("\n"), messages: list.filter((item) => !isSystem(item)), messagesKey: key }
}

export function toolNames(body: Record<string, unknown> | undefined) {
  const tools = body?.tools
  if (!Array.isArray(tools)) return [] as Array<{ name: string; json: string }>
  return tools.flatMap((tool) => {
    const record = tool as Record<string, any>
    if (Array.isArray(record.functionDeclarations))
      return record.functionDeclarations.map((item: Record<string, unknown>) => ({
        name: String(item.name),
        json: JSON.stringify(item),
      }))
    const name = record.function?.name ?? record.name
    return name ? [{ name: String(name), json: JSON.stringify(tool) }] : []
  })
}

const roleOf = (item: unknown) => {
  const record = (item ?? {}) as Record<string, unknown>
  return String(record.role ?? record.type ?? "?")
}

// Texts OpenCode adds to a request in memory: the plan reminders, the switch to build, the step limit.
const IN_MEMORY_IDS = ["reminder.plan", "reminder.plan-mode", "reminder.build-switch", "notice.max-steps"] as const
// Each in-memory text by its first plain line, which is how it is found in a body.
const IN_MEMORY_LINES = IN_MEMORY_IDS.map((id) => ({
  id,
  line:
    (OperatorPromptText.BUILTINS.find((item) => item.id === id)?.text ?? "")
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("<"))
      ?.trim() ?? "",
})).filter((item) => item.line)
const IN_MEMORY = IN_MEMORY_LINES.map((item) => item.line)
const CLEARED = "[Old tool result content cleared]"

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
    let step: number | undefined
    if (call.kind === "agent" && exchange !== undefined && !call.retryOf) {
      step = (steps.get(exchange) ?? 0) + 1
      steps.set(exchange, step)
    } else if (call.retryOf) step = built.find((item) => item.summary.callID === call.retryOf)?.summary.step
    const retried = call.retryOf ? built.find((item) => item.summary.callID === call.retryOf) : undefined
    const attempt = retried
      ? built.filter((item) => item.summary.retryOf?.callID === retried.summary.callID).length + 1
      : 0
    const cost = call.kind === "agent" && !call.retryOf ? stepFinish(call.assistantMessageID)?.cost : undefined
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

export function list(input: Input): List {
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
    .filter((message) => message.info.summary)
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
  if (message && call.response?.parsed && !call.retryOf) {
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
export function markdown(input: Input, view: List): string {
  const out: string[] = [
    "# Transcript",
    "",
    `${view.totals.calls} calls · in ${view.totals.input} · out ${view.totals.output} · reasoning ${view.totals.reasoning} · cache read ${view.totals.cacheRead} · $${view.totals.cost.toFixed(4)}`,
    "",
    "> This is what the provider received. The provider then turns it into the model's own token format (its chat template), which is not visible here.",
  ]
  const byExchange = new Map<number | undefined, Summary[]>()
  for (const call of view.calls) byExchange.set(call.exchange, [...(byExchange.get(call.exchange) ?? []), call])
  const heading = (exchange: number | undefined) => {
    const found = view.exchanges.find((item) => item.index === exchange)
    return found
      ? `## Exchange ${found.index} · You · ${new Date(found.time).toISOString()} · ${found.text}`
      : "## Other calls"
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
        "**Sent**",
        "",
      )
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
