import type { Plugin } from "@opencode-ai/plugin"
import { OperatorIdentity } from "./identity"
import { OperatorPromptText } from "./prompt-text"

// Applies the operator's prompt settings to what the model receives: overrides of OpenCode's own
// prompt texts, the generated-section switches, reminder and tool-description overrides, and the
// identity layers. Override files are read on every request, so edits apply to the next turn.
const PromptPlugin: Plugin = async (input) => {
  let switches = OperatorPromptText.toggles({})
  return {
    config: async (config) => {
      switches = OperatorPromptText.toggles(config as Parameters<typeof OperatorPromptText.toggles>[0])
    },
    "experimental.chat.system.transform": async (hook, output) => {
      const overrides = await OperatorPromptText.readOverrides(input)
      output.system.forEach((value, index) => {
        output.system[index] = OperatorPromptText.rewriteSystem(value, {
          model: hook.model,
          overrides,
          toggles: switches,
        })
      })
      const identity = OperatorIdentity.render(
        await OperatorIdentity.readLayers(OperatorIdentity.folders(input)),
        hook.agent,
      )
      if (identity) output.system.unshift(identity)
    },
    "experimental.chat.messages.transform": async (_hook, output) => {
      const overrides = await OperatorPromptText.readOverrides(input)
      for (const message of output.messages) {
        message.parts = message.parts.flatMap((part) => {
          if (part.type !== "text" || !part.synthetic) return [part]
          const text = OperatorPromptText.rewriteReminder(part.text, overrides)
          if (text === part.text) return [part]
          return text.trim() ? [{ ...part, text }] : []
        })
      }
    },
    "tool.definition": async (hook, output) => {
      const override = (await OperatorPromptText.readOverrides(input)).get(`tool.${hook.toolID}`)
      if (override) output.description = override.text
    },
  }
}

// Built-in plugins this fork adds; upstream's plugin service registers them with its own once.
export const operatorPlugins: Plugin[] = [PromptPlugin]
