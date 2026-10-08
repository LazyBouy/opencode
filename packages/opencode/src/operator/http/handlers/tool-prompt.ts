import { OperatorCalls } from "@/operator/calls"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiToolPromptNotFoundError } from "../groups/tool-prompt"

export const operatorToolPromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorToolPrompt", (handlers) =>
  Effect.gen(function* () {
    const prompts = yield* OperatorToolPrompt.Service
    const calls = yield* OperatorCalls.Service
    const notFound = (error: { message: string }) =>
      new ApiToolPromptNotFoundError({ name: "OperatorToolPromptNotFoundError", data: { message: error.message } })

    return handlers
      .handle("last", (ctx) => calls.last(ctx.params.name))
      .handle("prompt", (ctx) =>
        prompts
          .build({
            agent: ctx.params.name,
            model: ctx.query.model,
            runsAs: ctx.query.runsAs,
            parentSessionID: ctx.query.parent,
            sessionID: ctx.query.session,
          })
          .pipe(Effect.mapError(notFound)),
      )
      .handle("draft", (ctx) =>
        prompts
          .draft({
            agent: ctx.params.name,
            model: ctx.payload.model,
            runsAs: ctx.payload.runsAs,
            parentSessionID: ctx.payload.parent,
            sessionID: ctx.payload.sessionID,
            agentRules: ctx.payload.agentRules,
            sessionRules: ctx.payload.sessionRules,
          })
          .pipe(Effect.mapError(notFound)),
      )
  }),
)
