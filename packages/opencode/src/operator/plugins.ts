import type { Plugin } from "@opencode-ai/plugin"
import { Context, Fiber } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { OperatorHelperAgents } from "./helper-agents"
import { OperatorHelperTool } from "./helper-tool"
import { OperatorMemoryTool } from "./memory-tool"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
import { OperatorPromptText } from "./prompt-text"
import { OperatorProviderTap } from "./provider-tap"
import { OperatorRegistry } from "./registry"

// Builds every request's system prompt from the agent's prompt profile (see profile.ts), and picks the
// version of tool descriptions, reminders and notices the profile holds. Profile files are read for
// every request, so edits apply to the next message. The agent page's preview calls the same assembler.
const PromptPlugin: Plugin = async (input) => {
  // One read is shared for a second, until the store changes: preparing one request asks once per tool
  // definition. The project is looked up each time: a folder outside git can be registered (or its
  // parent) while it is open.
  let recent: { at: number; revision: number; read: ReturnType<typeof OperatorProfileStore.forProject> } | undefined
  const context = () => {
    const revision = OperatorProfileStore.storeRevision()
    if (recent && recent.revision === revision && Date.now() - recent.at < 1000) return recent.read
    recent = {
      at: Date.now(),
      revision,
      read: OperatorProjects.keyOf({ directory: input.directory, worktree: input.worktree }).then(
        OperatorProfileStore.forProject,
      ),
    }
    return recent.read
  }
  // The slots an agent's texts come from; without an agent, the project's or namespace's default.
  const slots = async (agent: string | undefined) => {
    const loaded = await context()
    return {
      loaded,
      slots: OperatorProfile.slotsFor(loaded.catalog, {
        agent,
        setting: agent ? settingOf(loaded, agent) : undefined,
        project: loaded.project,
      }),
    }
  }

  return {
    // The fork's own tools: short-term memory (memory-tool.ts), helpers and their system actions (helper-tool.ts).
    tool: {
      memory: OperatorMemoryTool.memoryTool,
      helper: OperatorHelperTool.helperTool,
      ...OperatorHelperTool.actionTools,
    },
    // Registers the model call for recording (provider-tap.ts): its id goes in a header the provider tap
    // removes before the request leaves. Recording never gets in the way of the request.
    "chat.headers": async (hook, output) => {
      try {
        const fiber = Fiber.getCurrent()
        const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
        const begin = OperatorRegistry.calls.begin
        if (!begin) return
        // The resolutions system.transform made for this request, in this same fiber.
        const resolutions = fiber ? requestResolutions.get(fiber) : undefined
        if (fiber) requestResolutions.delete(fiber)
        const callID = await begin({
          instance,
          sessionID: hook.sessionID,
          agent: hook.agent,
          providerID: hook.model.providerID,
          modelID: hook.model.id,
          userMessageID: hook.message?.id,
          ...(resolutions?.length ? { resolutions } : {}),
        })
        if (callID) output.headers[OperatorProviderTap.HEADER] = callID
      } catch {
        // not recorded
      }
    },
    "experimental.chat.system.transform": async (hook, output) => {
      // The request's project instance, taken before anything is awaited (see written()).
      const fiber = Fiber.getCurrent()
      const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
      // The agent generator's call has no agent and only its own prompt: the helper layer of the
      // profile "agent-generator" uses (its own setting, else the Agent generator helper profile).
      if (!hook.parts) {
        if (output.system[0] !== GENERATOR) return
        const loaded = await context()
        const result = OperatorProfile.assemble({
          catalog: loaded.catalog,
          project: loaded.project,
          agent: { name: OperatorProfile.AGENT_GENERATOR },
          setting: loaded.agents[OperatorProfile.AGENT_GENERATOR],
          model: hook.model,
          parts: { environment: [], instructions: [] },
        })
        if (result.system[0]) output.system[0] = result.system[0]
        return
      }
      if (!hook.agent) return
      const loaded = await context()
      const setting = settingOf(loaded, hook.agent)
      // OpenCode's per-request Dynamic layers, and the agent's layers with rules of their own, through the
      // pipeline (dynamic-layers.ts); without it, OpenCode's as upstream wrote them and yours as written.
      const agentSlots = OperatorProfile.slotsFor(loaded.catalog, {
        agent: hook.agent,
        setting,
        project: loaded.project,
      })
      const custom = OperatorProfile.ruledLayers(loaded.catalog, agentSlots)
      const resolved = instance
        ? await OperatorRegistry.dynamicLayers
            .resolve?.({
              instance,
              agent: hook.agent,
              model: hook.model,
              ...(hook.sessionID ? { sessionID: hook.sessionID } : {}),
              instructions: hook.parts.instructions,
              ...(custom.length ? { custom } : {}),
              ...(OperatorProfile.holdsMemory(loaded.catalog, agentSlots) ? { memory: true } : {}),
            })
            .catch(() => undefined)
        : undefined
      const result = OperatorProfile.assemble({
        catalog: loaded.catalog,
        project: loaded.project,
        agent: { name: hook.agent, prompt: hook.parts.agent.prompt },
        setting,
        model: hook.model,
        parts: hook.parts,
        ...(resolved ? {} : { dynamic: await written(instance, hook.sessionID, loaded, hook.agent) }),
        ...(resolved ? { resolved: resolved as OperatorProfile.AssembleInput["resolved"] } : {}),
      })
      if (fiber)
        requestResolutions.set(
          fiber,
          result.sections.flatMap((section) =>
            section.resolution
              ? [
                  {
                    layer: section.layer,
                    name: section.layerName,
                    ...(section.parity ? { parity: section.parity } : {}),
                    resolution: section.resolution,
                  },
                ]
              : [],
          ),
        )
      promptAudit.listen?.({
        agent: hook.agent,
        upstream: [...output.system],
        sent: result.system,
        sections: result.sections,
      })
      output.system.splice(0, output.system.length, ...result.system)
    },
    "experimental.chat.messages.transform": async (_hook, output) => {
      // The step-limit notice is added later in this same loop step, which does not say which agent
      // runs; it finds the agent through this fiber (see OperatorPromptText.maxSteps).
      const fiber = Fiber.getCurrent()
      const last = output.messages.findLast((message) => message.info.role === "user")?.info
      const agent = last?.role === "user" ? last.agent : undefined
      if (fiber && agent) OperatorPromptText.loopAgents.set(fiber, agent)
      // The step's session, for the lists upstream builds from the agent alone (permission-effective.ts).
      if (fiber && last) OperatorPermissionEffective.loopSessions.set(fiber, last.sessionID)
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
      // The helper tool lists the agent's namespace's callable helpers (helper-runs.ts).
      if (hook.toolID === "helper" && hook.agent) {
        const fiber = Fiber.getCurrent()
        const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
        const text = instance
          ? await OperatorRegistry.helpers.describe?.({ instance, agent: hook.agent }).catch(() => undefined)
          : undefined
        if (text) output.description = text
        return
      }
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

// An agent's prompt setting: its own; a helper's agent uses its helper profile (helper-agents.ts).
function settingOf(loaded: Awaited<ReturnType<typeof OperatorProfileStore.forProject>>, agent: string) {
  const own = loaded.agents[agent]
  if (own) return own
  const profile = OperatorHelperAgents.profileOf(agent)
  return profile ? { profile } : undefined
}

// The texts of your Dynamic layers in the agent's profile, written (once per session) by the server's
// OperatorHelperTexts service. Without the service (or on a failure), they add nothing.
async function written(
  instance: unknown,
  sessionID: string | undefined,
  loaded: Awaited<ReturnType<typeof OperatorProfileStore.forProject>>,
  agent: string,
) {
  const slots = OperatorProfile.slotsFor(loaded.catalog, {
    agent,
    setting: settingOf(loaded, agent),
    project: loaded.project,
  })
  const layers = (slots[OperatorProfile.DYNAMIC] ?? []).filter((id) =>
    OperatorProfile.isWrittenDynamic(OperatorProfile.findLayer(loaded.catalog, id)),
  )
  const dynamic = OperatorRegistry.helperTexts.dynamic
  if (!layers.length || !dynamic || !instance) return undefined
  const texts = await dynamic({ instance, sessionID, layers }).catch(() => ({}))
  return new Map(Object.entries(texts))
}

// Each request's Dynamic layers' resolutions, from system.transform to chat.headers (the same request's
// fiber), where they are registered with the recorded call (calls.ts).
const requestResolutions = new WeakMap<object, ReadonlyArray<unknown>>()

const GENERATOR = OperatorPromptText.BUILTINS.find((item) => item.id === "helper.agent-generator")!.text

// For tests: sees each request's system prompt as upstream built it and as it is sent.
export const promptAudit: {
  listen?: (input: {
    agent: string
    upstream: string[]
    sent: string[]
    sections?: ReadonlyArray<OperatorProfile.AssembledSection>
  }) => void
} = {}

// Built-in plugins this fork adds; upstream's plugin service registers them with its own once.
export const operatorPlugins: Plugin[] = [PromptPlugin]
