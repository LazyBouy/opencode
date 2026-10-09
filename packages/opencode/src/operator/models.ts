export * as OperatorModels from "./models"

import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "./config"
import { OperatorScopes } from "./scopes"

// Which model an agent's requests use, and where that choice comes from, mirroring OpenCode:
// the agent's own `model` (config or its agent file), else the default model (Provider.defaultModel:
// config `model`, else the TUI's recent models, else the first connected provider's first model by
// OpenCode's built-in ranking). The title agent uses the small model (config `small_model`, else a
// model of a small family of the default model's provider). In chat, a session can pick another model.

export const Source = Schema.Struct({
  model: Schema.String.annotate({ description: "provider/model; empty when no model is available" }),
  source: Schema.Literals([
    "agent",
    "default",
    "recent",
    "ranking",
    "small",
    "small-family",
    "none",
    "chosen",
  ]).annotate({
    description:
      "chosen: picked for this preview; agent: the agent's own model; default: config `model`; recent: the TUI's recent models; ranking: OpenCode's own choice (first connected provider, built-in ranking); small: config `small_model`; small-family: OpenCode's small-model search; none: no model available",
  }),
  path: Schema.optional(Schema.String).annotate({ description: "The file the model is set in" }),
  how: Schema.optional(Schema.Literals(["project", "namespace", "global", "environment", "default"])).annotate({
    description:
      "The default and small model: set in this project's config, in its namespace's config, in Global's config, by the environment (OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_CONTENT), or not set (Default: OpenCode decides)",
  }),
  unavailable: Schema.optional(Schema.Boolean).annotate({
    description: "Set in config but not offered by the connected providers",
  }),
  agent: Schema.optional(
    Schema.Struct({ model: Schema.String, path: Schema.optional(Schema.String) }).annotate({
      identifier: "OperatorAgentModel",
    }),
  ).annotate({ description: "The agent's own model, when it is not available here (the default is used)" }),
}).annotate({ identifier: "OperatorModelSource" })
export type Source = typeof Source.Type

export const Defaults = Schema.Struct({
  model: Source,
  small: Source,
  global: Schema.Struct({
    model: Schema.optional(Schema.String),
    small: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String).annotate({ description: "The global config file" }),
  }).annotate({ description: "What the global config sets for every project (`model`, `small_model`)" }),
}).annotate({
  identifier: "OperatorModelDefaults",
})
export type Defaults = typeof Defaults.Type

export interface Interface {
  /** The default model and the small model, with where each comes from. */
  readonly defaults: () => Effect.Effect<Defaults>
  /** The model an agent's requests use, with where it comes from; `file` is its agent file, if any. */
  readonly resolve: (agent: Agent.Info, file?: string) => Effect.Effect<Source>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorModels") {}

const id = (ref: { providerID: string; modelID: string }) => `${ref.providerID}/${ref.modelID}`
const source = (value: Source) => value

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const operatorConfig = yield* OperatorConfig.Service

    const available = (ref: { providerID: string; modelID: string }) =>
      provider.getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )

    // The last config file that sets a key (`model`, `small_model`), or an agent's key.
    const setIn = Effect.fnUntraced(function* (pick: (value: Record<string, unknown>) => unknown) {
      return (yield* operatorConfig.layers()).sources.findLast((source) => {
        const value = parse(source.text) as Record<string, unknown> | undefined
        return value !== undefined && typeof value === "object" && pick(value) !== undefined
      })?.path
    })

    // The TUI's recent models (Provider.defaultModel reads the same file).
    const recent = () =>
      Effect.promise(async () => {
        const file = path.join(Global.Path.state, "model.json")
        const data = (await Bun.file(file)
          .json()
          .catch(() => undefined)) as { recent?: Array<{ providerID?: unknown; modelID?: unknown }> } | undefined
        return {
          file,
          entries: (data?.recent ?? []).flatMap((item) =>
            typeof item.providerID === "string" && typeof item.modelID === "string"
              ? [{ providerID: item.providerID, modelID: item.modelID }]
              : [],
          ),
        }
      })

    const model = Effect.fnUntraced(function* () {
      const cfg = yield* config.get()
      if (cfg.model) {
        const ref = Provider.parseModel(cfg.model)
        return source({
          model: id(ref),
          source: "default",
          path: yield* setIn((value) => value.model),
          ...((yield* available(ref)) ? {} : { unavailable: true }),
        })
      }
      const chosen = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!chosen) return source({ model: "", source: "none" })
      const { file, entries } = yield* recent()
      for (const entry of entries)
        if (yield* available(entry))
          return source(
            id(entry) === id(chosen)
              ? { model: id(chosen), source: "recent", path: file }
              : { model: id(chosen), source: "ranking" },
          )
      return source({ model: id(chosen), source: "ranking" })
    })

    const small = Effect.fnUntraced(function* (fallback: Source) {
      const cfg = yield* config.get()
      if (cfg.small_model) {
        const ref = Provider.parseModel(cfg.small_model)
        return source({
          model: id(ref),
          source: "small",
          path: yield* setIn((value) => value.small_model),
          ...((yield* available(ref)) ? {} : { unavailable: true }),
        })
      }
      if (!fallback.model) return fallback
      const found = yield* provider.getSmallModel(ProviderV2.ID.make(fallback.model.split("/")[0]!))
      return found ? source({ model: `${found.providerID}/${found.id}`, source: "small-family" }) : fallback
    })

    // How a default was chosen: where the file that sets it belongs (scopes.ts), or not set (Default).
    const how = (value: Source, layout: OperatorScopes.Layout): Source => {
      if (value.source !== "default" && value.source !== "small") return { ...value, how: "default" }
      const scope = value.path ? OperatorScopes.classify(value.path, layout).kind : "project"
      return { ...value, how: scope === "outside" ? "project" : scope }
    }

    // What the global config file sets, for every project.
    const global = Effect.fnUntraced(function* () {
      const layers = yield* operatorConfig.layers()
      const file = layers.sources.findLast((source) => source.kind === "global")
      const value = file ? (parse(file.text) as { model?: unknown; small_model?: unknown } | undefined) : undefined
      return {
        ...(typeof value?.model === "string" ? { model: value.model } : {}),
        ...(typeof value?.small_model === "string" ? { small: value.small_model } : {}),
        path: file?.path ?? layers.targets.global,
      }
    })

    const defaults = Effect.fn("OperatorModels.defaults")(function* () {
      const chosen = yield* model()
      const ctx = yield* InstanceState.context
      const layout = yield* Effect.promise(() => OperatorScopes.layout([OperatorConfig.projectRoot(ctx)]))
      return { model: how(chosen, layout), small: how(yield* small(chosen), layout), global: yield* global() }
    })

    // Where an agent's own model is set: its agent file's frontmatter, else the last config file with
    // `agent.<name>.model`.
    const agentPath = Effect.fnUntraced(function* (agent: Agent.Info, file?: string) {
      if (file) {
        const data = yield* Effect.promise(() =>
          fs
            .readFile(file, "utf8")
            .then((text) => matter(text).data as Record<string, unknown>)
            .catch(() => ({}) as Record<string, unknown>),
        )
        if (data.model !== undefined) return file
      }
      return yield* setIn(
        (value) => (value.agent as Record<string, { model?: unknown }> | undefined)?.[agent.name]?.model,
      )
    })

    const resolve = Effect.fn("OperatorModels.resolve")(function* (agent: Agent.Info, file?: string) {
      const own = agent.model ? { providerID: agent.model.providerID, modelID: agent.model.modelID } : undefined
      if (own) {
        const where = yield* agentPath(agent, file)
        if (yield* available(own)) return source({ model: id(own), source: "agent", ...(where ? { path: where } : {}) })
        const fallback = agent.name === "title" ? yield* small(yield* model()) : yield* model()
        return source({ ...fallback, agent: { model: id(own), ...(where ? { path: where } : {}) } })
      }
      // OpenCode's title agent runs on the small model.
      if (agent.name === "title") return yield* small(yield* model())
      return yield* model()
    })

    return Service.of({ defaults, resolve })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Provider.node, Config.node, OperatorConfig.node],
})
