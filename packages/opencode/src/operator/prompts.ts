export * as OperatorPrompts from "./prompts"

import fs from "fs/promises"
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
import type { OperatorConfig } from "./config"
import { OperatorIdentity } from "./identity"
import { OperatorPromptText } from "./prompt-text"

export const Entry = Schema.Struct({
  id: Schema.String,
  kind: OperatorPromptText.Kind,
  builtin: Schema.String.annotate({ description: "OpenCode's own text" }),
  global: Schema.optional(Schema.String).annotate({ description: "The global override, when there is one" }),
  project: Schema.optional(Schema.String).annotate({ description: "The project override, when there is one" }),
}).annotate({ identifier: "OperatorPrompt" })
export type Entry = typeof Entry.Type

export const ToolEntry = Schema.Struct({
  id: Schema.String,
  builtin: Schema.String,
  global: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorPromptTool" })

export const Catalog = Schema.Struct({
  prompts: Schema.Array(Entry),
  tools: Schema.Array(ToolEntry),
  toggles: OperatorPromptText.Toggles,
  folders: Schema.Struct({ global: Schema.String, project: Schema.String }),
}).annotate({ identifier: "OperatorPromptCatalog" })

export const PreviewSection = Schema.Struct({
  kind: Schema.Literals(["identity", "agent", "base", "environment", "references", "instructions", "mcp", "skills"]),
  source: Schema.String.annotate({ description: "Where the text comes from: an override id, file path or agent" }),
  text: Schema.String,
}).annotate({ identifier: "OperatorPromptSection" })

export const Preview = Schema.Struct({
  agent: Schema.String,
  model: Schema.String.annotate({ description: "provider/model the preview was built for" }),
  base: Schema.String.annotate({ description: "The base prompt id used for this model" }),
  sections: Schema.Array(PreviewSection),
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
  /** Writes an override; an empty text turns the prompt off. */
  readonly write: (scope: OperatorConfig.Scope, id: string, text: string) => Effect.Effect<void, NotFoundError>
  readonly remove: (scope: OperatorConfig.Scope, id: string) => Effect.Effect<void>
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

    const known = Effect.fnUntraced(function* (id: string) {
      if (OperatorPromptText.BUILTINS.some((item) => item.id === id)) return true
      if (!id.startsWith("tool.")) return false
      return (yield* registry.ids()).includes(id.slice("tool.".length))
    })

    const catalog = Effect.fn("OperatorPrompts.catalog")(function* () {
      const ctx = yield* InstanceState.context
      const folders = OperatorPromptText.promptFolders(ctx)
      const read = (scope: OperatorConfig.Scope) =>
        Effect.promise(async () => {
          const names = await fs.readdir(folders[scope]).catch(() => [] as string[])
          const entries = await Promise.all(
            names
              .filter((name) => name.endsWith(".md"))
              .map(
                async (name) =>
                  [name.slice(0, -3), (await fs.readFile(path.join(folders[scope], name), "utf8")).trim()] as const,
              ),
          )
          return new Map(entries)
        })
      const global = yield* read("global")
      const project = folders.project === folders.global ? new Map<string, string>() : yield* read("project")
      const scoped = (id: string) => ({
        ...(global.has(id) ? { global: global.get(id) } : {}),
        ...(project.has(id) ? { project: project.get(id) } : {}),
      })
      const tools = (yield* registry.all()).filter((tool) => tool.id !== "invalid")
      return {
        prompts: OperatorPromptText.BUILTINS.map((item) => ({
          id: item.id,
          kind: item.kind,
          builtin: item.text,
          ...scoped(item.id),
        })),
        tools: tools.map((tool) => ({ id: tool.id, builtin: tool.description, ...scoped(`tool.${tool.id}`) })),
        toggles: OperatorPromptText.toggles(yield* config.get()),
        folders,
      }
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
      const overrides = yield* Effect.promise(() => OperatorPromptText.readOverrides(ctx))
      const switches = OperatorPromptText.toggles(yield* config.get())
      const [env, files, mcp, skills, identity] = yield* Effect.all([
        system.environment(model),
        instruction.system().pipe(Effect.orDie),
        system.mcp(agent),
        system.skills(agent),
        Effect.promise(() => OperatorIdentity.readLayers(OperatorIdentity.folders(ctx))),
      ])
      const entry = OperatorPromptText.baseFor(model)
      const head = agent.prompt
        ? [{ kind: "agent" as const, source: agent.name, text: agent.prompt }]
        : [
            {
              kind: "base" as const,
              source: overrides.has(entry.id) ? entry.id : overrides.has("base") ? "base" : entry.id,
              text: OperatorPromptText.baseText(model, overrides),
            },
          ]
      const identityText = OperatorIdentity.render(identity, agent.name)
      const sections = [
        ...(identityText ? [{ kind: "identity" as const, source: "identity", text: identityText }] : []),
        ...head.filter((item) => item.text),
        ...(switches.environment
          ? env.map((item, index) => ({
              kind: index === 0 ? ("environment" as const) : ("references" as const),
              source: "generated",
              text: item,
            }))
          : []),
        ...files.map((item) => ({
          kind: "instructions" as const,
          source: item.match(/^Instructions from: ([^\n]*)/)?.[1] ?? "instructions",
          text: item,
        })),
        ...(mcp && switches.mcp ? [{ kind: "mcp" as const, source: "generated", text: mcp }] : []),
        ...(skills && switches.skills ? [{ kind: "skills" as const, source: "generated", text: skills }] : []),
      ]
      // The same shape request preparation sends: identity first, then everything else joined.
      const rest = sections
        .filter((item) => item.kind !== "identity")
        .map((item) => item.text)
        .join("\n")
      return {
        agent: agent.name,
        model: `${model.providerID}/${model.id}`,
        base: entry.id,
        sections,
        system: [...(identityText ? [identityText] : []), ...(rest ? [rest] : [])],
      }
    })

    const write = Effect.fn("OperatorPrompts.write")(function* (
      scope: OperatorConfig.Scope,
      id: string,
      value: string,
    ) {
      if (!(yield* known(id))) return yield* new NotFoundError({ message: `No prompt "${id}"` })
      const file = path.join(OperatorPromptText.promptFolders(yield* InstanceState.context)[scope], `${id}.md`)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, value.trim() ? `${value.trim()}\n` : "")
      })
    })

    const remove = Effect.fn("OperatorPrompts.remove")(function* (scope: OperatorConfig.Scope, id: string) {
      const file = path.join(
        OperatorPromptText.promptFolders(yield* InstanceState.context)[scope],
        `${path.basename(id)}.md`,
      )
      yield* Effect.promise(() => fs.rm(file, { force: true }))
    })

    return Service.of({ catalog, preview, write, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Provider.node, SystemPrompt.node, Instruction.node, ToolRegistry.node, Config.node],
})
