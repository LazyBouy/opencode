import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Layer } from "effect"
import type { MergeAdapter } from "./adapter"
import { ClaudeCli } from "./claude/cli"

export interface Interface {
  readonly get: (id: string) => MergeAdapter.Adapter | undefined
  readonly ids: () => ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MergeAdapterRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const adapters = new Map([yield* ClaudeCli.make].map((adapter) => [adapter.id, adapter]))
    return Service.of({
      get: (id) => adapters.get(id),
      ids: () => [...adapters.keys()],
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node, FSUtil.node] })

export * as MergeAdapterRegistry from "./registry"
