import { Config } from "@/config/config"
import { Env } from "@/env"
import { MergeAdapterRegistry } from "@/merge/adapter/registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"

export const mergeHandlers = HttpApiBuilder.group(InstanceHttpApi, "merge", (handlers) =>
  Effect.gen(function* () {
    const registry = yield* MergeAdapterRegistry.Service
    const config = yield* Config.Service
    const env = yield* Env.Service

    const adapters = Effect.fn("MergeHttpApi.adapters")(function* () {
      const settings = yield* config.get()
      const environment = yield* env.all()
      return yield* Effect.forEach(
        registry.list(),
        (adapter) =>
          adapter.probe(environment).pipe(
            Effect.map((found) => ({ available: true, binary: found.binary, version: found.version })),
            Effect.catch((error) => Effect.succeed({ available: false, message: error.message })),
            Effect.map((probe) => ({
              id: adapter.id,
              name: adapter.name,
              transports: adapter.transports,
              enabled: MergeAdapterRegistry.enabled(settings, adapter.id),
              ...probe,
            })),
          ),
        { concurrency: "unbounded" },
      )
    })

    return handlers.handle("adapters", adapters)
  }),
)
