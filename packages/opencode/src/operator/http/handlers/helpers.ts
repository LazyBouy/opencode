import { OperatorHelpers } from "@/operator/helpers"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OperatorRootApi } from "../groups/overview"
import { ApiHelperError } from "../groups/helpers"

export const operatorHelperHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorHelpers", (handlers) =>
  Effect.gen(function* () {
    const helpers = yield* OperatorHelpers.Service
    const failed = (error: OperatorHelpers.HelperError) =>
      new ApiHelperError({ name: "OperatorHelperError", data: { message: error.message } })
    return handlers
      .handle("list", (ctx) => helpers.list(ctx.query.ns).pipe(Effect.mapError(failed)))
      .handle("create", (ctx) => helpers.create(ctx.params.ns, ctx.payload).pipe(Effect.mapError(failed)))
      .handle("update", (ctx) =>
        helpers.update(ctx.params.ns, ctx.params.name, ctx.payload).pipe(Effect.mapError(failed)),
      )
      .handle("remove", (ctx) => helpers.remove(ctx.params.ns, ctx.params.name).pipe(Effect.mapError(failed)))
  }),
)
