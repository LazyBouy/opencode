import { OperatorQueue } from "@/operator/queue"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiQueueInvalidError, ApiQueueNotFoundError } from "../groups/queue"

export const operatorQueueHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorQueue", (handlers) =>
  Effect.gen(function* () {
    const service = yield* OperatorQueue.Service
    const failure = (error: OperatorQueue.NotFoundError | OperatorQueue.InvalidError) =>
      error._tag === "OperatorQueueNotFound"
        ? new ApiQueueNotFoundError({ name: "OperatorQueueNotFoundError", data: { message: error.message } })
        : new ApiQueueInvalidError({ name: "OperatorQueueInvalidError", data: { message: error.message } })
    return handlers
      .handle("send", (ctx) => service.send(ctx.params.name, ctx.payload).pipe(Effect.mapError(failure)))
      .handle("agent", (ctx) =>
        service.list({ agent: ctx.params.name, status: ctx.query.status, limit: ctx.query.limit }),
      )
      .handle("list", (ctx) => service.list({ status: ctx.query.status, limit: ctx.query.limit }))
      .handle("cancel", (ctx) => service.cancel(ctx.params.id).pipe(Effect.mapError(failure)))
  }),
)
