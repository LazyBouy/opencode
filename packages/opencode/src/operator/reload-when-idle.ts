export * as OperatorReloadWhenIdle from "./reload-when-idle"

import { Context, Effect, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

// A project reloads to read a file just written (an agent's rules, its config), but only when none of
// its sessions is running: reloading a project stops the turns running in it. Until then what was
// written applies where the fork can apply it (permission-live.ts), and the reply says the reload
// waits. A global file feeds every project, so it waits until no session runs anywhere.

export type Reload = "now" | "when-idle"

export interface Interface {
  /** Reloads the project in `directory` (or every project) when none of its sessions is running. */
  readonly want: (target: { directory: string } | "global") => Effect.Effect<Reload>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorReloadWhenIdle") {}

const GLOBAL = "\u0000global"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    const bridge = yield* EffectBridge.make()
    // Sessions running now, with the project they run in; and the reloads waiting for them.
    const running = new Map<string, string>()
    const waiting = new Set<string>()

    const busy = (target: string) =>
      target === GLOBAL ? running.size > 0 : [...running.values()].some((directory) => directory === target)

    // After the reply that asked for it has gone out.
    const reload = (target: string) =>
      Effect.sleep("200 millis").pipe(
        Effect.andThen(
          target === GLOBAL
            ? config
                .invalidate()
                .pipe(
                  Effect.andThen(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })),
                  Effect.provideService(InstanceStore.Service, instances),
                )
            : instances.disposeDirectory(target),
        ),
        Effect.catchCause((cause) => Effect.logWarning("operator: reload failed", { cause })),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )

    const settle = () => {
      for (const target of [...waiting]) {
        if (busy(target)) continue
        waiting.delete(target)
        bridge.fork(reload(target))
      }
    }

    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as
        | { type?: string; properties?: { sessionID?: string; status?: { type?: string } } }
        | undefined
      const sessionID = payload?.properties?.sessionID
      if (payload?.type === "session.status" && sessionID && event.directory) {
        if (payload.properties?.status?.type === "idle") running.delete(sessionID)
        else running.set(sessionID, event.directory)
      } else if (payload?.type === "session.idle" && sessionID) running.delete(sessionID)
      else if (payload?.type === "server.instance.disposed" && event.directory) {
        for (const [id, directory] of running) if (directory === event.directory) running.delete(id)
      } else return
      if (waiting.size) settle()
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    const want = Effect.fn("OperatorReloadWhenIdle.want")(function* (target: { directory: string } | "global") {
      const key = target === "global" ? GLOBAL : target.directory
      if (busy(key)) {
        waiting.add(key)
        return "when-idle" as const
      }
      waiting.delete(key)
      yield* reload(key)
      return "now" as const
    })

    return Service.of({ want })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [InstanceStore.node, Config.node] })
