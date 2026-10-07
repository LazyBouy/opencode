export * as OperatorCallPieces from "./call-pieces"

import { OperatorPromptText } from "./prompt-text"

// The billed pieces of a request's messages, in the provider's format (Anthropic, OpenAI chat, OpenAI
// responses, Google): text, reasoning sent back, tool calls, tool results, attachments. Each piece
// keeps the text a tokenizer would count (its `payload`). A block this file does not know is a piece of
// kind "unknown", so nothing sent goes uncounted (see call-accounting.ts). Pure.

// ---- The request body's parts ----

// The text of a message's content (or of system blocks).
export function textOf(value: unknown): string {
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

export const SYSTEM_ROLES = ["system", "developer"]

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

// The tools as sent, each with its JSON (its definition as the provider gets it).
export function toolNames(body: Record<string, unknown> | undefined) {
  const tools = body?.tools
  if (!Array.isArray(tools)) return [] as Array<{ name: string; json: string; value: Record<string, unknown> }>
  return tools.flatMap((tool) => {
    const record = tool as Record<string, any>
    if (Array.isArray(record.functionDeclarations))
      return record.functionDeclarations.map((item: Record<string, unknown>) => ({
        name: String(item.name),
        json: JSON.stringify(item),
        value: item,
      }))
    const name = record.function?.name ?? record.name
    return name ? [{ name: String(name), json: JSON.stringify(tool), value: record }] : []
  })
}

// Texts OpenCode adds to a request in memory: the plan reminders, the switch to build, the step limit.
const IN_MEMORY_IDS = ["reminder.plan", "reminder.plan-mode", "reminder.build-switch", "notice.max-steps"] as const
export type InMemoryID = (typeof IN_MEMORY_IDS)[number]
// Each in-memory text by its first plain line, which is how it is found in a body.
export const IN_MEMORY_LINES = IN_MEMORY_IDS.map((id) => ({
  id,
  line:
    (OperatorPromptText.BUILTINS.find((item) => item.id === id)?.text ?? "")
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("<"))
      ?.trim() ?? "",
})).filter((item) => item.line)
export const IN_MEMORY = IN_MEMORY_LINES.map((item) => item.line)
export const CLEARED = "[Old tool result content cleared]"
// The note OpenCode puts in a tool output it shortened (tool/truncate.ts).
export const TRUNCATED = "The tool call succeeded but the output was truncated."

// ---- Messages ----

export type Piece = {
  kind: "text" | "reasoning" | "tool-call" | "tool-result" | "attachment" | "unknown"
  role: string
  /** The message's place in the message list (0-based, system messages left out). */
  message: number
  payload: string
  name?: string
  id?: string
  encrypted?: boolean
  attachment?: { type: "image" | "file"; mime?: string; size?: number }
}

type Item = Record<string, unknown>
const isItem = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const str = (value: unknown) => (typeof value === "string" ? value : undefined)
const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? {}))

function resultText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((item) =>
        typeof item === "string" ? item : isItem(item) ? (str(item.text) ?? str(item.output) ?? json(item)) : "",
      )
      .filter(Boolean)
      .join("\n")
  if (isItem(value)) return str(value.text) ?? JSON.stringify(value)
  return ""
}

const sizeOf = (data: unknown) => (typeof data === "string" ? Math.floor((data.length * 3) / 4) : undefined)

// One block of a message's content (or a Google part).
function block(item: unknown, role: string, message: number): Piece[] {
  const at = { role, message }
  if (typeof item === "string") return item ? [{ kind: "text", ...at, payload: item }] : []
  if (!isItem(item)) return [{ kind: "unknown", ...at, payload: json(item) }]
  const type = str(item.type)
  // Google parts
  if (type === undefined) {
    if (str(item.text) !== undefined)
      return [{ kind: item.thought ? "reasoning" : "text", ...at, payload: str(item.text)! }]
    if (isItem(item.functionCall))
      return [{ kind: "tool-call", ...at, name: str(item.functionCall.name), payload: json(item.functionCall.args) }]
    if (isItem(item.functionResponse))
      return [
        {
          kind: "tool-result",
          ...at,
          name: str(item.functionResponse.name),
          payload: json(item.functionResponse.response),
        },
      ]
    if (isItem(item.inlineData))
      return [
        {
          kind: "attachment",
          ...at,
          payload: "",
          attachment: {
            type: String(item.inlineData.mimeType ?? "").startsWith("image/") ? "image" : "file",
            mime: str(item.inlineData.mimeType),
            size: sizeOf(item.inlineData.data),
          },
        },
      ]
    if (isItem(item.fileData))
      return [
        { kind: "attachment", ...at, payload: "", attachment: { type: "file", mime: str(item.fileData.mimeType) } },
      ]
    if (typeof item.thoughtSignature === "string") return []
  }
  switch (type) {
    case "text":
    case "input_text":
    case "output_text":
      return [{ kind: "text", ...at, payload: str(item.text) ?? "" }]
    case "thinking":
      return [{ kind: "reasoning", ...at, payload: str(item.thinking) ?? "" }]
    case "redacted_thinking":
      return [{ kind: "reasoning", ...at, payload: str(item.data) ?? "", encrypted: true }]
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? resultText(item.summary) : (str(item.text) ?? "")
      const encrypted = str(item.encrypted_content)
      return [
        {
          kind: "reasoning",
          ...at,
          payload: summary || encrypted || "",
          ...(encrypted && !summary ? { encrypted: true } : {}),
        },
      ]
    }
    case "tool_use":
      return [{ kind: "tool-call", ...at, name: str(item.name), id: str(item.id), payload: json(item.input) }]
    case "tool_result":
      return [{ kind: "tool-result", ...at, id: str(item.tool_use_id), payload: resultText(item.content) }]
    case "function_call":
      return [{ kind: "tool-call", ...at, name: str(item.name), id: str(item.call_id), payload: json(item.arguments) }]
    case "function_call_output":
      return [{ kind: "tool-result", ...at, id: str(item.call_id), payload: resultText(item.output) }]
    case "image":
    case "image_url":
    case "input_image": {
      const source = isItem(item.source) ? item.source : undefined
      const url = isItem(item.image_url) ? str(item.image_url.url) : str(item.image_url)
      return [
        {
          kind: "attachment",
          ...at,
          payload: "",
          attachment: {
            type: "image",
            mime: str(source?.media_type) ?? url?.match(/^data:([^;]+);/)?.[1],
            size: sizeOf(source?.data) ?? sizeOf(url?.replace(/^data:[^,]*,/, "")),
          },
        },
      ]
    }
    case "document":
    case "file":
    case "input_file": {
      const source = isItem(item.source) ? item.source : isItem(item.file) ? item.file : undefined
      return [
        {
          kind: "attachment",
          ...at,
          payload: "",
          attachment: { type: "file", mime: str(source?.media_type), size: sizeOf(source?.data ?? source?.file_data) },
        },
      ]
    }
    case "message":
      return pieces(item, message)
  }
  return [{ kind: "unknown", ...at, payload: json(item) }]
}

// A message's pieces, in order.
export function pieces(message: unknown, index: number): Piece[] {
  if (!isItem(message)) return block(message, "?", index)
  const role = str(message.role) ?? str(message.type) ?? "?"
  // OpenAI responses items that are not messages
  if (message.type && message.type !== "message" && message.role === undefined) return block(message, role, index)
  const out: Piece[] = []
  // Reasoning sent back beside the content (OpenAI chat providers: Kimi, DeepSeek, OpenRouter).
  if (Array.isArray(message.reasoning_details) && message.reasoning_details.length) {
    for (const detail of message.reasoning_details) {
      if (!isItem(detail)) continue
      const encrypted = detail.type === "reasoning.encrypted"
      out.push({
        kind: "reasoning",
        role,
        message: index,
        payload: encrypted ? (str(detail.data) ?? "") : (str(detail.text) ?? str(detail.summary) ?? ""),
        ...(encrypted ? { encrypted: true } : {}),
      })
    }
  } else {
    const reasoning = str(message.reasoning_content) ?? str(message.reasoning)
    if (reasoning) out.push({ kind: "reasoning", role, message: index, payload: reasoning })
  }
  // OpenAI chat: a tool result is a message with role "tool"
  if (message.role === "tool")
    return [
      ...out,
      {
        kind: "tool-result",
        role,
        message: index,
        id: str(message.tool_call_id),
        payload: resultText(message.content),
      },
    ]
  const content = message.content ?? message.parts
  if (typeof content === "string") {
    if (content) out.push({ kind: "text", role, message: index, payload: content })
  } else if (Array.isArray(content)) out.push(...content.flatMap((item) => block(item, role, index)))
  if (Array.isArray(message.tool_calls))
    for (const call of message.tool_calls)
      if (isItem(call) && isItem(call.function))
        out.push({
          kind: "tool-call",
          role,
          message: index,
          name: str(call.function.name),
          id: str(call.id),
          payload: json(call.function.arguments),
        })
  return out
}
