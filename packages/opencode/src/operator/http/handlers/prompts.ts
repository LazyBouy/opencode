import { OperatorPrompts } from "@/operator/prompts"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiPromptGenerateError, ApiPromptNotFoundError } from "../groups/prompts"

export const operatorPromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorPrompt", (handlers) =>
  Effect.gen(function* () {
    const prompts = yield* OperatorPrompts.Service

    const notFound = (error: { _tag: string; message: string }) =>
      error._tag === "OperatorGenerateError"
        ? new ApiPromptGenerateError({ name: "OperatorPromptGenerateError", data: { message: error.message } })
        : new ApiPromptNotFoundError({ name: "OperatorPromptNotFoundError", data: { message: error.message } })

    return handlers
      .handle("catalog", () => prompts.catalog())
      .handle("sample", (ctx) =>
        prompts
          .sample({
            agent: ctx.query.agent,
            layer: ctx.query.layer,
            providerID: ctx.query.provider,
            modelID: ctx.query.model,
          })
          .pipe(Effect.mapError(notFound)),
      )
      .handle("purpose", (ctx) =>
        prompts.purpose(ctx.payload).pipe(
          Effect.map((text) => ({ text })),
          Effect.mapError(
            (error) =>
              new ApiPromptGenerateError({ name: "OperatorPromptGenerateError", data: { message: error.message } }),
          ),
        ),
      )
      .handle("preview", (ctx) =>
        prompts
          .preview({
            agent: ctx.query.agent,
            providerID: ctx.query.provider,
            modelID: ctx.query.model,
            profile: ctx.query.profile,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ApiPromptNotFoundError({ name: "OperatorPromptNotFoundError", data: { message: error.message } }),
            ),
          ),
      )
  }),
)
