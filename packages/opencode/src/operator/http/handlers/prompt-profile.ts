import { OperatorProfileStore } from "@/operator/profile-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OperatorRootApi } from "../groups/overview"
import { ApiProfileInvalidError, ApiProfileNotFoundError } from "../groups/prompt-profile"

const apiError = (error: OperatorProfileStore.InvalidError | OperatorProfileStore.NotFoundError) =>
  error._tag === "OperatorProfileInvalid"
    ? new ApiProfileInvalidError({ name: "OperatorProfileInvalidError", data: { message: error.message } })
    : new ApiProfileNotFoundError({ name: "OperatorProfileNotFoundError", data: { message: error.message } })

export const operatorPromptProfileHandlers = HttpApiBuilder.group(
  OperatorRootApi,
  "operatorPromptProfile",
  (handlers) =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service

      return handlers
        .handle("catalog", () => store.catalog())
        .handle("layerCreate", (ctx) => store.saveLayer(undefined, ctx.payload).pipe(Effect.mapError(apiError)))
        .handle("layerUpdate", (ctx) => store.saveLayer(ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)))
        .handle("layerRemove", (ctx) =>
          store.removeLayer(ctx.params.id).pipe(Effect.as(true), Effect.mapError(apiError)),
        )
        .handle("groupCreate", (ctx) => store.saveGroup(undefined, ctx.payload).pipe(Effect.mapError(apiError)))
        .handle("groupUpdate", (ctx) => store.saveGroup(ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)))
        .handle("groupRemove", (ctx) =>
          store.removeGroup(ctx.params.id).pipe(Effect.as(true), Effect.mapError(apiError)),
        )
        .handle("profileCreate", (ctx) => store.saveProfile(undefined, ctx.payload).pipe(Effect.mapError(apiError)))
        .handle("profileUpdate", (ctx) => store.saveProfile(ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)))
        .handle("profileRemove", (ctx) =>
          store.removeProfile(ctx.params.id).pipe(Effect.as(true), Effect.mapError(apiError)),
        )
        .handle("defaults", (ctx) => store.saveDefaults(ctx.payload).pipe(Effect.mapError(apiError)))
    }),
)
