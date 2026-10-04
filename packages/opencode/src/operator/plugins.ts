import type { Plugin } from "@opencode-ai/plugin"
import { OperatorConfig } from "./config"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorPromptText } from "./prompt-text"

// Builds every request's system prompt from the agent's prompt profile (see profile.ts), and applies
// overrides in scope to reminders, notices and tool descriptions. Profile files are read for every
// request, so edits apply to the next message. The agent page's preview calls the same assembler.
const PromptPlugin: Plugin = async (input) => {
  const ctx = { directory: input.directory, worktree: input.worktree }
  const project = OperatorProfile.projectKey(ctx)
  // Profile files are read for every request; one read is shared for a second, since preparing one
  // request asks for the catalog once per tool definition.
  let recent: { at: number; read: Promise<OperatorProfile.Catalog> } | undefined
  const catalog = () => {
    if (recent && Date.now() - recent.at < 1000) return recent.read
    recent = {
      at: Date.now(),
      read: OperatorProfileStore.read([{ key: project, root: OperatorConfig.projectRoot(ctx) }]),
    }
    return recent.read
  }
  // Agent definitions load with the project, so which project an agent belongs to is kept until the
  // project reloads (which builds this plugin again).
  const projects = new Map<string, Promise<string>>()
  const projectOf = (agent: string, native?: boolean) => {
    const known = projects.get(agent)
    if (known && native === undefined) return known
    const found = OperatorProfile.agentProject({ name: agent, native }, ctx)
    if (native !== undefined) projects.set(agent, found)
    return found
  }
  let switches = OperatorPromptText.toggles({})
  let settings: Record<string, OperatorProfile.Settings | undefined> = {}

  return {
    config: async (config) => {
      switches = OperatorPromptText.toggles(config as Parameters<typeof OperatorPromptText.toggles>[0])
      const agents = (config.agent ?? {}) as Record<string, { promptProfile?: OperatorProfile.Settings } | undefined>
      settings = Object.fromEntries(Object.entries(agents).map((pair) => [pair[0], pair[1]?.promptProfile]))
    },
    "experimental.chat.system.transform": async (hook, output) => {
      // The agent generator's call has no agent and only its own prompt.
      if (!hook.parts) {
        if (output.system[0] !== GENERATOR) return
        const found = OperatorProfile.folderOverride((await catalog()).layers, "generator.agent", project)
        if (found) output.system[0] = found.text
        return
      }
      if (!hook.agent) return
      const result = OperatorProfile.assemble({
        catalog: await catalog(),
        project: await projectOf(hook.agent, hook.parts.agent.native ?? false),
        agent: { name: hook.agent, prompt: hook.parts.agent.prompt, settings: settings[hook.agent] },
        model: hook.model,
        parts: hook.parts,
        toggles: switches,
      })
      output.system.splice(0, output.system.length, ...result.system)
    },
    "experimental.chat.messages.transform": async (_hook, output) => {
      const last = output.messages.findLast((message) => message.info.role === "user")?.info
      const agent = last?.role === "user" ? last.agent : undefined
      const overrides = OperatorProfile.messageOverrides(await catalog(), {
        project: agent ? await projectOf(agent) : project,
        agent,
      })
      for (const message of output.messages) {
        message.parts = message.parts.flatMap((part) => {
          if (part.type !== "text" || !part.synthetic) return [part]
          const text = OperatorPromptText.rewriteReminder(part.text, overrides)
          if (text === part.text) return [part]
          return text.trim() ? [{ ...part, text }] : []
        })
      }
    },
    // The hook does not say which agent the tools are for.
    "tool.definition": async (hook, output) => {
      const found = OperatorProfile.folderOverride((await catalog()).layers, `tool.${hook.toolID}`, project)
      if (found) output.description = found.text
    },
  }
}

const GENERATOR = OperatorPromptText.BUILTINS.find((item) => item.id === "generator.agent")!.text

// Built-in plugins this fork adds; upstream's plugin service registers them with its own once.
export const operatorPlugins: Plugin[] = [PromptPlugin]
