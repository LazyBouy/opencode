import { OperatorCalls } from "@/operator/calls"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiCallNotFoundError } from "../groups/calls"

export const operatorCallHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorCalls", (handlers) =>
  Effect.gen(function* () {
    const calls = yield* OperatorCalls.Service
    const notFound = (error: { message: string }) =>
      new ApiCallNotFoundError({ name: "OperatorCallNotFoundError", data: { message: error.message } })
    return handlers
      .handle("list", (ctx) =>
        calls.list(ctx.params.sessionID, { after: ctx.query.after, limit: ctx.query.limit, kind: ctx.query.kind }),
      )
      .handle("export", (ctx) => calls.export(ctx.params.sessionID, ctx.query.format))
      .handle("get", (ctx) => calls.detail(ctx.params.sessionID, ctx.params.callID).pipe(Effect.mapError(notFound)))
      .handle("raw", (ctx) =>
        calls.raw(ctx.params.sessionID, ctx.params.callID, ctx.query.part).pipe(Effect.mapError(notFound)),
      )
  }),
)
