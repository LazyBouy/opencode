import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgentPermissions } from "@/operator/agent-permissions"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiAgentPermissionsInvalidError, ApiAgentPermissionsNotFoundError } from "../groups/agent-permissions"

export const operatorAgentPermissionsHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "operatorAgentPermissions",
  (handlers) =>
    Effect.gen(function* () {
      const permissions = yield* OperatorAgentPermissions.Service
      const live = yield* OperatorPermissionLive.Service
      const reloads = yield* OperatorReloadWhenIdle.Service
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
              // The agent's rules apply at once (permission-live.ts); the agent loads with the project,
              // which reloads to read the written file (an agent file in the global config folder feeds
              // every project) when none of its sessions is running.
              Effect.flatMap((written) =>
                Effect.gen(function* () {
                  const ctx2 = yield* InstanceState.context
                  yield* live.written({ directory: ctx2.directory, agent: ctx.params.name, rules: ctx.payload.rules })
                  const reload = yield* reloads.want(
                    written.path.startsWith(Global.Path.config) || ctx.payload.scope === "global"
                      ? "global"
                      : { directory: ctx2.directory },
                  )
                  return { ...written, reload }
                }),
              ),
              Effect.mapError(apiError),
            ),
        )
    }),
)
