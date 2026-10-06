export * as OperatorPrompts from "./prompts"

import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { ToolRegistry } from "@/tool/registry"
import { OperatorAgents } from "./agents"
import { OperatorConfig } from "./config"
import { OperatorGenerate } from "./generate"
import { OperatorHelperTexts } from "./helper-texts"
import { OperatorModels } from "./models"
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
  modelSource: OperatorModels.Source,
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
  modelSource: OperatorModels.Source,
  trace: Schema.Array(OperatorProfile.TraceStep).annotate({
    description: "How the text was resolved, down to the file it is in",
  }),
}).annotate({ identifier: "OperatorPromptSample" })

// External plugins: they run after the prompt profile's and can change any prompt.
export const Plugins = Schema.Struct({
  plugins: Schema.Array(
    Schema.Struct({
      spec: Schema.String.annotate({ description: "The plugin as config names it" }),
      source: Schema.String.annotate({ description: "The config file that loads it" }),
    }),
  ),
}).annotate({ identifier: "OperatorPromptPlugins" })
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
    /** An override to preview instead of the agent's saved one (unsaved edits); null for none. */
    override?: OperatorProfile.Override | null
  }) => Effect.Effect<Preview, NotFoundError>
  /** What one layer fills in for an agent of this project: a Dynamic layer's sample. */
  readonly sample: (input: {
    agent: string
    layer: string
    providerID?: string
    modelID?: string
  }) => Effect.Effect<Sample, NotFoundError | OperatorGenerate.GenerateError>
  /** External plugins that config loads; they can change prompts after the profile. */
  readonly plugins: () => Effect.Effect<typeof Plugins.Type>
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
    const operatorAgents = yield* OperatorAgents.Service
    const operatorConfig = yield* OperatorConfig.Service
    const models = yield* OperatorModels.Service
    const config = yield* Config.Service

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
      // The model chosen for the preview, else the one the agent's requests use (the agent's own, else
      // the default; the small model for title), with where it is set.
      const file = (yield* operatorAgents.list()).find((item) => item.name === agent.name)?.source.path
      const modelSource: OperatorModels.Source =
        input.providerID && input.modelID
          ? { model: `${input.providerID}/${input.modelID}`, source: "chosen" }
          : yield* models.resolve(agent, file)
      if (!modelSource.model) return yield* new NotFoundError({ message: "No model is available" })
      const ref = Provider.parseModel(modelSource.model)
      const model = yield* provider
        .getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID))
        .pipe(Effect.mapError(() => new NotFoundError({ message: `No model ${modelSource.model}` })))
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
      return { ctx, agent, model, modelSource, key, loaded, parts }
    })

    // Completes a trace with what needs reading: where an agent's prompt is defined (its agent file or a
    // config file), the config files with references, and the files of the namespace's layers and purpose.
    const complete = Effect.fnUntraced(function* (
      trace: ReadonlyArray<OperatorProfile.TraceStep>,
      ns: string,
      agent: { name: string; prompt?: string },
    ) {
      const steps: OperatorProfile.TraceStep[] = []
      for (const step of trace) {
        steps.push(step)
        if (step.kind === "agent-own") {
          const found = yield* operatorAgents.promptOrigin(agent.name)
          if (found.kind === "file" && found.path) steps.push({ kind: "agent-file", path: found.path })
          if (found.kind === "config" && found.path)
            steps.push({ kind: "agent-config", name: agent.name, path: found.path })
          // A built-in agent's own prompt (explore's): OpenCode's definition, and the file the text is in.
          if (found.kind === "builtin") {
            steps.push({ kind: "agent-builtin", name: agent.name, path: OperatorPromptText.AGENT_DEFINITIONS })
            const file = OperatorPromptText.AGENT_PROMPTS.find(
              (item) => item.name === agent.name && item.text.trim() === agent.prompt?.trim(),
            )?.file
            if (file) steps.push({ kind: "file", path: file })
          }
        }
        if (step.kind === "references")
          for (const source of (yield* operatorConfig.layers()).sources) {
            const value = parse(source.text) as { references?: unknown; reference?: unknown } | undefined
            if (value?.references !== undefined || value?.reference !== undefined)
              steps.push({ kind: "config", path: source.path })
          }
        if ((step.kind === "copy-layer" || step.kind === "own-layer" || step.kind === "layer") && step.detail)
          steps.push({ kind: "file", path: OperatorProfileStore.itemFile(ns, "layer", step.detail) })
        if (step.kind === "org-purpose") steps.push({ kind: "file", path: OperatorProfileStore.namespaceFile(ns) })
      }
      return steps
    })

    const sample = Effect.fn("OperatorPrompts.sample")(function* (input: {
      agent: string
      layer: string
      providerID?: string
      modelID?: string
    }) {
      const { agent, model, modelSource, loaded, parts } = yield* request(input)
      const ns = loaded.catalog.namespace.id
      const head = { agent: agent.name, model: `${model.providerID}/${model.id}`, layer: input.layer, modelSource }
      // Your Dynamic layers are written by the dynamic generator, here without a session.
      const own = OperatorProfile.findLayer(loaded.catalog, input.layer)
      if (own && OperatorProfile.isWrittenDynamic(own)) {
        const text = yield* helpers.sample(own)
        const trace = yield* complete(
          [
            { kind: "dynamic-written", name: own.name },
            { kind: "layer", name: own.name, detail: own.id },
          ],
          ns,
          agent,
        )
        return { ...head, text, source: own.name, trace }
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
      return { ...head, text: found.text, source: found.source, trace: yield* complete(found.trace, ns, agent) }
    })

    const preview = Effect.fn("OperatorPrompts.preview")(function* (input: {
      agent: string
      providerID?: string
      modelID?: string
      profile?: string
      override?: OperatorProfile.Override | null
    }) {
      const { ctx, agent, model, modelSource, key, loaded, parts } = yield* request(input)
      if (input.profile && !OperatorProfile.profiles(loaded.catalog).some((item) => item.id === input.profile))
        return yield* new NotFoundError({
          message: `No profile "${input.profile}" in ${loaded.catalog.namespace.name}`,
        })
      const result = OperatorProfile.assemble({
        catalog: loaded.catalog,
        project: loaded.project,
        agent: { name: agent.name, prompt: agent.prompt },
        // Unsaved override edits are previewed in place of the saved override.
        setting:
          input.override === undefined
            ? loaded.agents[agent.name]
            : { ...loaded.agents[agent.name], override: input.override ?? undefined },
        profile: input.profile,
        model,
        parts,
        dynamic: written(loaded.catalog),
      })
      const ns = loaded.catalog.namespace.id
      const sections = yield* Effect.forEach(result.sections, (section) =>
        complete(section.trace, ns, agent).pipe(Effect.map((trace) => ({ ...section, trace }))),
      )
      return {
        agent: agent.name,
        model: `${model.providerID}/${model.id}`,
        base: OperatorPromptText.baseFor(model).id,
        namespace: { id: loaded.catalog.namespace.id, name: loaded.catalog.namespace.name },
        project: { key, name: ctx.project.name ?? path.basename(key) },
        profile: result.profile,
        group: result.group,
        override: result.changed,
        modelSource,
        sections,
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

    const plugins = Effect.fn("OperatorPrompts.plugins")(function* () {
      const origins = (yield* config.get()).plugin_origins ?? []
      return {
        plugins: origins.map((origin) => ({ spec: ConfigPlugin.pluginSpecifier(origin.spec), source: origin.source })),
      }
    })

    return Service.of({ catalog, preview, sample, purpose, plugins })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Provider.node,
    SystemPrompt.node,
    Instruction.node,
    ToolRegistry.node,
    OperatorHelperTexts.node,
    OperatorAgents.node,
    OperatorConfig.node,
    OperatorModels.node,
    Config.node,
  ],
})
