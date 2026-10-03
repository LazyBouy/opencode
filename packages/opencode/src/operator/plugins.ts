import path from "path"
import type { Plugin } from "@opencode-ai/plugin"
import { OperatorConfig } from "./config"
import { OperatorIdentity } from "./identity"

// Adds the identity layers that apply to the agent at the top of its system prompt. Layers are read
// on every request, so edits apply to the next turn without reloading the project.
const IdentityPlugin: Plugin = async (input) => ({
  "experimental.chat.system.transform": async (hook, output) => {
    const text = OperatorIdentity.render(
      await OperatorIdentity.readLayers({
        global: path.join(OperatorConfig.scopeDirectory("global", input), "identity"),
        project: path.join(OperatorConfig.scopeDirectory("project", input), "identity"),
      }),
      hook.agent,
    )
    if (text) output.system.unshift(text)
  },
})

// Built-in plugins this fork adds; upstream's plugin service registers them with its own once.
export const operatorPlugins: Plugin[] = [IdentityPlugin]
