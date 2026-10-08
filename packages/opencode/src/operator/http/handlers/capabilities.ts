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
      .handle("remove", (ctx) => capabilities.remove(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("create", (ctx) => capabilities.create(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("copy", (ctx) => capabilities.copyTo(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("source", (ctx) =>
        capabilities
          .read({ kind: ctx.query.kind, name: ctx.query.name, namespace: ctx.query.namespace })
          .pipe(Effect.mapError(apiError)),
      )
      .handle("edit", (ctx) => capabilities.write(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("takeOpenCode", (ctx) => capabilities.takeOpenCode(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("seed", (ctx) => capabilities.seed(ctx.payload).pipe(Effect.mapError(apiError)))
  }),
)
