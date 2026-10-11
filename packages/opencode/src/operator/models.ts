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
import { Flag } from "@opencode-ai/core/flag/flag"
import { OperatorConfig } from "./config"
import { OperatorFileCache } from "./file-cache"
import { OperatorLayout } from "./layout"
import { OperatorNamespaceScope } from "./namespace-scope"
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

// The chain (default_models_spec.md §3): each level sets the default (or small) model or inherits it from
// the level above. Settings is Global's config; the namespace's config; the project's own config; and the
// environment (OPENCODE_CONFIG merges before the project, OPENCODE_CONFIG_DIR and OPENCODE_CONFIG_CONTENT
// after it). When no level sets one, OpenCode decides (§3.1).
export const Level = Schema.Literals(["settings", "namespace", "project", "environment"]).annotate({
  identifier: "OperatorModelLevel",
})
export type Level = typeof Level.Type
export const Variable = Schema.Literals(["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"])
export type Variable = typeof Variable.Type

export const Link = Schema.Struct({
  level: Level,
  set: Schema.Boolean.annotate({ description: "This level sets it" }),
  model: Schema.optional(Schema.String).annotate({ description: "provider/model, when set" }),
  path: Schema.String.annotate({
    description:
      "The file that sets it, else the file a write at this level goes to; for OPENCODE_CONFIG_CONTENT, the variable's name",
  }),
  variable: Schema.optional(Variable).annotate({ description: "environment: the variable" }),
  overriddenBy: Schema.optional(Variable).annotate({
    description: "Set here, but the environment sets it after this level: the variable that does",
  }),
}).annotate({ identifier: "OperatorModelLink" })
export type Link = typeof Link.Type

export const Effective = Schema.Struct({
  model: Schema.String.annotate({ description: "provider/model; empty when no model is available" }),
  from: Schema.Literals(["settings", "namespace", "project", "environment", "opencode"]).annotate({
    description: "The level that sets it, or opencode: no level does, OpenCode decides",
  }),
  variable: Schema.optional(Variable),
  rule: Schema.optional(Schema.Literals(["recent", "ranking", "small-family", "default-model", "none"])).annotate({
    description:
      "How OpenCode decided: the TUI's recent models, its built-in ranking, a small model of the default model's provider, the default model itself (no small one found), or no model available",
  }),
  unavailable: Schema.optional(Schema.Boolean).annotate({
    description: "Set, but not offered by the connected providers",
  }),
}).annotate({ identifier: "OperatorModelEffective" })
export type Effective = typeof Effective.Type

export const Chain = Schema.Struct({
  levels: Schema.Array(Link).annotate({
    description:
      "settings, namespace (not for Global's projects: its config is Settings), project, and each environment variable that sets it, in the order they apply",
  }),
  effective: Effective,
}).annotate({ identifier: "OperatorModelChain" })
export type Chain = typeof Chain.Type

export const Chains = Schema.Struct({ model: Chain, small: Chain }).annotate({ identifier: "OperatorModelChains" })
export type Chains = typeof Chains.Type

/** A config source as the chain sees it. */
export type Layered = { level: Level; path: string; text: string; variable?: Variable }

export const levelOf = (kind: "global" | "namespace" | "project" | "directory" | "env"): Level =>
  kind === "global" ? "settings" : kind === "env" ? "environment" : kind === "directory" ? "project" : kind

const valueIn = (text: string, key: "model" | "small_model") => {
  const value = parse(text) as Record<string, unknown> | undefined
  return value && typeof value === "object" && typeof value[key] === "string" ? (value[key] as string) : undefined
}

/**
 * One key's levels, from the sources in load order: per level the last source that sets it; each environment
 * variable that sets it is a level of its own, where it applies. `targets` are the files a write at each level
 * goes to (no namespace: a Global project's, or Settings alone; no project: a namespace's own chain).
 */
export function linksOf(
  sources: ReadonlyArray<Layered>,
  key: "model" | "small_model",
  targets: { settings: string; namespace?: string; project?: string },
) {
  const setters = sources.flatMap((source, index) => {
    const model = valueIn(source.text, key)
    return model === undefined ? [] : [{ ...source, model, index }]
  })
  const last = setters.at(-1)
  const lastOf = (match: (source: Layered) => boolean) => setters.filter(match).at(-1)
  const link = (level: Level, found: (typeof setters)[number] | undefined, target: string): Link => ({
    level,
    set: found !== undefined,
    ...(found ? { model: found.model } : {}),
    path: found?.path ?? target,
    ...(found?.variable ? { variable: found.variable } : {}),
    ...(found && last && last !== found && last.level === "environment" && last.variable
      ? { overriddenBy: last.variable }
      : {}),
  })
  const env = (variable: Variable) => {
    const found = lastOf((source) => source.variable === variable)
    return found ? [link("environment", found, found.path)] : []
  }
  const levels: Link[] = [
    link(
      "settings",
      lastOf((source) => source.level === "settings"),
      targets.settings,
    ),
    ...(targets.namespace !== undefined
      ? [
          link(
            "namespace",
            lastOf((source) => source.level === "namespace"),
            targets.namespace,
          ),
        ]
      : []),
    ...env("OPENCODE_CONFIG"),
    ...(targets.project !== undefined
      ? [
          link(
            "project",
            lastOf((source) => source.level === "project"),
            targets.project,
          ),
        ]
      : []),
    ...env("OPENCODE_CONFIG_DIR"),
    ...env("OPENCODE_CONFIG_CONTENT"),
  ]
  return { levels, last }
}

const readText = (file: string) => OperatorFileCache.text(file)

// The environment's config sources, in the order the loader applies them (§3.2).
async function environmentSources(): Promise<Layered[]> {
  const found: Layered[] = []
  if (Flag.OPENCODE_CONFIG) {
    const text = await readText(Flag.OPENCODE_CONFIG)
    if (text !== undefined)
      found.push({ level: "environment", path: Flag.OPENCODE_CONFIG, text, variable: "OPENCODE_CONFIG" })
  }
  if (Flag.OPENCODE_CONFIG_DIR)
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(Flag.OPENCODE_CONFIG_DIR, name)
      const text = await readText(file)
      if (text !== undefined) found.push({ level: "environment", path: file, text, variable: "OPENCODE_CONFIG_DIR" })
    }
  if (Flag.OPENCODE_CONFIG_CONTENT)
    found.push({
      level: "environment",
      path: "OPENCODE_CONFIG_CONTENT",
      text: Flag.OPENCODE_CONFIG_CONTENT,
      variable: "OPENCODE_CONFIG_CONTENT",
    })
  return found
}

/**
 * A namespace's own chain, without a project (Providers & Models' first row, the namespace page): Settings,
 * the namespace's config and the environment. Without a namespace, or for Global (whose config is Settings):
 * Settings and the environment (Settings → Models).
 */
export async function namespaceSources(namespace?: string) {
  const settings: Layered[] = []
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const file = path.join(Global.Path.config, name)
    const text = await readText(file)
    if (text !== undefined) settings.push({ level: "settings", path: file, text })
  }
  const layer = namespace ? await OperatorNamespaceScope.namespaceLayer(namespace) : undefined
  const own = layer && !layer.global && layer.target ? layer.target : undefined
  const ns: Layered[] = []
  let target: string | undefined
  if (own) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(own, name)
      const text = await readText(file)
      if (text !== undefined) ns.push({ level: "namespace", path: file, text })
    }
    // A write goes to the namespace's existing file (opencode.jsonc first), else a new opencode.jsonc.
    target =
      ns.find((source) => source.path.endsWith("opencode.jsonc"))?.path ??
      ns[0]?.path ??
      path.join(own, "opencode.jsonc")
  }
  return {
    namespace: layer?.namespace,
    /** Its config is Settings: no namespace, Global, or "Global · OpenCode". */
    settings: !own,
    sources: [...settings, ...ns, ...(await environmentSources())],
    targets: { settings: await OperatorLayout.globalConfigFile(), ...(target ? { namespace: target } : {}) },
  }
}

/** What a project's own config files set for the default and small model (the last file that sets each). */
export async function projectModels(project: string) {
  const value: { model?: string; small_model?: string } = {}
  const files: { model?: string; small_model?: string } = {}
  for (const file of await OperatorNamespaceScope.ownConfigFiles(project, OperatorNamespaceScope.MERGE_ORDER)) {
    const text = await readText(file)
    if (text === undefined) continue
    for (const key of OperatorNamespaceScope.MODEL_KEYS) {
      const found = valueIn(text, key)
      if (found !== undefined) {
        value[key] = found
        files[key] = file
      }
    }
  }
  return { value, files }
}

export const Defaults = Schema.Struct({
  model: Source,
  small: Source,
  global: Schema.Struct({
    model: Schema.optional(Schema.String),
    small: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String).annotate({ description: "The global config file" }),
  }).annotate({ description: "What the global config sets for every project (`model`, `small_model`)" }),
  chain: Chains.annotate({
    description: "Where the default and small model come from: Settings, the namespace, the project, the environment",
  }),
}).annotate({
  identifier: "OperatorModelDefaults",
})
export type Defaults = typeof Defaults.Type

export interface Interface {
  /** The default model and the small model, with where each comes from. */
  readonly defaults: () => Effect.Effect<Defaults>
  /**
   * The chains of the default and small model for these sources (in an instance, for what OpenCode decides
   * and what the connected providers offer).
   */
  readonly chains: (
    sources: ReadonlyArray<Layered>,
    targets: { settings: string; namespace?: string; project?: string },
  ) => Effect.Effect<Chains>
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

    // What OpenCode picks when no level sets the default model (§3.1): Provider.defaultModel without the
    // config's `model`: the TUI's recent models, else the first connected provider's best by its ranking.
    const decides = Effect.fnUntraced(function* () {
      const providers = yield* provider.list().pipe(Effect.catch(() => Effect.succeed({} as Record<string, never>)))
      const { entries } = yield* recent()
      const offered = providers as Record<string, { id: string; models: Record<string, { id: string }> }>
      for (const entry of entries)
        if (offered[entry.providerID]?.models[entry.modelID]) return { model: id(entry), rule: "recent" as const }
      const configured = Object.keys((yield* config.get()).provider ?? {})
      const first = Object.values(offered).find((item) => configured.length === 0 || configured.includes(item.id))
      const [best] = first ? Provider.sort(Object.values(first.models)) : []
      return first && best
        ? { model: `${first.id}/${best.id}`, rule: "ranking" as const }
        : { model: "", rule: "none" as const }
    })

    const effective = Effect.fnUntraced(function* (found: ReturnType<typeof linksOf>["last"]) {
      if (!found) return undefined
      return {
        model: found.model,
        from: found.level,
        ...(found.variable ? { variable: found.variable } : {}),
        ...((yield* available(Provider.parseModel(found.model))) ? {} : { unavailable: true }),
      } satisfies Effective
    })

    const chains = Effect.fn("OperatorModels.chains")(function* (
      sources: ReadonlyArray<Layered>,
      targets: { settings: string; namespace?: string; project?: string },
    ) {
      const model = linksOf(sources, "model", targets)
      const small = linksOf(sources, "small_model", targets)
      const picked = yield* decides()
      const modelEffective: Effective = (yield* effective(model.last)) ?? {
        model: picked.model,
        from: "opencode",
        rule: picked.rule,
      }
      // The small model OpenCode picks: a small one of the default model's provider, else the default model.
      const smallFound = small.last
        ? undefined
        : modelEffective.model
          ? yield* provider
              .getSmallModel(ProviderV2.ID.make(modelEffective.model.split("/")[0]!))
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
      const smallPicked: Effective = !modelEffective.model
        ? { model: "", from: "opencode", rule: "none" }
        : smallFound
          ? { model: `${smallFound.providerID}/${smallFound.id}`, from: "opencode", rule: "small-family" }
          : { model: modelEffective.model, from: "opencode", rule: "default-model" }
      return {
        model: { levels: model.levels, effective: modelEffective },
        small: { levels: small.levels, effective: (yield* effective(small.last)) ?? smallPicked },
      }
    })

    // The chain for the instance's project: its config sources as OperatorConfig reads them.
    const projectChains = Effect.fnUntraced(function* () {
      const layers = yield* operatorConfig.layers()
      const global = (yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(layers.namespace))).global
      return yield* chains(
        layers.sources.map((source) => ({
          level: levelOf(source.kind),
          path: source.path,
          text: source.text,
          ...(source.variable ? { variable: source.variable } : {}),
        })),
        {
          settings: layers.targets.global,
          ...(!global && layers.targets.namespace ? { namespace: layers.targets.namespace } : {}),
          project: layers.targets.project,
        },
      )
    })

    const defaults = Effect.fn("OperatorModels.defaults")(function* () {
      const chosen = yield* model()
      const ctx = yield* InstanceState.context
      const layout = yield* Effect.promise(() => OperatorScopes.layout([OperatorConfig.projectRoot(ctx)]))
      return {
        model: how(chosen, layout),
        small: how(yield* small(chosen), layout),
        global: yield* global(),
        chain: yield* projectChains(),
      }
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

    return Service.of({ defaults, chains, resolve })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Provider.node, Config.node, OperatorConfig.node],
})
