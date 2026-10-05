import { OperatorProfileStore } from "@/operator/profile-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiProfileInvalidError, ApiProfileNotFoundError } from "../groups/namespaces"
import { OperatorRootApi } from "../groups/overview"

export const apiError = (error: OperatorProfileStore.InvalidError | OperatorProfileStore.NotFoundError) =>
  error._tag === "OperatorProfileInvalid"
    ? new ApiProfileInvalidError({ name: "OperatorProfileInvalidError", data: { message: error.message } })
    : new ApiProfileNotFoundError({ name: "OperatorProfileNotFoundError", data: { message: error.message } })

export const operatorNamespaceHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorNamespace", (handlers) =>
  Effect.gen(function* () {
    const store = yield* OperatorProfileStore.Service
    const done = Effect.as(true)

    return handlers
      .handle("list", () => store.namespaces())
      .handle("create", (ctx) => store.createNamespace(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("get", (ctx) =>
        store.catalog(ctx.params.ns).pipe(
          Effect.map((catalog) => catalog.namespace),
          Effect.mapError(apiError),
        ),
      )
      .handle("update", (ctx) => store.updateNamespace(ctx.params.ns, ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("remove", (ctx) => store.removeNamespace(ctx.params.ns).pipe(done, Effect.mapError(apiError)))
      .handle("catalog", (ctx) => store.catalog(ctx.params.ns).pipe(Effect.mapError(apiError)))
      .handle("typeCreate", (ctx) =>
        store.saveType(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("typeUpdate", (ctx) =>
        store.saveType(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("typeRemove", (ctx) =>
        store.remove(ctx.params.ns, "type", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("layerCreate", (ctx) =>
        store.saveLayer(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("layerUpdate", (ctx) =>
        store.saveLayer(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("layerRemove", (ctx) =>
        store.remove(ctx.params.ns, "layer", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("layerCopy", (ctx) =>
        store.copyBuiltin(ctx.params.ns, ctx.params.id, ctx.payload.text).pipe(Effect.mapError(apiError)),
      )
      .handle("groupCreate", (ctx) =>
        store.saveGroup(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("groupUpdate", (ctx) =>
        store.saveGroup(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("groupRemove", (ctx) =>
        store.remove(ctx.params.ns, "group", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("profileCreate", (ctx) =>
        store.saveProfile(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("profileUpdate", (ctx) =>
        store.saveProfile(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("profileRemove", (ctx) =>
        store.remove(ctx.params.ns, "profile", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("copy", (ctx) =>
        store.copyTo(ctx.params.ns, ctx.payload.kind, ctx.payload.id, ctx.payload.target).pipe(
          Effect.map((copied) => ({ copied })),
          Effect.mapError(apiError),
        ),
      )
      .handle("projects", () => store.projects())
      .handle("project", (ctx) =>
        store
          .setProject(ctx.payload.key, {
            namespace: ctx.payload.namespace,
            purpose: ctx.payload.purpose,
            defaultProfile: ctx.payload.defaultProfile,
            dryRun: ctx.payload.dryRun,
          })
          .pipe(Effect.mapError(apiError)),
      )
  }),
)
