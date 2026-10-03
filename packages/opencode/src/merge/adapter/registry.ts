import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Context, Effect, Layer } from "effect"
import type { MergeAdapter } from "./adapter"
import { ClaudeCli } from "./claude/cli"

export interface Interface {
  readonly get: (id: string) => MergeAdapter.Adapter | undefined
  readonly ids: () => ReadonlyArray<string>
  readonly list: () => ReadonlyArray<MergeAdapter.Adapter>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MergeAdapterRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // New adapters are added to this list; each one shows up in Settings → Adapters and in `/merge`.
    const adapters = new Map([yield* ClaudeCli.make].map((adapter) => [adapter.id, adapter]))
    return Service.of({
      get: (id) => adapters.get(id),
      ids: () => [...adapters.keys()],
      list: () => [...adapters.values()],
    })
  }),
)

// Adapters are on unless config turns them off (`merge.adapters.<id>.enabled: false`).
export function enabled(config: ConfigV1.Info, id: string) {
  return config.merge?.adapters?.[id]?.enabled !== false
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node, FSUtil.node] })

export * as MergeAdapterRegistry from "./registry"
