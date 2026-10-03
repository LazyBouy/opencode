import type { MergeAdapter } from "../adapter"
import type { ClaudeProtocol } from "./protocol"

// Claude emits partial `stream_event` deltas and then one full `assistant` message per content
// block. Text and thinking are projected from the deltas; full messages only fill in blocks that
// were never streamed. Tool calls are projected from the full message because it carries the
// complete input. Content from sub-agents (`parent_tool_use_id`) is not projected in v1.
export function mapper() {
  const blocks = new Map<number, { kind: "text" | "reasoning"; id: string }>()
  const streamed = new Set<string>()
  let message = ""

  return (line: ClaudeProtocol.Line): MergeAdapter.Event[] => {
    switch (line.kind) {
      case "init":
        return [
          {
            type: "session",
            externalSessionID: line.value.session_id,
            model: line.value.model,
            mode: line.value.permissionMode,
          },
        ]

      case "stream": {
        if (line.value.parent_tool_use_id) return []
        const event = line.value.event
        if (event.type === "message_start" && "message" in event) {
          message = event.message.id
          blocks.clear()
          return []
        }
        if (event.type === "content_block_start" && "content_block" in event) {
          const kind =
            event.content_block.type === "text"
              ? "text"
              : event.content_block.type === "thinking"
                ? "reasoning"
                : undefined
          if (!kind) return []
          const id = `${message}:${event.index}`
          blocks.set(event.index, { kind, id })
          streamed.add(message)
          return [{ type: kind === "text" ? "text-start" : "reasoning-start", id }]
        }
        if (event.type === "content_block_delta" && "delta" in event) {
          const block = blocks.get(event.index)
          if (!block) return []
          const text = block.kind === "text" ? event.delta.text : event.delta.thinking
          if (!text) return []
          return [{ type: block.kind === "text" ? "text-delta" : "reasoning-delta", id: block.id, text }]
        }
        if (event.type === "content_block_stop" && "index" in event) {
          const block = blocks.get(event.index)
          if (!block) return []
          blocks.delete(event.index)
          return [{ type: block.kind === "text" ? "text-end" : "reasoning-end", id: block.id }]
        }
        return []
      }

      case "assistant": {
        if (line.value.parent_tool_use_id) return []
        const id = line.value.message.id
        return line.value.message.content.flatMap((block, index): MergeAdapter.Event[] => {
          if (block.type === "tool_use" && "input" in block && "id" in block && "name" in block)
            return [{ type: "tool", id: block.id, name: block.name, input: block.input, status: "running" }]
          if (streamed.has(id)) return []
          const key = `${id}:${line.value.uuid ?? index}`
          if (block.type === "text" && "text" in block)
            return [
              { type: "text-start", id: key },
              { type: "text-delta", id: key, text: block.text },
              { type: "text-end", id: key },
            ]
          if (block.type === "thinking" && "thinking" in block)
            return [
              { type: "reasoning-start", id: key },
              { type: "reasoning-delta", id: key, text: block.thinking },
              { type: "reasoning-end", id: key },
            ]
          return []
        })
      }

      case "user": {
        if (line.value.parent_tool_use_id) return []
        const content = line.value.message.content
        if (typeof content === "string") return []
        return content.flatMap((block): MergeAdapter.Event[] => {
          if (block.type !== "tool_result" || !("tool_use_id" in block)) return []
          return [
            {
              type: "tool",
              id: block.tool_use_id,
              name: "",
              output: resultText(block.content),
              status: block.is_error ? "error" : "completed",
            },
          ]
        })
      }

      case "result":
        return [
          {
            type: "done",
            isError: line.value.is_error === true,
            interrupted: line.value.terminal_reason?.startsWith("aborted") === true,
            result: line.value.result,
            errors: line.value.errors ?? [],
            costUSD: line.value.total_cost_usd,
            durationMs: line.value.duration_ms,
            turns: line.value.num_turns,
            denials: (line.value.permission_denials ?? []).map((item) => ({
              tool: item.tool_name,
              input: item.tool_input,
            })),
          },
        ]

      case "can-use-tool":
        return [
          {
            type: "permission-request",
            id: line.value.request_id,
            tool: line.value.request.tool_name,
            toolCallID: line.value.request.tool_use_id,
            input: line.value.request.input,
            blockedPath: line.value.request.blocked_path,
            description: line.value.request.description,
          },
        ]

      case "cancel":
        return [{ type: "permission-cancel", id: line.value.request_id }]
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (typeof item === "object" && item !== null && "text" in item && typeof item.text === "string") return item.text
      return JSON.stringify(item)
    })
    .join("\n")
}

export * as ClaudeEvents from "./events"
