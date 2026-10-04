import { OperatorFolders } from "@/operator/folders"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiFolderInvalidError, ApiFolderOutsideError } from "../groups/folders"
import { OperatorRootApi } from "../groups/overview"

const apiError = (error: OperatorFolders.OutsideError | OperatorFolders.InvalidError) =>
  error._tag === "OperatorFolderOutside"
    ? new ApiFolderOutsideError({ name: "OperatorFolderOutsideError", data: { message: error.message } })
    : new ApiFolderInvalidError({ name: "OperatorFolderInvalidError", data: { message: error.message } })

export const operatorFolderHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorFolder", (handlers) =>
  Effect.gen(function* () {
    const folders = yield* OperatorFolders.Service

    return handlers
      .handle("roots", () => Effect.sync(() => folders.roots()))
      .handle("list", (ctx) => folders.list(ctx.query.path).pipe(Effect.mapError(apiError)))
      .handle("create", (ctx) =>
        folders.create({ parent: ctx.payload.parent, name: ctx.payload.name, git: ctx.payload.git ?? true }).pipe(
          Effect.map((path) => ({ path })),
          Effect.mapError(apiError),
        ),
      )
      .handle("init", (ctx) =>
        folders.init(ctx.payload.path).pipe(
          Effect.map((path) => ({ path })),
          Effect.mapError(apiError),
        ),
      )
  }),
)
