export * as OperatorPrompts from "./prompts"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { ToolRegistry } from "@/tool/registry"
import { OperatorGenerate } from "./generate"
import { OperatorHelperTexts } from "./helper-texts"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
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
  namespace: Schema.Struct({ id: Schema.String, name: Schema.String }),
  project: Schema.Struct({ key: Schema.String, name: Schema.String }),
  profile: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    source: Schema.Literals(["agent", "helper", "project", "namespace"]).annotate({
      description:
        "Where the profile comes from: the agent's setting, the helper rule, the project default or the namespace default",
    }),
  }),
  group: Schema.Struct({ id: Schema.String, name: Schema.String }),
  override: Schema.Array(Schema.String).annotate({ description: "The types whose slots the agent's override changed" }),
  sections: Schema.Array(OperatorProfile.AssembledSection),
  system: Schema.Array(Schema.String).annotate({ description: "The system messages exactly as sent" }),
}).annotate({ identifier: "OperatorPromptPreview" })
export type Preview = typeof Preview.Type

export const Sample = Schema.Struct({
  agent: Schema.String,
  model: Schema.String.annotate({ description: "provider/model the sample was made for" }),
  layer: Schema.String,
  text: Schema.String.annotate({ description: "What the layer fills in; empty when it adds nothing here" }),
  source: Schema.String.annotate({ description: "Where the text comes from: a file, an agent, or what wrote it" }),
}).annotate({ identifier: "OperatorPromptSample" })
export type Sample = typeof Sample.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorPromptNotFound", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly catalog: () => Effect.Effect<typeof Catalog.Type>
  readonly preview: (input: {
    agent: string
    providerID?: string
    modelID?: string
    /** Preview this profile on the agent instead of its own (without its override). */
    profile?: string
  }) => Effect.Effect<Preview, NotFoundError>
  /** What one layer fills in for an agent of this project: a Dynamic layer's sample. */
  readonly sample: (input: {
    agent: string
    layer: string
    providerID?: string
    modelID?: string
  }) => Effect.Effect<Sample, NotFoundError | OperatorGenerate.GenerateError>
  /** A draft org or project purpose, written by the purpose generator. */
  readonly purpose: (input: {
    kind: "org" | "project"
    ns?: string
    brief?: string
  }) => Effect.Effect<string, OperatorGenerate.GenerateError>
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
    const helpers = yield* OperatorHelperTexts.Service

    // The project's tools with their own descriptions; prompt profiles override them.
    const catalog = Effect.fn("OperatorPrompts.catalog")(function* () {
      const tools = (yield* registry.all()).filter((tool) => tool.id !== "invalid")
      return { tools: tools.map((tool) => ({ id: tool.id, builtin: tool.description })) }
    })

    // What a request of an agent of this project starts from: the model, the parts OpenCode writes for
    // it, and the project's prompt settings.
    const request = Effect.fnUntraced(function* (input: { agent: string; providerID?: string; modelID?: string }) {
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
      // OpenCode's title, summary and compaction calls carry no generated sections, only the agent's
      // prompt.
      const helper = OperatorProfile.HELPER_DEFAULTS.has(agent.name)
      const [env, files, mcp, skills] = helper
        ? [[], [], undefined, undefined]
        : yield* Effect.all([
            system.environment(model),
            instruction.system().pipe(Effect.orDie),
            system.mcp(agent),
            system.skills(agent),
          ])
      const key = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const loaded = yield* Effect.promise(() => OperatorProfileStore.forProject(key))
      const parts: OperatorProfile.Parts = { environment: env, instructions: files, mcp, skills, extra: [] }
      return { ctx, agent, model, key, loaded, parts }
    })

    const sample = Effect.fn("OperatorPrompts.sample")(function* (input: {
      agent: string
      layer: string
      providerID?: string
      modelID?: string
    }) {
      const { agent, model, loaded, parts } = yield* request(input)
      // Your Dynamic layers are written by the dynamic generator, here without a session.
      const own = OperatorProfile.findLayer(loaded.catalog, input.layer)
      if (own && OperatorProfile.isWrittenDynamic(own)) {
        const text = yield* helpers.sample(own)
        return {
          agent: agent.name,
          model: `${model.providerID}/${model.id}`,
          layer: input.layer,
          text,
          source: own.name,
        }
      }
      const found = OperatorProfile.sample(
        {
          catalog: loaded.catalog,
          project: loaded.project,
          agent: { name: agent.name, prompt: agent.prompt },
          setting: loaded.agents[agent.name],
          model,
          parts,
        },
        input.layer,
      )
      if (!found) return yield* new NotFoundError({ message: `No layer "${input.layer}"` })
      return { agent: agent.name, model: `${model.providerID}/${model.id}`, layer: input.layer, ...found }
    })

    const preview = Effect.fn("OperatorPrompts.preview")(function* (input: {
      agent: string
      providerID?: string
      modelID?: string
      profile?: string
    }) {
      const { ctx, agent, model, key, loaded, parts } = yield* request(input)
      if (input.profile && !OperatorProfile.profiles(loaded.catalog).some((item) => item.id === input.profile))
        return yield* new NotFoundError({
          message: `No profile "${input.profile}" in ${loaded.catalog.namespace.name}`,
        })
      const result = OperatorProfile.assemble({
        catalog: loaded.catalog,
        project: loaded.project,
        agent: { name: agent.name, prompt: agent.prompt },
        setting: loaded.agents[agent.name],
        profile: input.profile,
        model,
        parts,
        dynamic: written(loaded.catalog),
      })
      return {
        agent: agent.name,
        model: `${model.providerID}/${model.id}`,
        base: OperatorPromptText.baseFor(model).id,
        namespace: { id: loaded.catalog.namespace.id, name: loaded.catalog.namespace.name },
        project: { key, name: ctx.project.name ?? path.basename(key) },
        profile: result.profile,
        group: result.group,
        override: result.changed,
        sections: result.sections,
        system: result.system,
      }
    })

    // Your Dynamic layers are written for each session; the preview shows where their text goes.
    const written = (catalog: OperatorProfile.Catalog) =>
      new Map(
        catalog.layers
          .filter((item) => OperatorProfile.isWrittenDynamic(item))
          .map((item) => [item.id, `‹${item.name}: written for each session by the dynamic generator›`] as const),
      )

    const purpose = (input: { kind: "org" | "project"; ns?: string; brief?: string }) => helpers.purpose(input)

    return Service.of({ catalog, preview, sample, purpose })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Provider.node, SystemPrompt.node, Instruction.node, ToolRegistry.node, OperatorHelperTexts.node],
})
