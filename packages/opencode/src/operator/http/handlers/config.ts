import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { OperatorConfig } from "@/operator/config"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiOperatorConfigInvalidError } from "../groups/config"
import { reloadAfterWrite } from "../reload"

export const operatorConfigHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorConfig", (handlers) =>
  Effect.gen(function* () {
    const operatorConfig = yield* OperatorConfig.Service
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()

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
      if (result.changed) yield* reloadAfterWrite(scope, config, bridge)
      return result
    })

    return handlers
      .handle("layers", () => operatorConfig.layers())
      .handle("update", (ctx) => apply(ctx.query.scope, operatorConfig.update(ctx.query.scope, ctx.payload)))
      .handle("write", (ctx) => apply(ctx.query.scope, operatorConfig.write(ctx.query.scope, ctx.payload.text)))
      .handle("schema", () => Effect.sync(() => OperatorConfig.jsonSchema()))
  }),
)
