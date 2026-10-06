export * as OperatorCallFormat from "./call-format"

import { createHash } from "crypto"

// Pure helpers for recorded model calls (see provider-tap.ts): splitting a request body into its
// large repeating parts so each is stored once, rebuilding the exact body, and assembling a streamed
// response per provider format. No I/O, no services.

export type Format = "anthropic" | "openai-chat" | "openai-responses" | "google" | "other"

// A stored body: its top-level keys in order; large values are replaced by references to blobs.
export type Stored = Record<string, unknown>
const BLOB = "$operatorBlob"
const BLOBS = "$operatorBlobs"
// A body that could not be rebuilt byte-exact (or is not JSON) is kept whole, under this key.
const RAW = "$operatorRaw"

const MESSAGE_KEYS = ["messages", "input", "contents"]
const SYSTEM_KEYS = ["system", "instructions", "systemInstruction"]

export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

export function detect(url: string, body: Record<string, unknown> | undefined): Format {
  const path = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  })()
  if (path.includes(":streamGenerateContent") || path.includes(":generateContent") || (body && "contents" in body))
    return "google"
  if (path.endsWith("/messages") && body && "messages" in body && !("stream_options" in body)) return "anthropic"
  if (path.endsWith("/responses") || (body && "input" in body && !("messages" in body))) return "openai-responses"
  if (path.endsWith("/chat/completions") || (body && "messages" in body)) return "openai-chat"
  return "other"
}

// Splits a JSON body: each message-list item, the system text and the tools become blobs. `exact` says
// whether rebuilding gives the same bytes; when it doesn't, the caller keeps the raw body instead.
export function split(text: string): {
  stored: Stored
  blobs: Map<string, string>
  exact: boolean
  parsed?: Record<string, unknown>
} {
  const blobs = new Map<string, string>()
  const keep = (value: unknown) => {
    const json = JSON.stringify(value)
    const key = hash(json)
    blobs.set(key, json)
    return key
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { stored: { [RAW]: keep(text) }, blobs, exact: true }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    blobs.clear()
    return { stored: { [RAW]: keep(text) }, blobs, exact: true }
  }
  const body = parsed as Record<string, unknown>
  const stored: Stored = {}
  for (const [key, value] of Object.entries(body)) {
    if (MESSAGE_KEYS.includes(key) && Array.isArray(value)) stored[key] = { [BLOBS]: value.map(keep) }
    else if ((SYSTEM_KEYS.includes(key) || key === "tools") && value !== undefined)
      stored[key] = { [BLOB]: keep(value) }
    else stored[key] = value
  }
  const exact = rebuild(stored, (key) => blobs.get(key)) === text
  if (exact) return { stored, blobs, exact, parsed: body }
  // Not byte-exact: keep the raw body as one blob.
  blobs.clear()
  return { stored: { [RAW]: keep(text) }, blobs, exact: false, parsed: body }
}

// The exact body string from a stored body and its blobs.
export function rebuild(stored: Stored, blob: (key: string) => string | undefined): string {
  if (typeof stored[RAW] === "string") return JSON.parse(blob(stored[RAW] as string) ?? '""')
  const value = (item: unknown): unknown => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const ref = item as Record<string, unknown>
      if (typeof ref[BLOB] === "string" && Object.keys(ref).length === 1)
        return JSON.parse(blob(ref[BLOB] as string) ?? "null")
      if (Array.isArray(ref[BLOBS]) && Object.keys(ref).length === 1)
        return (ref[BLOBS] as string[]).map((key) => JSON.parse(blob(key) ?? "null"))
    }
    return item
  }
  return JSON.stringify(Object.fromEntries(Object.entries(stored).map(([key, item]) => [key, value(item)])))
}

// Every blob key a stored body refers to.
export function keysOf(stored: Stored): string[] {
  if (typeof stored[RAW] === "string") return [stored[RAW] as string]
  return Object.values(stored).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const ref = item as Record<string, unknown>
    if (typeof ref[BLOB] === "string") return [ref[BLOB] as string]
    if (Array.isArray(ref[BLOBS])) return ref[BLOBS] as string[]
    return []
  })
}

// The blob keys a stored body refers to, by part: the system text, the tools, and each message.
export function refs(stored: Stored) {
  const ref = (key: string) => {
    const item = stored[key] as Record<string, unknown> | undefined
    return item && typeof item[BLOB] === "string" ? (item[BLOB] as string) : undefined
  }
  const system = SYSTEM_KEYS.map(ref).find(Boolean)
  const tools = ref("tools")
  const messagesKey = MESSAGE_KEYS.find((key) => {
    const item = stored[key] as Record<string, unknown> | undefined
    return !!item && Array.isArray(item[BLOBS])
  })
  const messages = messagesKey ? ((stored[messagesKey] as Record<string, unknown>)[BLOBS] as string[]) : []
  return {
    system,
    tools,
    messages,
    messagesKey,
    raw: typeof stored[RAW] === "string" ? (stored[RAW] as string) : undefined,
  }
}

// The request's parameters: the small values (everything but messages, system and tools).
export function parameters(stored: Stored) {
  return Object.fromEntries(
    Object.entries(stored).filter(
      ([key]) => !MESSAGE_KEYS.includes(key) && !SYSTEM_KEYS.includes(key) && key !== "tools" && key !== RAW,
    ),
  )
}

// ---- Responses ----

export type Block =
  | { type: "reasoning"; text: string; encrypted?: boolean; signature?: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; id?: string; name: string; arguments: string }

export type Usage = {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

export type Assembled = {
  parsed: boolean
  blocks: Block[]
  finish?: string
  usage?: Usage
  ids?: string[]
  raw?: string
}

const MAX_RAW = 1024 * 1024

// The JSON payloads of a server-sent event stream, with their event names.
function events(text: string) {
  const out: Array<{ event?: string; data: unknown }> = []
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined
    const data: string[] = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (!data.length) continue
    const joined = data.join("\n")
    if (joined === "[DONE]") continue
    try {
      out.push({ event, data: JSON.parse(joined) })
    } catch {
      // not JSON: skipped
    }
  }
  return out
}

type Builder = {
  blocks: Block[]
  push: (block: Block) => void
  text: (type: "text" | "reasoning", value: string) => void
}
function builder(): Builder {
  const blocks: Block[] = []
  return {
    blocks,
    push: (block) => blocks.push(block),
    // Consecutive deltas of the same kind join into one block.
    text: (type, value) => {
      if (!value) return
      const last = blocks.at(-1)
      if (last && last.type === type && !(last.type === "reasoning" && last.encrypted)) last.text += value
      else blocks.push(type === "text" ? { type, text: value } : { type, text: value })
    },
  }
}

const num = (value: unknown) => (typeof value === "number" ? value : undefined)
const clean = (usage: Usage): Usage | undefined => {
  const out = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as Usage
  return Object.keys(out).length ? out : undefined
}

function openaiChat(items: unknown[]): Assembled {
  const b = builder()
  const calls = new Map<number, { id?: string; name: string; arguments: string; at: number }>()
  let finish: string | undefined
  let usage: Usage = {}
  const ids = new Set<string>()
  for (const raw of items) {
    const item = raw as Record<string, any>
    if (typeof item.id === "string") ids.add(item.id)
    if (item.usage) {
      const u = item.usage
      usage = {
        input: num(u.prompt_tokens),
        output: num(u.completion_tokens),
        reasoning: num(u.completion_tokens_details?.reasoning_tokens),
        cacheRead: num(u.prompt_tokens_details?.cached_tokens),
        cacheWrite: num(u.prompt_tokens_details?.cache_write_tokens),
        cost: num(u.cost),
      }
    }
    const choice = item.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? choice.message ?? {}
    // OpenRouter sends reasoning as `reasoning`, `reasoning_content` or `reasoning_details`.
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
      for (const detail of delta.reasoning_details) {
        if (detail?.type === "reasoning.encrypted")
          b.push({
            type: "reasoning",
            text: "",
            encrypted: true,
            ...(detail.data ? { signature: String(detail.data) } : {}),
          })
        else b.text("reasoning", String(detail?.text ?? detail?.summary ?? ""))
      }
    } else if (typeof delta.reasoning === "string") b.text("reasoning", delta.reasoning)
    else if (typeof delta.reasoning_content === "string") b.text("reasoning", delta.reasoning_content)
    if (typeof delta.content === "string") b.text("text", delta.content)
    for (const call of delta.tool_calls ?? []) {
      const index = typeof call.index === "number" ? call.index : calls.size
      const found = calls.get(index) ?? { name: "", arguments: "", at: b.blocks.length }
      if (call.id) found.id = call.id
      if (call.function?.name) found.name += call.function.name
      if (typeof call.function?.arguments === "string") found.arguments += call.function.arguments
      if (!calls.has(index)) {
        calls.set(index, found)
        b.push({ type: "tool-call", name: "", arguments: "" })
        found.at = b.blocks.length - 1
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  for (const call of calls.values())
    b.blocks[call.at] = {
      type: "tool-call",
      ...(call.id ? { id: call.id } : {}),
      name: call.name,
      arguments: call.arguments,
    }
  return { parsed: true, blocks: b.blocks, ...(finish ? { finish } : {}), usage: clean(usage), ids: [...ids] }
}

function anthropic(items: Array<{ event?: string; data: unknown }>): Assembled {
  const b = builder()
  const open = new Map<number, number>()
  let finish: string | undefined
  let usage: Usage = {}
  const ids: string[] = []
  for (const { data } of items) {
    const item = data as Record<string, any>
    if (item.type === "message_start") {
      if (item.message?.id) ids.push(item.message.id)
      const u = item.message?.usage ?? {}
      usage = {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
      }
    }
    if (item.type === "content_block_start") {
      const block = item.content_block ?? {}
      if (block.type === "text") b.push({ type: "text", text: block.text ?? "" })
      else if (block.type === "thinking") b.push({ type: "reasoning", text: block.thinking ?? "" })
      else if (block.type === "redacted_thinking")
        b.push({ type: "reasoning", text: "", encrypted: true, signature: block.data })
      else if (block.type === "tool_use")
        b.push({ type: "tool-call", id: block.id, name: block.name ?? "", arguments: "" })
      else continue
      open.set(item.index, b.blocks.length - 1)
    }
    if (item.type === "content_block_delta") {
      const at = open.get(item.index)
      if (at === undefined) continue
      const block = b.blocks[at]!
      const delta = item.delta ?? {}
      if (delta.type === "text_delta" && block.type === "text") block.text += delta.text ?? ""
      if (delta.type === "thinking_delta" && block.type === "reasoning") block.text += delta.thinking ?? ""
      if (delta.type === "signature_delta" && block.type === "reasoning")
        block.signature = (block.signature ?? "") + (delta.signature ?? "")
      if (delta.type === "input_json_delta" && block.type === "tool-call") block.arguments += delta.partial_json ?? ""
    }
    if (item.type === "message_delta") {
      if (item.delta?.stop_reason) finish = item.delta.stop_reason
      if (item.usage?.output_tokens !== undefined) usage.output = item.usage.output_tokens
    }
  }
  return { parsed: true, blocks: b.blocks, ...(finish ? { finish } : {}), usage: clean(usage), ids }
}

function openaiResponses(items: Array<{ event?: string; data: unknown }>): Assembled {
  const b = builder()
  const calls = new Map<string, number>()
  let finish: string | undefined
  let usage: Usage = {}
  const ids: string[] = []
  for (const { data } of items) {
    const item = data as Record<string, any>
    const type = item.type as string | undefined
    if (type === "response.output_item.added") {
      const added = item.item ?? {}
      if (added.type === "function_call") {
        b.push({ type: "tool-call", id: added.call_id, name: added.name ?? "", arguments: added.arguments ?? "" })
        calls.set(added.id ?? added.call_id, b.blocks.length - 1)
      }
    }
    if (type === "response.output_text.delta") b.text("text", item.delta ?? "")
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta")
      b.text("reasoning", item.delta ?? "")
    if (type === "response.function_call_arguments.delta") {
      const at = calls.get(item.item_id)
      const block = at === undefined ? undefined : b.blocks[at]
      if (block?.type === "tool-call") block.arguments += item.delta ?? ""
    }
    if (type === "response.output_item.done" && item.item?.type === "reasoning" && item.item.encrypted_content)
      b.push({ type: "reasoning", text: "", encrypted: true, signature: item.item.encrypted_content })
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = item.response ?? {}
      if (response.id) ids.push(response.id)
      finish = response.status ?? finish
      const u = response.usage ?? {}
      usage = {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        reasoning: num(u.output_tokens_details?.reasoning_tokens),
        cacheRead: num(u.input_tokens_details?.cached_tokens),
      }
    }
  }
  return { parsed: true, blocks: b.blocks, ...(finish ? { finish } : {}), usage: clean(usage), ids }
}

function google(items: unknown[]): Assembled {
  const b = builder()
  let finish: string | undefined
  let usage: Usage = {}
  const ids: string[] = []
  for (const raw of items) {
    const item = raw as Record<string, any>
    if (item.responseId) ids.push(item.responseId)
    const candidate = item.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall)
        b.push({
          type: "tool-call",
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        })
      else if (typeof part.text === "string") b.text(part.thought ? "reasoning" : "text", part.text)
      if (part.thoughtSignature) {
        const last = b.blocks.at(-1)
        if (last?.type === "reasoning") last.signature = part.thoughtSignature
      }
    }
    if (candidate?.finishReason) finish = candidate.finishReason
    if (item.usageMetadata) {
      const u = item.usageMetadata
      usage = {
        input: num(u.promptTokenCount),
        output: num(u.candidatesTokenCount),
        reasoning: num(u.thoughtsTokenCount),
        cacheRead: num(u.cachedContentTokenCount),
      }
    }
  }
  return { parsed: true, blocks: b.blocks, ...(finish ? { finish } : {}), usage: clean(usage), ids: [...new Set(ids)] }
}

// The response as it streamed: reasoning, text and tool calls in order, the finish reason, usage and
// response ids. A format that cannot be read keeps the raw text (up to 1 MB), marked not parsed.
export function assemble(format: Format, text: string): Assembled {
  const trimmed = text.trimStart()
  const stream = trimmed.startsWith("data:") || trimmed.startsWith("event:")
  const items = stream
    ? events(text)
    : (() => {
        try {
          return [{ data: JSON.parse(text) as unknown }]
        } catch {
          return []
        }
      })()
  if (!items.length || format === "other") return { parsed: false, blocks: [], raw: text.slice(0, MAX_RAW) }
  try {
    if (format === "openai-chat") return openaiChat(items.map((item) => item.data))
    if (format === "anthropic") return anthropic(items)
    if (format === "openai-responses") return openaiResponses(items)
    return google(items.flatMap((item) => (Array.isArray(item.data) ? item.data : [item.data])))
  } catch {
    return { parsed: false, blocks: [], raw: text.slice(0, MAX_RAW) }
  }
}
