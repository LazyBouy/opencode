import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MergeAdapterRegistry } from "../../src/merge/adapter/registry"

describe("merge adapter registry", () => {
  test("lists every adapter with its display name and transports", async () => {
    const adapters = await Effect.runPromise(
      MergeAdapterRegistry.Service.use((registry) => Effect.succeed(registry.list())).pipe(
        Effect.provide(LayerNode.compile(MergeAdapterRegistry.node)),
      ),
    )
    expect(adapters.map((adapter) => [adapter.id, adapter.name, adapter.transports])).toEqual([
      ["claude", "Claude Code", ["cli"]],
    ])
  })

  test("adapters are on unless config turns them off", () => {
    expect(MergeAdapterRegistry.enabled({}, "claude")).toBe(true)
    expect(MergeAdapterRegistry.enabled({ merge: { adapters: { claude: { enabled: true } } } }, "claude")).toBe(true)
    expect(MergeAdapterRegistry.enabled({ merge: { adapters: { claude: { enabled: false } } } }, "claude")).toBe(false)
    expect(MergeAdapterRegistry.enabled({ merge: { adapters: { other: { enabled: false } } } }, "claude")).toBe(true)
  })
})
