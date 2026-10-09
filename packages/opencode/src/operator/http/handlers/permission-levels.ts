import { OperatorPermissionLevels } from "@/operator/permission-levels"
import { OperatorProjectConfig } from "@/operator/project-config"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiPermissionLevelInvalidError, ApiPermissionLevelLockedError } from "../groups/permission-levels"
import { copyOr } from "../groups/project-config"

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
          levels
            .save(ctx.params.level, ctx.payload, ctx.query.namespace)
            .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
        )
    }),
)
