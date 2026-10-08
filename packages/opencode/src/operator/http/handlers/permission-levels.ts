import { OperatorPermissionLevels } from "@/operator/permission-levels"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiPermissionLevelInvalidError, ApiPermissionLevelLockedError } from "../groups/permission-levels"

export const operatorPermissionLevelsHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "operatorPermissionLevels",
  (handlers) =>
    Effect.gen(function* () {
      const levels = yield* OperatorPermissionLevels.Service
      const apiError = (error: OperatorPermissionLevels.LockedError | OperatorPermissionLevels.InvalidError) =>
        error._tag === "OperatorPermissionLevelLocked"
          ? new ApiPermissionLevelLockedError({
              name: "OperatorPermissionLevelLockedError",
              data: { message: error.message },
            })
          : new ApiPermissionLevelInvalidError({
              name: "OperatorPermissionLevelInvalidError",
              data: { message: error.message },
            })
      return handlers
        .handle("get", (ctx) =>
          levels.view(ctx.params.level, ctx.query.namespace).pipe(
            Effect.mapError(
              (error) =>
                new ApiPermissionLevelInvalidError({
                  name: "OperatorPermissionLevelInvalidError",
                  data: { message: error.message },
                }),
            ),
          ),
        )
        .handle("save", (ctx) =>
          levels.save(ctx.params.level, ctx.payload, ctx.query.namespace).pipe(Effect.mapError(apiError)),
        )
    }),
)
