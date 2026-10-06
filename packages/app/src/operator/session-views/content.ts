// A message as sent to a provider, in that provider's format (Anthropic, OpenAI chat, OpenAI responses,
// Google), turned into pieces to show: text, reasoning, tool calls (name, id, arguments), tool results
// (with the subagent session `task` started, when it says so), attachments as placeholders, and
// anything else as JSON. Nothing is changed: it is only laid out for reading.

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; encrypted?: boolean }
  | { kind: "tool-call"; name: string; id?: string; args: string }
  | { kind: "tool-result"; id?: string; name?: string; text: string; subagent?: string }
  | { kind: "attachment"; type: "image" | "file"; mime?: string; size?: number }
  | { kind: "json"; value: unknown }

type Item = Record<string, unknown>
const isItem = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const str = (value: unknown) => (typeof value === "string" ? value : undefined)
const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? {}))

// The subagent session `task` reports in its result ("task_id: ses_…").
export function subagentOf(text: string) {
  return text.match(/task_id:\s*(ses_[A-Za-z0-9]+)/)?.[1]
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((item) => (typeof item === "string" ? item : isItem(item) ? (str(item.text) ?? str(item.output) ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  if (isItem(value)) return str(value.text) ?? JSON.stringify(value)
  return ""
}

function result(id: string | undefined, text: string, name?: string): Piece {
  const subagent = subagentOf(text)
  return {
    kind: "tool-result",
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    text,
    ...(subagent ? { subagent } : {}),
  }
}

function sizeOf(data: unknown) {
  return typeof data === "string" ? Math.floor((data.length * 3) / 4) : undefined
}

// One content item (a block of a message's content list, or a Google part).
function block(item: unknown): Piece[] {
  if (typeof item === "string") return [{ kind: "text", text: item }]
  if (!isItem(item)) return [{ kind: "json", value: item }]
  const type = str(item.type)
  // Google parts
  if (str(item.text) !== undefined && type === undefined)
    return [item.thought ? { kind: "reasoning", text: str(item.text)! } : { kind: "text", text: str(item.text)! }]
  if (isItem(item.functionCall))
    return [{ kind: "tool-call", name: str(item.functionCall.name) ?? "", args: json(item.functionCall.args) }]
  if (isItem(item.functionResponse))
    return [result(undefined, json(item.functionResponse.response), str(item.functionResponse.name))]
  if (isItem(item.inlineData))
    return [
      {
        kind: "attachment",
        type: String(item.inlineData.mimeType ?? "").startsWith("image/") ? "image" : "file",
        mime: str(item.inlineData.mimeType),
        size: sizeOf(item.inlineData.data),
      },
    ]
  switch (type) {
    case "text":
    case "input_text":
    case "output_text":
      return [{ kind: "text", text: str(item.text) ?? "" }]
    case "thinking":
      return [{ kind: "reasoning", text: str(item.thinking) ?? "" }]
    case "redacted_thinking":
      return [{ kind: "reasoning", text: "", encrypted: true }]
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? textOf(item.summary) : (str(item.text) ?? "")
      return [{ kind: "reasoning", text: summary, ...(item.encrypted_content ? { encrypted: true } : {}) }]
    }
    case "tool_use":
      return [{ kind: "tool-call", name: str(item.name) ?? "", id: str(item.id), args: json(item.input) }]
    case "tool_result":
      return [result(str(item.tool_use_id), textOf(item.content))]
    case "function_call":
      return [{ kind: "tool-call", name: str(item.name) ?? "", id: str(item.call_id), args: json(item.arguments) }]
    case "function_call_output":
      return [result(str(item.call_id), textOf(item.output))]
    case "image":
    case "image_url":
    case "input_image": {
      const source = isItem(item.source) ? item.source : undefined
      return [{ kind: "attachment", type: "image", mime: str(source?.media_type), size: sizeOf(source?.data) }]
    }
    case "document":
    case "file":
    case "input_file": {
      const source = isItem(item.source) ? item.source : undefined
      return [{ kind: "attachment", type: "file", mime: str(source?.media_type), size: sizeOf(source?.data) }]
    }
    case "message":
      return pieces(item)
  }
  return [{ kind: "json", value: item }]
}

// A whole message, in order.
export function pieces(message: unknown): Piece[] {
  if (!isItem(message)) return block(message)
  // OpenAI responses items that are not messages
  if (message.type && message.type !== "message" && message.role === undefined) return block(message)
  const out: Piece[] = []
  const reasoning = str(message.reasoning_content) ?? str(message.reasoning)
  if (reasoning) out.push({ kind: "reasoning", text: reasoning })
  // OpenAI chat: a tool result is a message with role "tool"
  if (message.role === "tool") return [...out, result(str(message.tool_call_id), textOf(message.content))]
  const content = message.content ?? message.parts
  if (typeof content === "string") {
    if (content) out.push({ kind: "text", text: content })
  } else if (Array.isArray(content)) out.push(...content.flatMap(block))
  if (Array.isArray(message.tool_calls))
    for (const call of message.tool_calls)
      if (isItem(call) && isItem(call.function))
        out.push({
          kind: "tool-call",
          name: str(call.function.name) ?? "",
          id: str(call.id),
          args: json(call.function.arguments),
        })
  return out
}

// Arguments as pretty JSON when they parse, else as received.
export function prettyArgs(args: string) {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

// What changed between two texts, line by line: enough to see a changed system prompt.
export function lineDiff(before: string, after: string) {
  const old = before.split("\n")
  const next = after.split("\n")
  const kept = new Set(old.filter((line) => next.includes(line)))
  return [
    ...old.filter((line) => !kept.has(line)).map((text) => ({ change: "removed" as const, text })),
    ...next.filter((line) => !kept.has(line)).map((text) => ({ change: "added" as const, text })),
  ]
}

// Messages already sent in earlier calls, folded into runs: "Messages 1–14: same as call 6".
export function runs<T extends { index: number; seenIn?: number }>(messages: ReadonlyArray<T>) {
  const out: Array<{ seen: { from: number; to: number; call: number } } | { message: T }> = []
  for (const message of messages) {
    const last = out.at(-1)
    if (message.seenIn !== undefined) {
      if (last && "seen" in last && last.seen.to === message.index - 1) {
        last.seen.to = message.index
        last.seen.call = Math.max(last.seen.call, message.seenIn)
        continue
      }
      out.push({ seen: { from: message.index, to: message.index, call: message.seenIn } })
      continue
    }
    out.push({ message })
  }
  return out
}
