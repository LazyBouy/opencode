export * as OperatorPrompts from "./prompts"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { ToolRegistry } from "@/tool/registry"
import { OperatorConfig } from "./config"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorPromptText } from "./prompt-text"

export const ToolEntry = Schema.Struct({
  id: Schema.String,
  builtin: Schema.String.annotate({ description: "The tool's own description" }),
}).annotate({ identifier: "OperatorPromptTool" })

export const Catalog = Schema.Struct({
  tools: Schema.Array(ToolEntry),
}).annotate({ identifier: "OperatorPromptCatalog" })

export const Preview = Schema.Struct({
  agent: Schema.String,
  model: Schema.String.annotate({ description: "provider/model the preview was built for" }),
  base: Schema.String.annotate({ description: "The Base Model Group layer for this model" }),
  project: Schema.Struct({ key: Schema.String, name: Schema.String }).annotate({
    description: "The project the agent belongs to, whose goal and layers apply",
  }),
  profile: Schema.Struct({ id: Schema.String, name: Schema.String }),
  mode: OperatorProfile.Mode,
  sections: Schema.Array(OperatorProfile.AssembledSection),
  system: Schema.Array(Schema.String).annotate({ description: "The system messages exactly as sent" }),
}).annotate({ identifier: "OperatorPromptPreview" })
export type Preview = typeof Preview.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorPromptNotFound", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly catalog: () => Effect.Effect<typeof Catalog.Type>
  readonly preview: (input: {
    agent: string
    providerID?: string
    modelID?: string
  }) => Effect.Effect<Preview, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPrompts") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const system = yield* SystemPrompt.Service
    const instruction = yield* Instruction.Service
    const registry = yield* ToolRegistry.Service
    const config = yield* Config.Service

    // The project's tools with their own descriptions; prompt profiles override them.
    const catalog = Effect.fn("OperatorPrompts.catalog")(function* () {
      const tools = (yield* registry.all()).filter((tool) => tool.id !== "invalid")
      return { tools: tools.map((tool) => ({ id: tool.id, builtin: tool.description })) }
    })

    const preview = Effect.fn("OperatorPrompts.preview")(function* (input: {
      agent: string
      providerID?: string
      modelID?: string
    }) {
      const ctx = yield* InstanceState.context
      const agent = yield* agents.get(input.agent)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${input.agent}"` })
      const ref =
        input.providerID && input.modelID
          ? { providerID: ProviderV2.ID.make(input.providerID), modelID: ModelV2.ID.make(input.modelID) }
          : (agent.model ?? (yield* provider.defaultModel().pipe(Effect.orDie)))
      const model = yield* provider
        .getModel(ref.providerID, ref.modelID)
        .pipe(Effect.mapError(() => new NotFoundError({ message: `No model ${ref.providerID}/${ref.modelID}` })))
      const cfg = yield* config.get()
      // Title, summary and compaction calls carry no generated sections, only the agent's prompt.
      const helper = OperatorProfile.HELPER_AGENTS.includes(agent.name)
      const [env, files, mcp, skills] = helper
        ? [[], [], undefined, undefined]
        : yield* Effect.all([
            system.environment(model),
            instruction.system().pipe(Effect.orDie),
            system.mcp(agent),
            system.skills(agent),
          ])
      const project = yield* Effect.promise(() => OperatorProfile.agentProject(agent, ctx))
      const key = OperatorProfile.projectKey(ctx)
      const catalog = yield* Effect.promise(() =>
        OperatorProfileStore.read([{ key, root: OperatorConfig.projectRoot(ctx) }]),
      )
      const settings = (cfg.agent?.[agent.name] as { promptProfile?: OperatorProfile.Settings } | undefined)
        ?.promptProfile
      const result = OperatorProfile.assemble({
        catalog,
        project,
        agent: { name: agent.name, prompt: agent.prompt, settings },
        model,
        parts: { environment: env, instructions: files, mcp, skills, extra: [] },
        toggles: OperatorPromptText.toggles(cfg),
      })
      return {
        agent: agent.name,
        model: `${model.providerID}/${model.id}`,
        base: OperatorPromptText.baseFor(model).id,
        project: {
          key: project,
          name: project === OperatorProfile.OPENCODE ? "OpenCode" : (ctx.project.name ?? path.basename(project)),
        },
        profile: result.profile,
        mode: result.mode,
        sections: result.sections,
        system: result.system,
      }
    })

    return Service.of({ catalog, preview })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Provider.node, SystemPrompt.node, Instruction.node, ToolRegistry.node, Config.node],
})
