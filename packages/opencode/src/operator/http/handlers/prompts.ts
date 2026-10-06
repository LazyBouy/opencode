import { OperatorProfile } from "@/operator/profile"
import { OperatorPrompts } from "@/operator/prompts"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiPromptGenerateError, ApiPromptNotFoundError } from "../groups/prompts"

// The preview's `override` query: JSON of an override, or null.
const decodeOverride = Schema.decodeUnknownEffect(Schema.NullOr(OperatorProfile.Override))
const invalidOverride = () => new OperatorPrompts.NotFoundError({ message: "The override is not valid" })
const overrideOf = Effect.fnUntraced(function* (text: string | undefined) {
  if (text === undefined) return undefined
  const value = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: invalidOverride })
  return yield* decodeOverride(value).pipe(Effect.mapError(invalidOverride))
})

export const operatorPromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorPrompt", (handlers) =>
  Effect.gen(function* () {
    const prompts = yield* OperatorPrompts.Service

    const notFound = (error: { _tag: string; message: string }) =>
      error._tag === "OperatorGenerateError"
        ? new ApiPromptGenerateError({ name: "OperatorPromptGenerateError", data: { message: error.message } })
        : new ApiPromptNotFoundError({ name: "OperatorPromptNotFoundError", data: { message: error.message } })

    return handlers
      .handle("catalog", () => prompts.catalog())
      .handle("plugins", () => prompts.plugins())
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
        Effect.gen(function* () {
          const override = yield* overrideOf(ctx.query.override)
          return yield* prompts.preview({
            agent: ctx.query.agent,
            providerID: ctx.query.provider,
            modelID: ctx.query.model,
            profile: ctx.query.profile,
            override,
          })
        }).pipe(
          Effect.mapError(
            (error) =>
              new ApiPromptNotFoundError({ name: "OperatorPromptNotFoundError", data: { message: error.message } }),
          ),
        ),
      )
  }),
)
