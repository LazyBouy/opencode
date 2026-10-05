import type { Plugin } from "@opencode-ai/plugin"
import { Fiber } from "effect"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorPromptText } from "./prompt-text"

// Builds every request's system prompt from the agent's prompt profile (see profile.ts), and picks the
// version of tool descriptions, reminders and notices the profile holds. Profile files are read for
// every request, so edits apply to the next message. The agent page's preview calls the same assembler.
const PromptPlugin: Plugin = async (input) => {
  const key = OperatorProfile.projectKey({ directory: input.directory, worktree: input.worktree })
  // One read is shared for a second: preparing one request asks once per tool definition.
  let recent: { at: number; read: ReturnType<typeof OperatorProfileStore.forProject> } | undefined
  const context = () => {
    if (recent && Date.now() - recent.at < 1000) return recent.read
    recent = { at: Date.now(), read: OperatorProfileStore.forProject(key) }
    return recent.read
  }
  // The slots an agent's texts come from; without an agent, the project's or namespace's default.
  const slots = async (agent: string | undefined) => {
    const loaded = await context()
    return {
      loaded,
      slots: OperatorProfile.slotsFor(loaded.catalog, {
        agent,
        setting: agent ? loaded.agents[agent] : undefined,
        project: loaded.project,
      }),
    }
  }

  return {
    "experimental.chat.system.transform": async (hook, output) => {
      // The agent generator's call has no agent and only its own prompt.
      if (!hook.parts) {
        if (output.system[0] !== GENERATOR) return
        const found = await slots(undefined)
        const version = OperatorProfile.versionOf({
          catalog: found.loaded.catalog,
          slots: found.slots,
          builtin: `${OperatorProfile.PREFIX}generator.agent`,
        })
        if (version !== undefined) output.system[0] = version
        return
      }
      if (!hook.agent) return
      const loaded = await context()
      const result = OperatorProfile.assemble({
        catalog: loaded.catalog,
        project: loaded.project,
        agent: { name: hook.agent, prompt: hook.parts.agent.prompt },
        setting: loaded.agents[hook.agent],
        model: hook.model,
        parts: hook.parts,
      })
      promptAudit.listen?.({ agent: hook.agent, upstream: [...output.system], sent: result.system })
      output.system.splice(0, output.system.length, ...result.system)
    },
    "experimental.chat.messages.transform": async (_hook, output) => {
      // The step-limit notice is added later in this same loop step, which does not say which agent
      // runs; it finds the agent through this fiber (see OperatorPromptText.maxSteps).
      const fiber = Fiber.getCurrent()
      const last = output.messages.findLast((message) => message.info.role === "user")?.info
      const agent = last?.role === "user" ? last.agent : undefined
      if (fiber && agent) OperatorPromptText.loopAgents.set(fiber, agent)
      const found = await slots(agent)
      const versions = new Map(
        OperatorPromptText.BUILTINS.filter((item) => item.kind === "reminder").flatMap((item) => {
          const text = OperatorProfile.versionOf({
            catalog: found.loaded.catalog,
            slots: found.slots,
            builtin: `${OperatorProfile.PREFIX}${item.id}`,
          })
          return text === undefined ? [] : [[item.id, text] as const]
        }),
      )
      if (!versions.size) return
      for (const message of output.messages) {
        message.parts = message.parts.flatMap((part) => {
          if (part.type !== "text" || !part.synthetic) return [part]
          const text = OperatorPromptText.rewriteReminder(part.text, versions)
          if (text === part.text) return [part]
          return text.trim() ? [{ ...part, text }] : []
        })
      }
    },
    "tool.definition": async (hook, output) => {
      const found = await slots(hook.agent)
      const version = OperatorProfile.versionOf({
        catalog: found.loaded.catalog,
        slots: found.slots,
        builtin: `${OperatorProfile.PREFIX}tool.${hook.toolID}`,
      })
      if (version !== undefined) output.description = version
    },
  }
}

const GENERATOR = OperatorPromptText.BUILTINS.find((item) => item.id === "generator.agent")!.text

// For tests: sees each request's system prompt as upstream built it and as it is sent.
export const promptAudit: {
  listen?: (input: { agent: string; upstream: string[]; sent: string[] }) => void
} = {}

// Built-in plugins this fork adds; upstream's plugin service registers them with its own once.
export const operatorPlugins: Plugin[] = [PromptPlugin]
