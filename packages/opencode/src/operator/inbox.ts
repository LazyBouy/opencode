export * as OperatorInbox from "./inbox"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

export const Pending = Schema.Struct({
  directory: Schema.String,
  time: Schema.Finite.annotate({ description: "When the request was raised" }),
  request: PermissionV1.Request,
}).annotate({ identifier: "OperatorPendingPermission" })
export type Pending = typeof Pending.Type

export interface Interface {
  /** Permission requests waiting for a reply in any project, oldest first. */
  readonly pending: () => ReadonlyArray<Pending>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorInbox") {}

// Permission state lives in each project instance, and the server cannot list its instances. Every
// instance publishes on the global bus, so following asked/replied/disposed events there gives one
// cross-project view without touching the permission service.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const requests = new Map<string, Pending>()

    const handle = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: Record<string, unknown> } | undefined
      if (payload?.type === "permission.asked" && event.directory) {
        const request = payload.properties as PermissionV1.Request
        requests.set(request.id, { directory: event.directory, time: Date.now(), request })
        return
      }
      if (payload?.type === "permission.replied") {
        requests.delete(String(payload.properties?.requestID))
        return
      }
      if (payload?.type === "server.instance.disposed")
        for (const [id, pending] of requests) if (pending.directory === event.directory) requests.delete(id)
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handle)),
      () => Effect.sync(() => GlobalBus.off("event", handle)),
    )

    return Service.of({
      pending: () => [...requests.values()].sort((a, b) => a.time - b.time),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
