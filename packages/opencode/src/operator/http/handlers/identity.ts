import { OperatorIdentity } from "@/operator/identity"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

export const operatorIdentityHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorIdentity", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* OperatorIdentity.Service

    return handlers
      .handle("list", () => identity.list())
      .handle("save", (ctx) => identity.save(ctx.payload))
      .handle("remove", (ctx) =>
        identity.remove(ctx.query.scope, ctx.query.file).pipe(
          Effect.as(true),
          Effect.mapError(() => new HttpApiError.NotFound({})),
        ),
      )
      .handle("reorder", (ctx) => identity.reorder(ctx.payload.scope, ctx.payload.files))
      .handle("preview", (ctx) => identity.preview(ctx.query.agent).pipe(Effect.map((text) => ({ text }))))
  }),
)
