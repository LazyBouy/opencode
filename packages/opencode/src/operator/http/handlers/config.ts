import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "@/operator/config"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiOperatorConfigInvalidError } from "../groups/config"

export const operatorConfigHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorConfig", (handlers) =>
  Effect.gen(function* () {
    const operatorConfig = yield* OperatorConfig.Service
    const reloads = yield* OperatorReloadWhenIdle.Service

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
      // The project (every project, for global config) reloads to read it when none of its sessions is
      // running.
      if (!result.changed) return result
      const directory = (yield* InstanceState.context).directory
      const reload = yield* reloads.want(scope === "global" ? "global" : { directory })
      return { ...result, reload }
    })

    return handlers
      .handle("layers", () => operatorConfig.layers())
      .handle("update", (ctx) => apply(ctx.query.scope, operatorConfig.update(ctx.query.scope, ctx.payload)))
      .handle("write", (ctx) => apply(ctx.query.scope, operatorConfig.write(ctx.query.scope, ctx.payload.text)))
      .handle("schema", () => Effect.sync(() => OperatorConfig.jsonSchema()))
  }),
)
