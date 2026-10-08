import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "@/operator/config"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
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
      scope: OperatorConfig.WriteScope,
      write: Effect.Effect<typeof OperatorConfig.UpdateResult.Type, OperatorConfig.InvalidError>,
      namespace?: string,
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
      // The project (every project, for global config; the namespace's loaded projects, for its config)
      // reloads to read it when none of its sessions is running.
      if (!result.changed) return result
      const directory = (yield* InstanceState.context).directory
      if (scope === "namespace") {
        const id = yield* operatorConfig.namespaceOf(namespace)
        const reloaded = yield* Effect.forEach(OperatorNamespaceScope.instancesOf({ namespace: id }), (item) =>
          reloads.want({ directory: item }),
        )
        return { ...result, reload: reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const) }
      }
      const reload = yield* reloads.want(scope === "global" ? "global" : { directory })
      return { ...result, reload }
    })

    return handlers
      .handle("layers", (ctx) => operatorConfig.layers(ctx.query.namespace))
      .handle("update", (ctx) =>
        apply(
          ctx.query.scope,
          operatorConfig.update(ctx.query.scope, ctx.payload, ctx.query.namespace),
          ctx.query.namespace,
        ),
      )
      .handle("write", (ctx) =>
        apply(
          ctx.query.scope,
          operatorConfig.write(ctx.query.scope, ctx.payload.text, ctx.query.namespace),
          ctx.query.namespace,
        ),
      )
      .handle("schema", () => Effect.sync(() => OperatorConfig.jsonSchema()))
  }),
)
