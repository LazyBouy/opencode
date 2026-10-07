import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiSessionPermissionsLockedError, ApiSessionPermissionsNotFoundError } from "../groups/session-permissions"

export const operatorSessionPermissionsHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "operatorSessionPermissions",
  (handlers) =>
    Effect.gen(function* () {
      const permissions = yield* OperatorSessionPermissions.Service
      const notFound = (error: { message: string }) =>
        new ApiSessionPermissionsNotFoundError({
          name: "OperatorSessionPermissionsNotFoundError",
          data: { message: error.message },
        })
      return handlers
        .handle("get", (ctx) => permissions.get(ctx.params.sessionID).pipe(Effect.mapError(notFound)))
        .handle("save", (ctx) =>
          permissions.save(ctx.params.sessionID, ctx.payload.rules).pipe(
            Effect.mapError((error) =>
              error._tag === "OperatorSessionPermissionsLocked"
                ? new ApiSessionPermissionsLockedError({
                    name: "OperatorSessionPermissionsLockedError",
                    data: { message: error.message },
                  })
                : notFound(error),
            ),
          ),
        )
    }),
)
