import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { OperatorAgents } from "@/operator/agents"
import { OperatorModels } from "@/operator/models"
import { OperatorTools } from "@/operator/tools"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiAgentConflictError, ApiAgentInvalidError, ApiAgentNotFoundError } from "../groups/project"
import { reloadAfterWrite } from "../reload"

export const operatorProjectHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorProject", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* OperatorAgents.Service
    const tools = yield* OperatorTools.Service
    const models = yield* OperatorModels.Service
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()

    // Agents load with the project, so a change reloads the projects that read the written file.
    const written = (scope: "global" | "project") => (file: string) =>
      reloadAfterWrite(scope, config, bridge).pipe(Effect.as({ path: file }))

    return handlers
      .handle("agents", () => agents.list())
      .handle("tools", () => tools.list())
      .handle("models", () => models.defaults())
      .handle("agentCreate", (ctx) => {
        const { name, format, ...patch } = ctx.payload
        return agents
          .create(ctx.query.scope, name, patch, format)
          .pipe(Effect.flatMap(written(ctx.query.scope)), Effect.mapError(apiError))
      })
      .handle("agentUpdate", (ctx) =>
        agents
          .update(ctx.query.scope, ctx.params.name, ctx.payload)
          .pipe(Effect.flatMap(written(ctx.query.scope)), Effect.mapError(apiError)),
      )
      .handle("agentRemove", (ctx) =>
        agents
          .remove(ctx.query.scope, ctx.params.name)
          .pipe(Effect.flatMap(written(ctx.query.scope)), Effect.mapError(apiError)),
      )
  }),
)

function apiError(error: { readonly _tag: string; readonly message: string }) {
  const data = { message: error.message }
  if (error._tag === "OperatorAgentNotFound")
    return new ApiAgentNotFoundError({ name: "OperatorAgentNotFoundError", data })
  if (error._tag === "OperatorAgentConflict")
    return new ApiAgentConflictError({ name: "OperatorAgentConflictError", data })
  return new ApiAgentInvalidError({ name: "OperatorAgentInvalidError", data })
}
