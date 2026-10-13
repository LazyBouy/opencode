import { OperatorHelpers } from "@/operator/helpers"
import { OperatorHelperRuns } from "@/operator/helper-runs"
import { OperatorHelperTriggers } from "@/operator/helper-triggers"
import { OperatorNotifications } from "@/operator/notifications"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OperatorRootApi } from "../groups/overview"
import { ApiHelperError } from "../groups/helpers"

export const operatorHelperHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorHelpers", (handlers) =>
  Effect.gen(function* () {
    const helpers = yield* OperatorHelpers.Service
    const runs = yield* OperatorHelperRuns.Service
    const triggers = yield* OperatorHelperTriggers.Service
    const failed = (error: OperatorHelpers.HelperError) =>
      new ApiHelperError({ name: "OperatorHelperError", data: { message: error.message } })
    return handlers
      .handle("list", (ctx) => helpers.list(ctx.query.ns).pipe(Effect.mapError(failed)))
      .handle("create", (ctx) => helpers.create(ctx.params.ns, ctx.payload).pipe(Effect.mapError(failed)))
      .handle("update", (ctx) =>
        helpers.update(ctx.params.ns, ctx.params.name, ctx.payload).pipe(Effect.mapError(failed)),
      )
      .handle("remove", (ctx) => helpers.remove(ctx.params.ns, ctx.params.name).pipe(Effect.mapError(failed)))
      .handle("runs", (ctx) => runs.runs(ctx.params.ns, ctx.params.name))
      .handle("triggers", (ctx) => triggers.status(ctx.params.ns, ctx.params.name))
      .handle("runTrigger", (ctx) =>
        triggers.fire({ namespace: ctx.params.ns, name: ctx.params.name, id: ctx.params.id }).pipe(
          Effect.map((started) => ({ started })),
          Effect.mapError(
            (error) => new ApiHelperError({ name: "OperatorHelperError", data: { message: error.message } }),
          ),
        ),
      )
      .handle("settings", () => runs.settings())
      .handle("saveSettings", (ctx) =>
        runs
          .setSettings(ctx.payload)
          .pipe(
            Effect.mapError(
              (error) => new ApiHelperError({ name: "OperatorHelperError", data: { message: error.message } }),
            ),
          ),
      )
      .handle("notifications", () => Effect.promise(() => OperatorNotifications.list()))
      .handle("dismiss", (ctx) => Effect.promise(() => OperatorNotifications.dismiss(ctx.params.id)))
  }),
)
