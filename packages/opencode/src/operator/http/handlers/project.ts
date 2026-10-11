import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgents } from "@/operator/agents"
import { OperatorConfig } from "@/operator/config"
import { OperatorModels } from "@/operator/models"
import { OperatorSmallAgentNotes } from "@/operator/small-agent-notes"
import { OperatorSmallAgents } from "@/operator/small-agents"
import { OperatorProjectConfig } from "@/operator/project-config"
import { OperatorTools } from "@/operator/tools"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiAgentConflictError, ApiAgentInvalidError, ApiAgentNotFoundError } from "../groups/project"
import { copyOr } from "../groups/project-config"
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
        // An agent on the small model gets the model it resolves to (small-agents.ts).
        return OperatorSmallAgents.fill(ctx.query.scope, patch)
          .pipe(Effect.flatMap((filled) => agents.create(ctx.query.scope, name, filled, format)))
          .pipe(
            Effect.flatMap(written(ctx.query.scope)),
            Effect.mapError(copyOr(apiError)),
            OperatorProjectConfig.consent(ctx.query.confirmCopy),
          )
      })
      .handle("agentUpdate", (ctx) =>
        OperatorSmallAgents.fill(ctx.query.scope, ctx.payload)
          .pipe(
            Effect.flatMap((filled) => agents.update(ctx.query.scope, ctx.params.name, filled)),
            // A model or variant chosen again replaces the note about a cleared variant.
            Effect.tap(() =>
              ctx.payload.variant !== undefined || ctx.payload.modelSource !== undefined || ctx.payload.model
                ? InstanceState.context.pipe(
                    Effect.flatMap((instance) =>
                      Effect.promise(() =>
                        OperatorSmallAgentNotes.forget(OperatorConfig.projectRoot(instance), ctx.params.name),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          )
          .pipe(
            Effect.flatMap(written(ctx.query.scope)),
            Effect.mapError(copyOr(apiError)),
            OperatorProjectConfig.consent(ctx.query.confirmCopy),
          ),
      )
      .handle("agentRemove", (ctx) =>
        agents
          .remove(ctx.query.scope, ctx.params.name)
          .pipe(
            Effect.flatMap(written(ctx.query.scope)),
            Effect.mapError(copyOr(apiError)),
            OperatorProjectConfig.consent(ctx.query.confirmCopy),
          ),
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
