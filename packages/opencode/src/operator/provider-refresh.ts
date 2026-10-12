export * as OperatorProviderRefresh from "./provider-refresh"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schedule, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorReloadWhenIdle } from "./reload-when-idle"

// Providers connected or disconnected show everywhere at once (specs/docs/issues/001). A project's instance builds its
// provider list once (upstream's provider.ts), so a key added later (Settings → Providers, `opencode auth`, the TUI)
// showed only after the instance reloaded: Settings' disconnect reloads every project, connecting didn't. Here a change
// to the credentials file (auth.json; checked every second, and at once on `integration.connection.updated`) reloads
// every loaded project when none of its sessions is running (reload-when-idle.ts); the pages refetch their provider
// lists when a project reloads (`server.instance.disposed`). A project still running waits, and is listed as waiting.

export interface Interface {
  /** Projects whose provider list waits for their sessions to end before it reloads. */
  readonly waiting: () => Effect.Effect<ReadonlyArray<string>>
  /** Checks the credentials file now; reloads the projects when it changed. */
  readonly check: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorProviderRefresh") {}

const file = () => path.join(Global.Path.data, "auth.json")
const stampOf = () =>
  fs
    .stat(file(), { bigint: true })
    .then((stat) => `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`)
    .catch(() => "none")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reloads = yield* OperatorReloadWhenIdle.Service
    const scope = yield* Scope.Scope
    const bridge = yield* EffectBridge.make()
    const waiting = new Set<string>()
    let stamp = yield* Effect.promise(stampOf)

    const check = Effect.fn("OperatorProviderRefresh.check")(function* () {
      const now = yield* Effect.promise(stampOf)
      if (now === stamp) return
      stamp = now
      for (const directory of OperatorNamespaceScope.loadedInstances()) {
        const when = yield* reloads.want({ directory })
        if (when === "when-idle") waiting.add(directory)
        else waiting.delete(directory)
      }
    })

    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string } | undefined
      if (payload?.type === "integration.connection.updated") bridge.fork(check().pipe(Effect.ignore))
      else if (payload?.type === "server.instance.disposed" && event.directory) waiting.delete(event.directory)
      else if (payload?.type === "global.disposed") waiting.clear()
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )
    yield* check().pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    return Service.of({ waiting: () => Effect.sync(() => [...waiting]), check })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [OperatorReloadWhenIdle.node] })
