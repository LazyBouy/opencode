import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { OperatorMemory } from "@/operator/memory"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiMemoryNotAllowedError } from "../groups/memory"
import { reloadAfterWrite } from "../reload"

export const operatorMemoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorMemory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* OperatorMemory.Service
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()
    const apiError = (error: OperatorMemory.NotAllowedError) =>
      new ApiMemoryNotAllowedError({ name: "OperatorMemoryNotAllowedError", data: { message: error.message } })

    return handlers
      .handle("overview", () => memory.overview())
      .handle("read", (ctx) =>
        memory.read(ctx.query.path).pipe(
          Effect.map((text) => ({ path: ctx.query.path, text })),
          Effect.mapError(apiError),
        ),
      )
      .handle("write", (ctx) =>
        memory.write(ctx.payload.path, ctx.payload.text).pipe(
          // Skills load with the project; the other files are read on every request.
          Effect.tap((written) =>
            written.kind === "skill" ? reloadAfterWrite(written.scope, config, bridge) : Effect.void,
          ),
          Effect.as(true),
          Effect.mapError(apiError),
        ),
      )
  }),
)
