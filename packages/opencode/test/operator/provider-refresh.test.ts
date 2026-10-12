import { expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { OperatorProviderRefresh } from "@/operator/provider-refresh"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { replacements, root } from "../merge/harness"

// specs/docs/issues/001: a provider connected after a project's instance built its provider list shows in that
// project's list without a server restart: the credentials file changed, so the project reloads (it is idle).
// Removing the key takes it away the same way.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, Auth.node, OperatorProviderRefresh.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

unix("a project's provider list includes a provider right after its key is set, and loses it when removed", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const instances = yield* InstanceStore.Service
    const auth = yield* Auth.Service
    const refresh = yield* OperatorProviderRefresh.Service
    const provider = yield* Provider.Service
    // As the server reads it: through the project's instance.
    const ids = instances.provide({ directory }, provider.list().pipe(Effect.map(Object.keys)))
    const until = (wanted: (list: string[]) => boolean) =>
      ids.pipe(
        Effect.flatMap((list) => (wanted(list) ? Effect.succeed(list) : Effect.fail(list))),
        Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
        Effect.catch((list) => Effect.succeed(list)),
      )

    // The project's instance has built its list: no OpenRouter key yet.
    expect(yield* ids).not.toContain("openrouter")

    yield* auth.set("openrouter", new Auth.Api({ type: "api", key: "sk-or-test" }))
    yield* refresh.check()
    // The project reloads (none of its sessions runs): its list now has OpenRouter.
    expect(yield* until((list) => list.includes("openrouter"))).toContain("openrouter")
    expect(yield* refresh.waiting()).toEqual([])

    yield* auth.remove("openrouter")
    yield* refresh.check()
    expect(yield* until((list) => !list.includes("openrouter"))).not.toContain("openrouter")
  }),
)
