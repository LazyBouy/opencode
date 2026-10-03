import { LLMEvent } from "@opencode-ai/llm"
import type { MergeAdapter } from "./adapter/adapter"

// Translates harness events into the LLMEvent stream the session processor already consumes.
// Every tool is marked `providerExecuted`: the child ran it, so OpenCode records the call and
// result for display and must never dispatch it again.
export function translator(input: { adapter: MergeAdapter.Adapter; cwd: string }) {
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>()

  return (event: MergeAdapter.Event): LLMEvent[] => {
    switch (event.type) {
      case "text-start":
        return [LLMEvent.textStart({ id: event.id })]
      case "text-delta":
        return [LLMEvent.textDelta({ id: event.id, text: event.text })]
      case "text-end":
        return [LLMEvent.textEnd({ id: event.id })]
      case "reasoning-start":
        return [LLMEvent.reasoningStart({ id: event.id })]
      case "reasoning-delta":
        return [LLMEvent.reasoningDelta({ id: event.id, text: event.text })]
      case "reasoning-end":
        return [LLMEvent.reasoningEnd({ id: event.id })]
      case "tool": {
        if (event.status === "running") {
          if (tools.has(event.id) || !event.input) return []
          const view = input.adapter.describeTool(event.name, event.input, input.cwd)
          tools.set(event.id, { name: event.name, input: event.input })
          return [
            LLMEvent.toolCall({
              id: event.id,
              name: view.tool,
              input: view.input,
              providerExecuted: true,
              providerMetadata: { merge: { tool: event.name, input: event.input } },
            }),
          ]
        }
        const call = tools.get(event.id)
        if (!call) return []
        const view = input.adapter.describeTool(call.name, call.input, input.cwd)
        const output = event.output ?? ""
        if (event.status === "error")
          return [
            LLMEvent.toolResult({
              id: event.id,
              name: view.tool,
              result: { type: "error", value: output || `${call.name} failed` },
              providerExecuted: true,
            }),
          ]
        return [
          LLMEvent.toolResult({
            id: event.id,
            name: view.tool,
            result: {
              type: "json",
              value: {
                output,
                title: title(view),
                metadata: { ...(view.tool === "bash" ? { output } : {}), merge: { tool: call.name } },
              },
            },
            providerExecuted: true,
          }),
        ]
      }
      case "error":
        return [LLMEvent.providerError({ message: event.message, retryable: false })]
      case "done":
        if (event.isError && !event.interrupted)
          return [
            LLMEvent.providerError({
              message: event.errors.join("; ") || event.result || "The merged session ended with an error",
              retryable: false,
            }),
          ]
        return []
      case "session":
      case "permission-request":
      case "permission-cancel":
        return []
    }
  }
}

function title(view: MergeAdapter.ToolView) {
  const candidate =
    view.input.description ?? view.input.filePath ?? view.input.pattern ?? view.input.url ?? view.input.query
  return typeof candidate === "string" ? candidate : view.tool
}

export * as MergeStream from "./stream"
