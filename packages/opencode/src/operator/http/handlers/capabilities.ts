import { OperatorCapabilities } from "@/operator/capabilities"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiCapabilityError } from "../groups/capabilities"

const apiError = (error: { message: string }) =>
  new ApiCapabilityError({ name: "OperatorCapabilityError", data: { message: error.message } })

export const operatorCapabilityHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorCapabilities", (handlers) =>
  Effect.gen(function* () {
    const capabilities = yield* OperatorCapabilities.Service
    return handlers
      .handle("list", (ctx) => capabilities.inventory({ namespace: ctx.query.namespace }))
      .handle("override", (ctx) => capabilities.override(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("disable", (ctx) => capabilities.disable(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("revert", (ctx) => capabilities.revert(ctx.payload).pipe(Effect.mapError(apiError)))
  }),
)
