import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "@/operator/config"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { markInstanceForDisposal } from "@/server/routes/instance/httpapi/lifecycle"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiOperatorConfigInvalidError } from "../groups/config"

export const operatorConfigHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorConfig", (handlers) =>
  Effect.gen(function* () {
    const operatorConfig = yield* OperatorConfig.Service
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()

    // Global config feeds every project, so every instance reloads; a project write reloads this one.
    const apply = Effect.fnUntraced(function* (
      scope: OperatorConfig.Scope,
      write: Effect.Effect<typeof OperatorConfig.UpdateResult.Type, OperatorConfig.InvalidError>,
    ) {
      const result = yield* write.pipe(
        Effect.mapError(
          (error) =>
            new ApiOperatorConfigInvalidError({
              name: "OperatorConfigInvalidError",
              data: { path: error.path, message: error.message },
            }),
        ),
      )
      if (!result.changed) return result
      if (scope === "global") {
        yield* config.invalidate()
        bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
        return result
      }
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return result
    })

    return handlers
      .handle("layers", () => operatorConfig.layers())
      .handle("update", (ctx) => apply(ctx.query.scope, operatorConfig.update(ctx.query.scope, ctx.payload)))
      .handle("write", (ctx) => apply(ctx.query.scope, operatorConfig.write(ctx.query.scope, ctx.payload.text)))
      .handle("schema", () => Effect.sync(() => OperatorConfig.jsonSchema()))
  }),
)
