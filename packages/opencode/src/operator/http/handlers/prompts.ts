import { OperatorPrompts } from "@/operator/prompts"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

export const operatorPromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorPrompt", (handlers) =>
  Effect.gen(function* () {
    const prompts = yield* OperatorPrompts.Service
    const notFound = () => new HttpApiError.NotFound({})

    return handlers
      .handle("catalog", () => prompts.catalog())
      .handle("preview", (ctx) =>
        prompts
          .preview({ agent: ctx.query.agent, providerID: ctx.query.provider, modelID: ctx.query.model })
          .pipe(Effect.mapError(notFound)),
      )
      .handle("write", (ctx) =>
        prompts
          .write(ctx.query.scope, ctx.params.id, ctx.payload.text)
          .pipe(Effect.as(true), Effect.mapError(notFound)),
      )
      .handle("remove", (ctx) => prompts.remove(ctx.query.scope, ctx.params.id).pipe(Effect.as(true)))
  }),
)
