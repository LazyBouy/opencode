import { OperatorTrash } from "@/operator/trash"
import { OperatorTrashItems } from "@/operator/trash-items"
import { OperatorProjectConfig } from "@/operator/project-config"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiTrashError } from "../groups/trash"
import { OperatorRootApi } from "../groups/overview"
import { copyOr } from "../groups/project-config"

const apiError = (error: { message: string }) =>
  new ApiTrashError({ name: "OperatorTrashError", data: { message: error.message } })

export const operatorTrashHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorTrash", (handlers) =>
  Effect.gen(function* () {
    const trash = yield* OperatorTrash.Service
    return handlers
      .handle("list", () => trash.list())
      .handle("project", (ctx) => trash.project(ctx.payload.key).pipe(Effect.mapError(apiError)))
      .handle("session", (ctx) => trash.session(ctx.payload.sessionID).pipe(Effect.mapError(apiError)))
      .handle("restore", (ctx) => trash.restore(ctx.params.id).pipe(Effect.mapError(apiError)))
      .handle("purge", (ctx) => trash.purge(ctx.params.id).pipe(Effect.as(true), Effect.mapError(apiError)))
      .handle("empty", () => trash.empty().pipe(Effect.map((purged) => ({ purged }))))
  }),
)

export const operatorTrashItemHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorTrashItem", (handlers) =>
  Effect.gen(function* () {
    const items = yield* OperatorTrashItems.Service
    return handlers.handle("remove", (ctx) =>
      items
        .remove(ctx.payload)
        .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
    )
  }),
)
