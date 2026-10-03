export * as OperatorTools from "./tools"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Glob } from "@opencode-ai/core/util/glob"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"

export const Info = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  origin: Schema.Literals(["builtin", "custom", "plugin", "mcp"]),
  source: Schema.optional(Schema.String).annotate({
    description: "The custom tool's file, or the MCP server the tool comes from",
  }),
}).annotate({ identifier: "OperatorTool" })
export type Info = typeof Info.Type

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorTools") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const plugin = yield* Plugin.Service
    const mcp = yield* MCP.Service
    const config = yield* Config.Service

    const list = Effect.fn("OperatorTools.list")(function* () {
      // Custom tool files are named `<file>` or `<file>_<export>`, as ToolRegistry registers them.
      const files = (yield* Effect.forEach(yield* config.directories(), (dir) =>
        Effect.promise(() => Glob.scan("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true })),
      )).flat()
      const fileFor = (id: string) =>
        files.find((file) => {
          const namespace = path.basename(file, path.extname(file))
          return id === namespace || id.startsWith(`${namespace}_`)
        })
      const pluginTools = new Set((yield* plugin.list()).flatMap((hooks) => Object.keys(hooks.tool ?? {})))
      const registered = (yield* registry.all())
        .filter((tool) => tool.id !== "invalid")
        .map((tool) => {
          const file = fileFor(tool.id)
          return {
            id: tool.id,
            description: tool.description,
            origin: file ? ("custom" as const) : pluginTools.has(tool.id) ? ("plugin" as const) : ("builtin" as const),
            source: file,
          }
        })
      const clients = Object.entries(yield* mcp.clients())
      const remote = Object.entries(yield* mcp.tools()).map(([id, tool]) => ({
        id,
        description: tool.def.description ?? "",
        origin: "mcp" as const,
        source: clients.find(([, client]) => client === tool.client)?.[0],
      }))
      return [...registered, ...remote]
    })

    return Service.of({ list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ToolRegistry.node, Plugin.node, MCP.node, Config.node],
})
