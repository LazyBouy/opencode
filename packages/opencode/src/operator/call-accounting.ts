export * as OperatorCallAccounting from "./call-accounting"

import { Schema } from "effect"
import { OperatorCallPieces } from "./call-pieces"
import type { OperatorCallStore } from "./call-store"
import { OperatorTokenizers } from "./tokenizers"

// The Transcript's token accounting (specs/docs/feedbacks/transcript/transcript_view_spec.md): every
// token a call was billed for belongs to one item (the system prompt, the tools, each piece of each
// message, the parameters) or to "Formatting and unattributed", which is what the provider billed
// minus the items, never spread over them. The provider's totals are the truth; per-item counts are
// measured (the billed difference to the previous call when the request only grew), counted (a
// tokenizer, tokenizers.ts) or estimated (characters ÷ 4), and say which. Pure: the calls service gives
// it the calls in order, their bodies, the session's messages and the model prices.

export const VERSION = 2

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export const Method = Schema.Literals(["counted", "estimate", "reported", "settings"]).annotate({
  identifier: "OperatorTokenMethod",
  description:
    "counted: a tokenizer; estimate: characters ÷ 4; reported: the provider's own count (output: reasoning, or output minus reasoning); settings: not billed. A measured delta is on the input (`delta`).",
})
export type Method = typeof Method.Type

export const Cache = Schema.Literals(["read", "partial", "write", "new"]).annotate({
  identifier: "OperatorTokenCache",
  description: "read: from the provider's cache; partial: the cache read ends inside it; write: written to the cache",
})
export type Cache = typeof Cache.Type

export const InputKind = Schema.Literals([
  "system",
  "tools",
  "user",
  "added-saved",
  "added-request",
  "attachment",
  "summary",
  "assistant",
  "reasoning-sent",
  "tool-call",
  "tool-result",
  "parameters",
  "unrecognized",
]).annotate({ identifier: "OperatorInputItemKind" })
export type InputKind = typeof InputKind.Type

const Count = Schema.Struct({ chars: Schema.Finite, tokens: Schema.Finite })

export const Part = Schema.Struct({
  name: Schema.String,
  chars: Schema.Finite,
  tokens: Schema.Finite,
  description: Schema.optional(Count),
  schema: Schema.optional(Count),
}).annotate({ identifier: "OperatorInputItemPart" })

export const InputItem = Schema.Struct({
  id: Schema.String,
  kind: InputKind,
  message: Schema.optional(Schema.Finite).annotate({ description: "The message it is in (1-based, system left out)" }),
  name: Schema.optional(Schema.String).annotate({
    description: "A tool's name, or the in-memory text (reminder.plan, …)",
  }),
  call: Schema.optional(Schema.Finite).annotate({ description: "The call that returned it (assistant items)" }),
  turn: Schema.optional(Schema.Finite).annotate({
    description: "The turn it belongs to: the user message it is in, or the last one before it",
  }),
  turns: Schema.optional(Schema.Struct({ from: Schema.Finite, to: Schema.Finite })),
  preview: Schema.optional(Schema.String),
  chars: Schema.Finite,
  tokens: Schema.Finite,
  method: Method,
  cache: Cache,
  since: Schema.optional(Schema.Finite).annotate({ description: "Sent before: the first call that sent it" }),
  flags: Schema.Array(Schema.Literals(["cleared", "shortened", "encrypted", "not-estimated"])),
  parts: Schema.optional(Schema.Array(Part)).annotate({ description: "Tools: each tool; system: its sections" }),
  attachment: Schema.optional(
    Schema.Struct({
      type: Schema.Literals(["image", "file"]),
      mime: Schema.optional(Schema.String),
      size: Schema.optional(Schema.Finite),
    }),
  ),
  content: Schema.optional(Schema.String).annotate({ description: "What was sent (call details only)" }),
}).annotate({ identifier: "OperatorInputItem" })
export type InputItem = typeof InputItem.Type

export const OutputItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "reasoning",
    "reasoning-summary",
    "reasoning-hidden",
    "reasoning-encrypted",
    "text",
    "tool-call",
  ]),
  name: Schema.optional(Schema.String),
  chars: Schema.Finite,
  tokens: Schema.Finite,
  method: Method,
  content: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorOutputItem" })
export type OutputItem = typeof OutputItem.Type

const Money = Schema.Struct({
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
})

export const Accounting = Schema.Struct({
  version: Schema.Finite,
  tokenizer: Schema.String.annotate({ description: "The tokenizer that counted the items, or estimate" }),
  order: Schema.Literals(["system-tools-messages", "tools-system-messages"]).annotate({
    description: "The order the model reads the parts in (the cache is read from the start)",
  }),
  input: Schema.Struct({
    items: Schema.Array(InputItem),
    billed: Schema.optional(Schema.Finite).annotate({ description: "Input tokens billed, cache included" }),
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    new: Schema.optional(Schema.Finite).annotate({ description: "Billed minus cache read and cache write" }),
    unattributed: Schema.optional(Schema.Finite).annotate({
      description: "Formatting and unattributed: billed minus the items (negative when estimates exceed it)",
    }),
    boundary: Schema.optional(
      Schema.Struct({
        item: Schema.String.annotate({ description: "The item the cache read ends in, or formatting" }),
        read: Schema.Finite.annotate({ description: "Its tokens read from cache" }),
        after: Schema.Finite.annotate({ description: "Its tokens after the boundary" }),
      }),
    ),
    delta: Schema.optional(
      Schema.Struct({
        from: Schema.Finite.annotate({ description: "The previous call (its index)" }),
        tokens: Schema.Finite.annotate({ description: "Billed input now minus billed input then: measured" }),
        items: Schema.Array(Schema.String).annotate({ description: "The items added since (ids)" }),
      }),
    ),
    uncertain: Schema.optional(Schema.Literals(["estimate", "counted"])).annotate({
      description: "Formatting and unattributed is above 10% of the input: no tokenizer, or the counts are off",
    }),
    unrecognized: Schema.Finite.annotate({ description: "Characters of content no item recognized" }),
  }),
  output: Schema.Struct({
    items: Schema.Array(OutputItem),
    billed: Schema.optional(Schema.Finite).annotate({ description: "Output tokens billed, reasoning included" }),
    reasoning: Schema.Finite,
    unattributed: Schema.optional(Schema.Finite),
  }),
  cost: Schema.Struct({
    provider: Schema.optional(Schema.Finite).annotate({ description: "As the provider billed it (OpenRouter)" }),
    opencode: Schema.optional(Schema.Finite).annotate({ description: "OpenCode's cost (the step-finish part)" }),
    difference: Schema.optional(Schema.Finite),
    generationId: Schema.optional(Schema.String).annotate({ description: "The provider's id for the response" }),
    split: Schema.optional(Money).annotate({ description: "The cost by token kind, from the model's prices" }),
  }),
  changes: Schema.optional(
    Schema.Struct({
      from: Schema.Finite,
      added: Schema.Array(Schema.String).annotate({ description: "Items new since that call (ids)" }),
      removed: Schema.Array(
        Schema.Struct({
          kind: InputKind,
          name: Schema.optional(Schema.String),
          preview: Schema.optional(Schema.String),
          tokens: Schema.Finite,
        }),
      ),
      changed: Schema.Array(Schema.String).annotate({ description: "System or tools that differ (ids)" }),
      tokens: Schema.Finite.annotate({ description: "The input's change in tokens (measured when `measured`)" }),
      measured: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "OperatorCallAccounting" })
export type Accounting = typeof Accounting.Type

// ---- Totals ----

export const Totals = Schema.Struct({
  calls: Schema.Finite,
  input: Schema.Finite.annotate({ description: "Billed input, cache included" }),
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  new: Schema.Finite,
  output: Schema.Finite.annotate({ description: "Billed output, reasoning included" }),
  reasoning: Schema.Finite,
  cost: Schema.Finite.annotate({ description: "OpenCode's cost" }),
  providerCost: Schema.Finite.annotate({ description: "The provider's cost, where it reports one" }),
}).annotate({ identifier: "OperatorTokenTotals" })
export type Totals = typeof Totals.Type

export const empty = (): Totals => ({
  calls: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  new: 0,
  output: 0,
  reasoning: 0,
  cost: 0,
  providerCost: 0,
})

export function add(a: Totals, b: Totals): Totals {
  return {
    calls: a.calls + b.calls,
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    new: a.new + b.new,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cost: a.cost + b.cost,
    providerCost: a.providerCost + b.providerCost,
  }
}

// One call's totals.
export function totalsOf(accounting: Accounting): Totals {
  return {
    calls: 1,
    input: accounting.input.billed ?? 0,
    cacheRead: accounting.input.cacheRead,
    cacheWrite: accounting.input.cacheWrite,
    new: accounting.input.new ?? 0,
    output: accounting.output.billed ?? 0,
    reasoning: accounting.output.reasoning,
    cost: accounting.cost.opencode ?? accounting.cost.provider ?? 0,
    providerCost: accounting.cost.provider ?? 0,
  }
}

// A step OpenCode stored but no recorded call covers (its step-finish part): its billed totals. OpenCode
// stores input without the cache and output without reasoning (Session.getUsage).
export function totalsOfStep(part: {
  cost?: unknown
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}): Totals {
  const tokens = part.tokens ?? {}
  const read = tokens.cache?.read ?? 0
  const write = tokens.cache?.write ?? 0
  const reasoning = tokens.reasoning ?? 0
  return {
    calls: 1,
    input: (tokens.input ?? 0) + read + write,
    cacheRead: read,
    cacheWrite: write,
    new: tokens.input ?? 0,
    output: (tokens.output ?? 0) + reasoning,
    reasoning,
    cost: Number(part.cost) || 0,
    providerCost: 0,
  }
}

// "Where the input tokens went": an item's group.
export const Group = Schema.Literals([
  "system",
  "tools",
  "history",
  "reasoning-sent",
  "tool-results",
  "user",
  "added",
  "formatting",
]).annotate({ identifier: "OperatorInputGroup" })
export type Group = typeof Group.Type

export function groupOf(item: InputItem): Group {
  switch (item.kind) {
    case "system":
      return "system"
    case "tools":
      return "tools"
    case "reasoning-sent":
      return "reasoning-sent"
    case "tool-result":
      return "tool-results"
    case "added-saved":
    case "added-request":
      return "added"
    case "user":
      return item.since === undefined ? "user" : "history"
    case "unrecognized":
    case "parameters":
      return "formatting"
    default:
      return "history"
  }
}

// ---- One call ----

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type CallInput = {
  call: OperatorCallStore.Call
  body?: Record<string, unknown>
  /** The message blob hashes, system messages included (call-format.ts `refs`). */
  hashes: string[]
  index: number
  exchange?: number
  /** OpenCode's cost of the step (its step-finish part). */
  opencodeCost?: number
}

export type Context = {
  messages: ReadonlyArray<{
    // A user message's `summary` is its file diffs; an assistant's `summary: true` is a compaction summary.
    info: { id: string; role: string; parentID?: string; summary?: unknown }
    parts: ReadonlyArray<Record<string, unknown>>
  }>
  price?: (model: string) => Price | undefined
}

const estimate = (chars: number) => Math.round(chars / 4)
const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 120)

// Billed totals from a recorded response. Anthropic reports input without the cache; Google reports
// output without its thoughts.
export function billed(call: OperatorCallStore.Call) {
  const usage = call.response?.usage
  if (!usage) return undefined
  const read = usage.cacheRead ?? 0
  const write = usage.cacheWrite ?? 0
  const input =
    usage.input === undefined ? undefined : call.format === "anthropic" ? usage.input + read + write : usage.input
  const reasoning = usage.reasoning ?? 0
  const output =
    usage.output === undefined ? undefined : call.format === "google" ? usage.output + reasoning : usage.output
  return { input, output, read, write, reasoning, cost: usage.cost }
}

// The system prompt's sections OpenCode puts in it: the environment, skills and instruction files;
// the rest is the base prompt and the profile's layers.
function systemSections(text: string) {
  const ranges: Array<{ name: string; start: number; end: number }> = []
  const find = (open: string, close: string, name: string) => {
    const start = text.indexOf(open)
    if (start < 0) return
    const end = text.indexOf(close, start)
    if (end < 0) return
    // The environment's lead-in line belongs to it.
    const lead = name === "Environment" ? text.lastIndexOf("\n", Math.max(0, start - 2)) + 1 : start
    ranges.push({ name, start: Math.min(lead, start), end: end + close.length })
  }
  find("<env>", "</env>", "Environment")
  find("<available_skills>", "</available_skills>", "Skills")
  const instruction = /^Instructions from: (.+)$/gm
  const starts = [...text.matchAll(instruction)].map((match) => ({ at: match.index ?? 0, path: match[1]! }))
  starts.forEach((item, at) => {
    const end = starts[at + 1]?.at ?? text.length
    ranges.push({ name: `Instructions: ${item.path}`, start: item.at, end })
  })
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start)
  // Overlaps are dropped; the gaps are the base prompt and the profile's layers.
  const kept: typeof sorted = []
  for (const range of sorted) if (!kept.length || range.start >= kept.at(-1)!.end) kept.push(range)
  const out: Array<{ name: string; text: string }> = []
  let at = 0
  const rest = (until: number) => {
    const piece = text.slice(at, until)
    if (piece.trim()) out.push({ name: "Prompt (base and profile layers)", text: piece })
  }
  for (const range of kept) {
    rest(range.start)
    out.push({ name: range.name, text: text.slice(range.start, range.end) })
    at = range.end
  }
  rest(text.length)
  // Consecutive base-prompt pieces join.
  return out.reduce<Array<{ name: string; text: string }>>((list, item) => {
    const last = list.at(-1)
    if (last && last.name === item.name && item.name.startsWith("Prompt")) last.text += item.text
    else list.push({ ...item })
    return list
  }, [])
}

type Built = {
  accounting: Accounting
  system: string
  tools: string
  keys: string[]
  model?: string
  kind: string
  agent?: string
}

// The calls' accounting, in order. `stored` is each call's saved accounting (reused when it is current).
export function account(
  calls: ReadonlyArray<CallInput>,
  context: Context,
  stored: ReadonlyMap<string, Accounting> = new Map(),
): Accounting[] {
  // Stored texts: what OpenCode saved with messages (synthetic), the users' own texts, summaries.
  const users = context.messages.filter((message) => message.info.role === "user")
  const texts = (message: (typeof context.messages)[number], synthetic: boolean) =>
    message.parts
      .filter((part) => part.type === "text" && !!part.synthetic === synthetic)
      .map((part) => String(part.text ?? ""))
      .filter((text) => text.trim())
  const userTexts = users.map((message, at) => ({ turn: at + 1, texts: texts(message, false) }))
  const syntheticTexts = context.messages.flatMap((message) => texts(message, true))
  // Compaction summaries: the assistant message OpenCode writes when it compacts (`summary: true`); it
  // covers the turns before the user message that asked for it.
  const summaries = context.messages.flatMap((message) => {
    if (message.info.role !== "assistant" || message.info.summary !== true) return []
    const parent = users.findIndex((user) => user.info.id === message.info.parentID)
    return [{ texts: texts(message, false), before: parent >= 0 ? parent : users.length }]
  })
  const savedAnywhere = (line: string) =>
    context.messages.some((message) =>
      message.parts.some((part) => part.type === "text" && String(part.text ?? "").includes(line)),
    )

  const built: Built[] = []
  const firstSent = new Map<string, number>()
  return calls.map((input, position) => {
    const previous = built.slice(0, position)
    const parts = OperatorCallPieces.sections(input.body)
    const tools = OperatorCallPieces.toolNames(input.body)
    const toolsJson = JSON.stringify(tools.map((tool) => tool.json))
    const list = parts.messagesKey ? (input.body?.[parts.messagesKey] as unknown[]) : []
    const keys = input.hashes.filter(
      (_, at) => !OperatorCallPieces.SYSTEM_ROLES.includes(String((list[at] as Record<string, unknown>)?.role)),
    )
    const tokenizer = OperatorTokenizers.forModel(input.call.model)
    const signature = tokenizer?.id ?? "estimate"
    const saved = stored.get(input.call.callID)
    const finished = !!input.call.finishedAt
    const result =
      saved && saved.version === VERSION && saved.tokenizer === signature && finished
        ? saved
        : one(input, {
            parts,
            tools,
            keys,
            tokenizer,
            previous,
            firstSent,
            context,
            userTexts,
            syntheticTexts,
            summaries,
            savedAnywhere,
            signature,
            calls,
          })
    keys.forEach((key) => {
      if (!firstSent.has(key)) firstSent.set(key, input.index)
    })
    built.push({
      accounting: result,
      system: parts.system,
      tools: toolsJson,
      keys,
      model: input.call.model,
      kind: input.call.kind,
      agent: input.call.agent,
    })
    return result
  })
}

function one(
  input: CallInput,
  ctx: {
    parts: ReturnType<typeof OperatorCallPieces.sections>
    tools: ReturnType<typeof OperatorCallPieces.toolNames>
    keys: string[]
    tokenizer: OperatorTokenizers.Tokenizer | undefined
    previous: Built[]
    firstSent: Map<string, number>
    context: Context
    userTexts: Array<{ turn: number; texts: string[] }>
    syntheticTexts: string[]
    summaries: Array<{ texts: string[]; before: number }>
    savedAnywhere: (line: string) => boolean
    signature: string
    calls: ReadonlyArray<CallInput>
  },
): Accounting {
  const { call, body } = input
  const count = (text: string): { tokens: number; method: Method } => {
    if (ctx.tokenizer) {
      const counted = OperatorTokenizers.count(ctx.tokenizer, text)
      if (counted !== undefined) return { tokens: counted, method: "counted" }
    }
    return { tokens: estimate(text.length), method: "estimate" }
  }
  const totals = billed(call)
  const items: Mutable<InputItem>[] = []
  const contents = new Map<string, string>()

  // The system prompt, by section.
  const systemItem = (): Mutable<InputItem> | undefined => {
    const text = ctx.parts.system
    if (!text) return undefined
    const sections = systemSections(text)
    const counted = sections.map((section) => ({
      name: section.name,
      chars: section.text.length,
      ...count(section.text),
    }))
    const tokens = counted.reduce((sum, section) => sum + section.tokens, 0)
    contents.set("system", text)
    return {
      id: "system",
      kind: "system",
      chars: text.length,
      tokens,
      method: counted[0]?.method ?? "estimate",
      cache: "new",
      flags: [],
      ...(sections.length > 1 ? { parts: counted.map(({ name, chars, tokens }) => ({ name, chars, tokens })) } : {}),
    }
  }
  // The tools: each with its description and its schema.
  const toolsItem = (): Mutable<InputItem> | undefined => {
    if (!ctx.tools.length) return undefined
    const toolParts = ctx.tools.map((tool) => {
      const value = tool.value as Record<string, any>
      const fn = (value.function ?? value) as Record<string, unknown>
      const description = typeof fn.description === "string" ? fn.description : ""
      const schema = JSON.stringify(fn.parameters ?? fn.input_schema ?? fn.inputSchema ?? {})
      const whole = count(tool.json)
      return {
        name: tool.name,
        chars: tool.json.length,
        tokens: whole.tokens,
        method: whole.method,
        description: { chars: description.length, tokens: count(description).tokens },
        schema: { chars: schema.length, tokens: count(schema).tokens },
      }
    })
    const json = JSON.stringify(body?.tools ?? [])
    contents.set("tools", json)
    return {
      id: "tools",
      kind: "tools",
      name: String(ctx.tools.length),
      chars: json.length,
      tokens: toolParts.reduce((sum, tool) => sum + tool.tokens, 0),
      method: toolParts[0]?.method ?? "estimate",
      cache: "new",
      flags: [],
      parts: toolParts.map(({ method: _, ...part }) => part),
    }
  }

  // Which earlier call returned a text, reasoning or tool call.
  const returnedBy = (kind: "text" | "reasoning" | "tool-call", payload: string, id?: string) => {
    for (const earlier of ctx.calls) {
      if (earlier.index >= input.index) break
      const blocks = earlier.call.response?.blocks ?? []
      const found = blocks.some((block) => {
        if (kind === "tool-call")
          return block.type === "tool-call" && (id ? block.id === id : block.arguments === payload)
        if (block.type !== kind) return false
        return !!payload.trim() && block.text.trim() === payload.trim()
      })
      if (found) return earlier.index
    }
    return undefined
  }

  // Each message's turn: a user message whose own text matches a stored user message sets it (searching
  // only later turns, so a repeated text matches the right one); the messages after it belong to it.
  let current = 0
  const turnOf = ctx.parts.messages.map((message, at) => {
    const own = OperatorCallPieces.pieces(message, at).filter(
      (piece) => piece.kind === "text" && piece.role === "user" && piece.payload.trim(),
    )
    const found = ctx.userTexts.find(
      (item) =>
        item.turn > current && own.some((piece) => item.texts.some((text) => text.trim() === piece.payload.trim())),
    )
    if (found) current = found.turn
    return current || undefined
  })

  // The messages, piece by piece.
  const messageItems: Mutable<InputItem>[] = []
  let unrecognized = 0
  const toolNamesByID = new Map<string, string>()
  ctx.parts.messages.forEach((message, at) => {
    const since = ctx.firstSent.get(ctx.keys[at] ?? "")
    const pieces = OperatorCallPieces.pieces(message, at)
    pieces.forEach((piece, k) => {
      const id = `m${at + 1}.${k + 1}`
      const base = {
        id,
        message: at + 1,
        chars: piece.payload.length,
        cache: "new" as Cache,
        ...(since !== undefined ? { since } : {}),
        ...(turnOf[at] !== undefined ? { turn: turnOf[at] } : {}),
        flags: [] as InputItem["flags"][number][],
      }
      contents.set(id, piece.payload)
      const counted = count(piece.payload)
      const push = (
        item: Omit<InputItem, "tokens" | "method" | "cache" | "flags" | "chars" | "id" | "message"> &
          Partial<InputItem>,
      ) =>
        messageItems.push({ ...base, ...counted, ...item, flags: [...base.flags, ...(item.flags ?? [])] } as InputItem)
      const assistant = piece.role === "assistant" || piece.role === "model"
      switch (piece.kind) {
        case "text": {
          const memory = OperatorCallPieces.IN_MEMORY_LINES.find(
            (line) => piece.payload.includes(line.line) && !ctx.savedAnywhere(line.line),
          )
          const summary = ctx.summaries.find((item) => item.texts.some((text) => text.trim() === piece.payload.trim()))
          if (memory) push({ kind: "added-request", name: memory.id, preview: preview(piece.payload) })
          else if (summary)
            push({
              kind: "summary",
              turns: { from: 1, to: Math.max(1, summary.before) },
              preview: preview(piece.payload),
            })
          else if (assistant) {
            const by = returnedBy("text", piece.payload)
            push({ kind: "assistant", ...(by !== undefined ? { call: by } : {}), preview: preview(piece.payload) })
          } else if (ctx.syntheticTexts.some((text) => text.trim() === piece.payload.trim()))
            push({ kind: "added-saved", preview: preview(piece.payload) })
          else push({ kind: "user", preview: preview(piece.payload) })
          return
        }
        case "reasoning": {
          const by = returnedBy("reasoning", piece.payload)
          push({
            kind: "reasoning-sent",
            ...(by !== undefined ? { call: by } : {}),
            ...(piece.encrypted ? { flags: ["encrypted"] } : {}),
            preview: piece.encrypted ? undefined : preview(piece.payload),
          })
          return
        }
        case "tool-call": {
          if (piece.id && piece.name) toolNamesByID.set(piece.id, piece.name)
          const by = returnedBy("tool-call", piece.payload, piece.id)
          push({
            kind: "tool-call",
            ...(piece.name ? { name: piece.name } : {}),
            ...(by !== undefined ? { call: by } : {}),
            preview: preview(piece.payload),
          })
          return
        }
        case "tool-result": {
          const name = piece.name ?? (piece.id ? toolNamesByID.get(piece.id) : undefined)
          const flags: InputItem["flags"][number][] = []
          if (piece.payload.includes(OperatorCallPieces.CLEARED)) flags.push("cleared")
          if (piece.payload.includes(OperatorCallPieces.TRUNCATED)) flags.push("shortened")
          push({ kind: "tool-result", ...(name ? { name } : {}), flags, preview: preview(piece.payload) })
          return
        }
        case "attachment": {
          // Its tokens follow the provider's rule for images and files, which is not known here.
          push({
            kind: "attachment",
            tokens: 0,
            method: "estimate",
            flags: ["not-estimated"],
            ...(piece.attachment ? { attachment: piece.attachment, name: piece.attachment.type } : {}),
          })
          return
        }
        case "unknown":
          unrecognized += piece.payload.length
          push({ kind: "unrecognized", preview: preview(piece.payload) })
          return
      }
    })
  })
  // A body that is not JSON is unrecognized as a whole.
  if (!body) unrecognized += call.request.bytes

  // The order the model reads them in: Anthropic caches tools, then system, then messages.
  const order = call.format === "anthropic" ? "tools-system-messages" : "system-tools-messages"
  const system = systemItem()
  const toolList = toolsItem()
  const head = (order === "tools-system-messages" ? [toolList, system] : [system, toolList]).filter(
    (item): item is Mutable<InputItem> => !!item,
  )
  items.push(...head, ...messageItems)

  // Measured: the previous call of this chain sent the same system text, tools and model, and every
  // message it sent comes first in this one. Its billed input is then exactly this call's prefix; the
  // items it had keep its counts, and billed now minus billed then is the added items, formatting
  // included.
  const chain = ctx.previous.findLast(
    (item) =>
      item.kind === call.kind &&
      item.agent === call.agent &&
      item.model === call.model &&
      item.system === ctx.parts.system &&
      item.tools === JSON.stringify(ctx.tools.map((tool) => tool.json)) &&
      item.accounting.input.billed !== undefined &&
      item.keys.length < ctx.keys.length &&
      item.keys.every((key, at) => ctx.keys[at] === key),
  )
  let delta: Accounting["input"]["delta"]
  if (chain && totals?.input !== undefined) {
    const before = new Map(chain.accounting.input.items.map((item) => [item.id, item]))
    const prefix = chain.keys.length
    for (const item of items) {
      const earlier = before.get(item.id)
      if (!earlier) continue
      if (item.message !== undefined && item.message > prefix) continue
      item.tokens = earlier.tokens
      item.method = earlier.method
      if (earlier.parts && item.parts) item.parts = earlier.parts
    }
    const tokens = totals.input - chain.accounting.input.billed!
    if (tokens >= 0)
      delta = {
        from: callIndexOf(chain, ctx),
        tokens,
        items: items.filter((item) => item.message !== undefined && item.message > prefix).map((item) => item.id),
      }
  }

  // The parameters: model, temperature, reasoning effort, tool choice. Not billed.
  const params = body
    ? Object.fromEntries(
        Object.entries(body).filter(
          ([key]) =>
            !["messages", "input", "contents", "system", "instructions", "systemInstruction", "tools"].includes(key),
        ),
      )
    : {}
  const paramsJson = JSON.stringify(params)
  contents.set("parameters", paramsJson)
  items.push({
    id: "parameters",
    kind: "parameters",
    chars: paramsJson.length,
    tokens: 0,
    method: "settings",
    cache: "new",
    flags: [],
  })

  // The cache: read from the start of the request until the reported cache read is used up.
  const read = totals?.read ?? 0
  const write = totals?.write ?? 0
  let at = 0
  let boundary: Accounting["input"]["boundary"]
  for (const item of items) {
    if (item.kind === "parameters") continue
    const start = at
    const end = at + item.tokens
    at = end
    if (!totals) continue
    if (end <= read && item.tokens > 0) item.cache = "read"
    else if (start < read && read < end) {
      item.cache = "partial"
      boundary = { item: item.id, read: read - start, after: end - read }
    } else if (start >= read && start < read + write) item.cache = "write"
    else item.cache = "new"
  }
  if (totals && read > at) boundary = { item: "formatting", read: read - at, after: 0 }

  const sum = items.reduce((total, item) => total + item.tokens, 0)
  const unattributed = totals?.input !== undefined ? totals.input - sum : undefined
  const uncertain =
    totals?.input && unattributed !== undefined && Math.abs(unattributed) > totals.input * 0.1
      ? ctx.tokenizer
        ? ("counted" as const)
        : ("estimate" as const)
      : undefined

  // Output: reasoning as reported; one other item takes output minus reasoning; else counted or
  // estimated, the rest unattributed.
  const blocks = call.response?.blocks ?? []
  const outputs: Mutable<OutputItem>[] = []
  const reasoningBlocks = blocks.filter((block) => block.type === "reasoning")
  const reasoningText = reasoningBlocks.map((block) => (block.type === "reasoning" ? block.text : "")).join("")
  const reported = call.response?.usage?.reasoning
  if (reasoningBlocks.length || reported) {
    const encrypted =
      reasoningBlocks.length > 0 && reasoningBlocks.every((block) => block.type === "reasoning" && block.encrypted)
    const kind: OutputItem["kind"] = !reasoningBlocks.length
      ? "reasoning-hidden"
      : encrypted
        ? "reasoning-encrypted"
        : call.format === "openai-responses"
          ? "reasoning-summary"
          : "reasoning"
    const tokens = reported ?? (encrypted ? 0 : count(reasoningText).tokens)
    outputs.push({
      id: "reasoning",
      kind,
      chars: encrypted ? 0 : reasoningText.length,
      tokens,
      method: reported !== undefined ? "reported" : count(reasoningText).method,
      ...(encrypted || !reasoningText ? {} : { content: reasoningText }),
    })
  }
  blocks.forEach((block, k) => {
    if (block.type === "reasoning") return
    const payload = block.type === "text" ? block.text : block.arguments
    outputs.push({
      id: `o${k + 1}`,
      kind: block.type === "text" ? "text" : "tool-call",
      ...(block.type === "tool-call" ? { name: block.name } : {}),
      chars: payload.length,
      ...count(payload),
      content: payload,
    })
  })
  const others = outputs.filter((item) => !item.kind.startsWith("reasoning"))
  const reasoningTokens = outputs.find((item) => item.kind.startsWith("reasoning"))?.tokens ?? 0
  if (others.length === 1 && totals?.output !== undefined) {
    others[0]!.tokens = Math.max(0, totals.output - reasoningTokens)
    others[0]!.method = "reported"
  }
  const outputSum = outputs.reduce((total, item) => total + item.tokens, 0)

  // Cost: the provider's, OpenCode's, and the split by token kind from the model's prices.
  const price = call.model ? ctx.context.price?.(call.model) : undefined
  const provider = totals?.cost
  const opencode = input.opencodeCost
  const fresh = totals?.input !== undefined ? Math.max(0, totals.input - read - write) : undefined
  const split =
    price && fresh !== undefined && totals?.output !== undefined
      ? {
          input: (fresh * price.input) / 1e6,
          cacheRead: (read * price.cacheRead) / 1e6,
          cacheWrite: (write * price.cacheWrite) / 1e6,
          output: (Math.max(0, totals.output - (totals.reasoning ?? 0)) * price.output) / 1e6,
          reasoning: ((totals.reasoning ?? 0) * price.output) / 1e6,
        }
      : undefined
  const generationId = call.response?.ids?.[0]

  // What changed since the previous call of this agent: items added and removed, and the tokens.
  const last = ctx.previous.findLast((item) => item.kind === call.kind && item.agent === call.agent)
  let changes: Accounting["changes"]
  if (last) {
    const keyOf = (item: InputItem, content: string | undefined) =>
      `${item.kind}\n${item.name ?? ""}\n${content ?? item.preview ?? ""}`
    const lastKeys = new Map(last.accounting.input.items.map((item) => [keyOf(item, item.preview), item]))
    const nowKeys = new Set(items.map((item) => keyOf(item, item.preview)))
    const added = items
      .filter(
        (item) =>
          item.kind !== "system" &&
          item.kind !== "tools" &&
          item.kind !== "parameters" &&
          !lastKeys.has(keyOf(item, item.preview)),
      )
      .map((item) => item.id)
    const removed = last.accounting.input.items
      .filter(
        (item) =>
          item.kind !== "system" &&
          item.kind !== "tools" &&
          item.kind !== "parameters" &&
          !nowKeys.has(keyOf(item, item.preview)),
      )
      .map((item) => ({
        kind: item.kind,
        ...(item.name ? { name: item.name } : {}),
        ...(item.preview ? { preview: item.preview } : {}),
        tokens: item.tokens,
      }))
    const changed = [
      ...(last.system !== ctx.parts.system ? ["system"] : []),
      ...(last.tools !== JSON.stringify(ctx.tools.map((tool) => tool.json)) ? ["tools"] : []),
    ]
    // Measured when only appended items differ (the delta); else the difference of the billed inputs,
    // or of the items' counts when a call has no usage.
    const from = callIndexOf(last, ctx)
    const measured = !!delta && delta.from === from
    const tokens = measured
      ? delta!.tokens
      : totals?.input !== undefined && last.accounting.input.billed !== undefined
        ? totals.input - last.accounting.input.billed
        : items.reduce((total, item) => total + item.tokens, 0) -
          last.accounting.input.items.reduce((total, item) => total + item.tokens, 0)
    changes = { from, added, removed, changed, tokens, measured }
  }

  return {
    version: VERSION,
    tokenizer: ctx.signature,
    order,
    input: {
      items: items.map((item) => ({ ...item, ...(contents.has(item.id) ? { content: contents.get(item.id) } : {}) })),
      ...(totals?.input !== undefined ? { billed: totals.input } : {}),
      cacheRead: read,
      cacheWrite: write,
      ...(totals?.input !== undefined ? { new: Math.max(0, totals.input - read - write) } : {}),
      ...(unattributed !== undefined ? { unattributed } : {}),
      ...(boundary ? { boundary } : {}),
      ...(delta ? { delta } : {}),
      ...(uncertain ? { uncertain } : {}),
      unrecognized,
    },
    output: {
      items: outputs,
      ...(totals?.output !== undefined ? { billed: totals.output } : {}),
      reasoning: totals?.reasoning ?? 0,
      ...(totals?.output !== undefined ? { unattributed: totals.output - outputSum } : {}),
    },
    cost: {
      ...(provider !== undefined ? { provider } : {}),
      ...(opencode !== undefined ? { opencode } : {}),
      ...(provider !== undefined && opencode !== undefined ? { difference: provider - opencode } : {}),
      ...(generationId ? { generationId } : {}),
      ...(split ? { split } : {}),
    },
    ...(changes ? { changes } : {}),
  }
}

// A built call's index (its place in the session).
function callIndexOf(item: Built, ctx: { previous: Built[]; calls: ReadonlyArray<CallInput> }) {
  return ctx.calls[ctx.previous.indexOf(item)]?.index ?? 0
}

// The accounting without the items' content (what lists and stores keep).
export function lean(accounting: Accounting): Accounting {
  return {
    ...accounting,
    input: { ...accounting.input, items: accounting.input.items.map(({ content: _, ...item }) => item) },
    output: { ...accounting.output, items: accounting.output.items.map(({ content: _, ...item }) => item) },
  }
}

// ---- Turns and the session ----

export const Unrecorded = Schema.Struct({
  assistantMessageID: Schema.String,
  exchange: Schema.optional(Schema.Finite),
  totals: Totals,
}).annotate({ identifier: "OperatorUnrecordedStep" })
export type Unrecorded = typeof Unrecorded.Type

export const Turn = Schema.Struct({
  index: Schema.Finite.annotate({ description: "The turn (its user message), 1-based; 0: calls outside any turn" }),
  userMessageID: Schema.optional(Schema.String),
  text: Schema.String,
  calls: Schema.Array(Schema.String).annotate({ description: "Its recorded calls (ids), in order" }),
  unrecorded: Schema.Finite.annotate({ description: "Its steps OpenCode stored but did not record" }),
  status: Schema.Literals(["ok", "failed", "running", "unrecorded", "empty"]).annotate({
    description:
      "ok: a step succeeded; failed: every call failed; running: a call is still receiving; unrecorded: only steps that were not recorded; empty: nothing yet",
  }),
  failure: Schema.optional(Schema.Struct({ index: Schema.Finite, status: Schema.optional(Schema.Finite) })).annotate({
    description: "A failed turn: its last call (index) and that call's HTTP status",
  }),
  totals: Totals,
}).annotate({ identifier: "OperatorTurn" })
export type Turn = typeof Turn.Type

export const Subagent = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  agent: Schema.optional(Schema.String),
  totals: Totals.annotate({ description: "Its calls and its own subagents', rolled up" }),
}).annotate({ identifier: "OperatorSubagentTotals" })
export type Subagent = typeof Subagent.Type

export const Row = Schema.Literals(["agent", "side", "retries", "session", "subagents", "all"])

export const SessionTotals = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ id: Row, totals: Totals })).annotate({
    description:
      "agent: agent steps that succeeded (with steps not recorded); side: title, compaction, summary and other calls that succeeded; retries: failed calls and attempts; session: this session; subagents and all (with subagents) when it has any",
  }),
  inputBy: Schema.Array(Schema.Struct({ group: Group, tokens: Schema.Finite, cacheRead: Schema.Finite })).annotate({
    description: "Where the input tokens went, over the calls the provider billed",
  }),
  notCounted: Schema.Struct({
    failed: Schema.Finite.annotate({ description: "Failed calls with no billed input" }),
    noUsage: Schema.Finite.annotate({ description: "Other calls with no usage reported (yet)" }),
  }).annotate({ description: "Calls left out of where the input went" }),
  providerMissing: Schema.Array(Schema.Finite).annotate({
    description: "Calls whose provider reported no cost (their index)",
  }),
  subagents: Schema.Array(Subagent),
  uncertain: Schema.Finite.annotate({ description: "Calls whose attribution is uncertain" }),
}).annotate({ identifier: "OperatorSessionTotals" })
export type SessionTotals = typeof SessionTotals.Type

type Listed = {
  callID: string
  index: number
  kind: string
  exchange?: number
  failed: boolean
  receiving?: boolean
  httpStatus?: number
  error?: { status?: number }
  finishedAt?: number
  accounting: Accounting
}

// The steps OpenCode stored (step-finish parts) that no recorded agent call covers.
export function unrecordedSteps(
  messages: ReadonlyArray<{
    info: { id: string; role: string; parentID?: string }
    parts: ReadonlyArray<Record<string, unknown>>
  }>,
  covered: ReadonlySet<string>,
): Unrecorded[] {
  const users = messages.filter((message) => message.info.role === "user").map((message) => message.info.id)
  return messages.flatMap((message) => {
    if (message.info.role !== "assistant" || covered.has(message.info.id)) return []
    const exchange = users.indexOf(message.info.parentID ?? "")
    return message.parts
      .filter((part) => part.type === "step-finish")
      .map((part) => ({
        assistantMessageID: message.info.id,
        ...(exchange >= 0 ? { exchange: exchange + 1 } : {}),
        totals: totalsOfStep(part as Parameters<typeof totalsOfStep>[0]),
      }))
  })
}

// Turns and the session's totals: every call counts once, in its turn (calls outside a turn in turn 0),
// and the session is the sum of its turns.
export function summarize(input: {
  calls: ReadonlyArray<Listed>
  exchanges: ReadonlyArray<{ userMessageID: string; index: number; text: string }>
  unrecorded: ReadonlyArray<Unrecorded>
  subagents: ReadonlyArray<Subagent>
}): { turns: Turn[]; session: SessionTotals } {
  const turns: Array<Mutable<Turn> & { calls: string[] }> = input.exchanges.map((exchange) => ({
    index: exchange.index,
    userMessageID: exchange.userMessageID,
    text: exchange.text,
    calls: [],
    unrecorded: 0,
    status: "empty",
    totals: empty(),
  }))
  const other: Mutable<Turn> & { calls: string[] } = {
    index: 0,
    text: "",
    calls: [],
    unrecorded: 0,
    status: "empty",
    totals: empty(),
  }
  const turnOf = (exchange: number | undefined) => turns.find((turn) => turn.index === exchange) ?? other
  const rows = { agent: empty(), side: empty(), retries: empty() }
  for (const call of input.calls) {
    const totals = totalsOf(call.accounting)
    const turn = turnOf(call.exchange)
    turn.calls.push(call.callID)
    turn.totals = add(turn.totals, totals)
    const row = call.failed ? "retries" : call.kind === "agent" ? "agent" : "side"
    rows[row] = add(rows[row], totals)
  }
  // A turn's status: a step succeeded, a call is still receiving, or every call failed (its last one).
  const byID = new Map(input.calls.map((call) => [call.callID, call]))
  for (const turn of [...turns, other]) {
    const calls = turn.calls.map((id) => byID.get(id)!)
    if (calls.some((call) => call.receiving)) turn.status = "running"
    else if (calls.some((call) => !call.failed)) turn.status = "ok"
    else if (calls.length) {
      turn.status = "failed"
      const last = calls.at(-1)!
      const status = last.httpStatus ?? last.error?.status
      turn.failure = { index: last.index, ...(status !== undefined ? { status } : {}) }
    }
  }
  for (const step of input.unrecorded) {
    const turn = turnOf(step.exchange)
    if (turn.status === "empty") turn.status = "unrecorded"
    turn.unrecorded++
    turn.totals = add(turn.totals, step.totals)
    rows.agent = add(rows.agent, step.totals)
  }
  const session = add(add(rows.agent, rows.side), rows.retries)
  const subagents = input.subagents.reduce((total, item) => add(total, item.totals), empty())

  const groups = new Map<Group, { tokens: number; cacheRead: number }>()
  const bump = (group: Group, tokens: number, cacheRead: number) => {
    const found = groups.get(group) ?? { tokens: 0, cacheRead: 0 }
    groups.set(group, { tokens: found.tokens + tokens, cacheRead: found.cacheRead + cacheRead })
  }
  // Only what the provider billed: a call without billed input (a failure, or no usage reported) adds
  // nothing, and is counted in the note instead.
  const notCounted = { failed: 0, noUsage: 0 }
  for (const call of input.calls) {
    const accounting = call.accounting.input
    if (accounting.billed === undefined) {
      if (call.failed) notCounted.failed++
      else notCounted.noUsage++
      continue
    }
    for (const item of accounting.items) {
      const read =
        item.cache === "read"
          ? item.tokens
          : item.cache === "partial" && accounting.boundary
            ? accounting.boundary.read
            : 0
      bump(groupOf(item), item.tokens, read)
    }
    if (accounting.unattributed !== undefined)
      bump(
        "formatting",
        accounting.unattributed,
        accounting.boundary?.item === "formatting" ? accounting.boundary.read : 0,
      )
  }
  const order: Group[] = ["system", "tools", "history", "reasoning-sent", "tool-results", "user", "added", "formatting"]

  return {
    turns: other.calls.length || other.unrecorded ? [...turns, other] : turns,
    session: {
      rows: [
        { id: "agent", totals: rows.agent },
        { id: "side", totals: rows.side },
        { id: "retries", totals: rows.retries },
        { id: "session", totals: session },
        ...(input.subagents.length
          ? [
              { id: "subagents" as const, totals: { ...subagents, calls: subagents.calls } },
              { id: "all" as const, totals: add(session, subagents) },
            ]
          : []),
      ],
      inputBy: order.map((group) => ({ group, ...(groups.get(group) ?? { tokens: 0, cacheRead: 0 }) })),
      notCounted,
      providerMissing: input.calls
        .filter(
          (call) =>
            call.finishedAt &&
            call.accounting.input.billed !== undefined &&
            call.accounting.cost.provider === undefined,
        )
        .map((call) => call.index),
      subagents: [...input.subagents],
      uncertain: input.calls.filter((call) => call.accounting.input.uncertain).length,
    },
  }
}

// ---- Labels (the Markdown export; the app has its own, translated) ----

const IN_MEMORY_NAMES: Record<string, string> = {
  "reminder.plan": "plan reminder",
  "reminder.plan-mode": "plan mode reminder",
  "reminder.build-switch": "switch to build",
  "notice.max-steps": "step-limit notice",
}

export function label(item: InputItem): string {
  const by = item.call !== undefined ? ` (call ${item.call})` : ""
  switch (item.kind) {
    case "system":
      return "System prompt"
    case "tools":
      return `Tools (${item.name ?? "?"})`
    case "user":
      return `You: "${item.preview ?? ""}"${item.turn !== undefined ? ` (turn ${item.turn})` : ""}`
    case "added-saved":
      return "Added by OpenCode (saved)"
    case "added-request":
      return `Added by OpenCode for this request (not saved): ${IN_MEMORY_NAMES[item.name ?? ""] ?? item.name ?? ""}`
    case "attachment":
      return `${item.attachment?.type === "image" ? "Image" : "File"}${item.attachment?.mime ? ` ${item.attachment.mime}` : ""}`
    case "summary":
      return `Summary of turns ${item.turns?.from ?? 1}–${item.turns?.to ?? "?"} (compaction)`
    case "assistant":
      return `Assistant: "${item.preview ?? ""}"${by}`
    case "reasoning-sent":
      return `Earlier reasoning, sent back${by}`
    case "tool-call":
      return `Tool call: ${item.name ?? "?"}${by}`
    case "tool-result":
      return `Tool result: ${item.name ?? "?"}${item.flags.includes("cleared") ? " · Cleared by OpenCode" : ""}${item.flags.includes("shortened") ? " · Shortened by OpenCode" : ""}`
    case "parameters":
      return "Parameters"
    case "unrecognized":
      return `Unrecognized content (${item.chars} characters)`
  }
}

export function outputLabel(item: OutputItem): string {
  switch (item.kind) {
    case "reasoning":
      return "Reasoning"
    case "reasoning-summary":
      return "Reasoning summary"
    case "reasoning-hidden":
      return `${item.tokens} reasoning tokens billed; content not returned by the provider`
    case "reasoning-encrypted":
      return `Encrypted reasoning (${item.tokens} tokens); not readable`
    case "text":
      return "Answer"
    case "tool-call":
      return `Tool call: ${item.name ?? "?"}`
  }
}

const METHOD: Record<Method, string> = {
  counted: "counted",
  estimate: "≈ estimate",
  reported: "reported",
  settings: "settings",
}

// One call's accounting as Markdown tables.
export function markdown(accounting: Accounting): string[] {
  const n = (value: number | undefined) => (value === undefined ? "?" : value.toLocaleString("en-US"))
  const input = accounting.input
  const out = ["| Sent | tokens | how | cache |", "|---|---:|---|---|"]
  for (const item of input.items)
    out.push(
      `| ${label(item).replaceAll("|", "\\|")}${item.since !== undefined ? ` · same as call ${item.since}` : ""} | ${n(item.tokens)} | ${METHOD[item.method]} | ${item.kind === "parameters" ? "settings" : item.cache} |`,
    )
  if (input.unattributed !== undefined) out.push(`| Formatting and unattributed | ${n(input.unattributed)} | | |`)
  if (input.billed !== undefined)
    out.push(
      `| **Total billed (provider)** | **${n(input.billed)}** | | ${n(input.cacheRead)} cache read · ${n(input.cacheWrite)} cache write · ${n(input.new)} new |`,
    )
  if (input.delta) out.push("", `Measured: +${n(input.delta.tokens)} since call ${input.delta.from}.`)
  if (input.uncertain) out.push("", "Attribution uncertain: formatting and unattributed is above 10% of the input.")
  out.push("", "| Received | tokens | how |", "|---|---:|---|")
  for (const item of accounting.output.items)
    out.push(`| ${outputLabel(item)} | ${n(item.tokens)} | ${METHOD[item.method]} |`)
  if (accounting.output.unattributed !== undefined)
    out.push(`| Formatting and unattributed | ${n(accounting.output.unattributed)} | |`)
  if (accounting.output.billed !== undefined)
    out.push(`| **Total billed (provider)** | **${n(accounting.output.billed)}** | |`)
  const cost = accounting.cost
  const money = (value: number | undefined) => (value === undefined ? "—" : `$${value.toFixed(6)}`)
  out.push(
    "",
    `Cost: ${money(cost.provider)} (provider${cost.generationId ? `, ${cost.generationId}` : ""}) · ${money(cost.opencode)} (OpenCode)`,
  )
  return out
}

// ---- What the Transcript can show ----

// Call recording started on 6 October 2026: older sessions have no recorded calls.
export const RECORDING_SINCE = Date.UTC(2026, 9, 6)

export const Reason = Schema.Literals([
  "before-recording",
  "recording-off",
  "no-calls",
  "none-billed",
  "no-usage",
]).annotate({
  identifier: "OperatorTranscriptReason",
  description:
    "before-recording: the session is older than call recording; recording-off: calls ran while recording was off; no-calls: no model call yet; none-billed: every call failed before the provider billed it; no-usage: the provider reported no usage",
})
export type Reason = typeof Reason.Type

export const Availability = Schema.Struct({
  recorded: Schema.Literals(["all", "some", "none"]).annotate({
    description: "Whether the session's steps were recorded: all, some or none",
  }),
  calls: Schema.optional(Reason).annotate({ description: "Why some or all calls are missing" }),
  input: Schema.optional(Reason).annotate({ description: "Why where the input went has nothing to show" }),
}).annotate({ identifier: "OperatorTranscriptAvailability" })
export type Availability = typeof Availability.Type

export function availabilityOf(input: {
  calls: ReadonlyArray<{ failed: boolean; accounting: Accounting }>
  unrecorded: number
  created: number
}): Availability {
  const recorded = input.calls.length === 0 ? (input.unrecorded ? "none" : "all") : input.unrecorded ? "some" : "all"
  const calls: Reason | undefined =
    input.calls.length === 0 && !input.unrecorded
      ? "no-calls"
      : recorded === "all"
        ? undefined
        : input.created < RECORDING_SINCE
          ? "before-recording"
          : "recording-off"
  const billed = input.calls.filter((call) => call.accounting.input.billed !== undefined).length
  const reason: Reason | undefined = billed
    ? undefined
    : input.calls.length === 0
      ? calls
      : input.calls.every((call) => call.failed)
        ? "none-billed"
        : "no-usage"
  return {
    recorded: input.calls.length === 0 && !input.unrecorded ? "none" : recorded,
    ...(calls ? { calls } : {}),
    ...(reason ? { input: reason } : {}),
  }
}
