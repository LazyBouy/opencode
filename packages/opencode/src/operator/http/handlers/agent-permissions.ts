import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { OperatorAgentPermissions } from "@/operator/agent-permissions"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiAgentPermissionsInvalidError, ApiAgentPermissionsNotFoundError } from "../groups/agent-permissions"
import { reloadAfterWrite } from "../reload"

export const operatorAgentPermissionsHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "operatorAgentPermissions",
  (handlers) =>
    Effect.gen(function* () {
      const permissions = yield* OperatorAgentPermissions.Service
      const config = yield* Config.Service
      const bridge = yield* EffectBridge.make()
      const apiError = (error: OperatorAgentPermissions.NotFoundError | OperatorAgentPermissions.InvalidError) =>
        error._tag === "OperatorAgentPermissionsNotFound"
          ? new ApiAgentPermissionsNotFoundError({
              name: "OperatorAgentPermissionsNotFoundError",
              data: { message: error.message },
            })
          : new ApiAgentPermissionsInvalidError({
              name: "OperatorAgentPermissionsInvalidError",
              data: { message: error.message },
            })

      return handlers
        .handle("get", (ctx) =>
          permissions.get(ctx.params.name).pipe(
            Effect.mapError(
              (error) =>
                new ApiAgentPermissionsNotFoundError({
                  name: "OperatorAgentPermissionsNotFoundError",
                  data: { message: error.message },
                }),
            ),
          ),
        )
        .handle("save", (ctx) =>
          permissions
            .save({
              agent: ctx.params.name,
              scope: ctx.payload.scope,
              rules: ctx.payload.rules,
              confirmOrder: ctx.payload.confirmOrder,
            })
            .pipe(
              // The agent loads with the project: reload what reads the written file (an agent file in
              // the global config folder feeds every project).
              Effect.tap((written) =>
                reloadAfterWrite(
                  written.path.startsWith(Global.Path.config) ? "global" : ctx.payload.scope,
                  config,
                  bridge,
                ),
              ),
              Effect.mapError(apiError),
            ),
        )
    }),
)
