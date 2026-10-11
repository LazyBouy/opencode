import { OperatorCapabilities } from "@/operator/capabilities"
import { OperatorToolPatterns } from "@/operator/tool-patterns"
import { OperatorProjectConfig } from "@/operator/project-config"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiCapabilityError } from "../groups/capabilities"
import { copyOr } from "../groups/project-config"

const apiError = (error: { message: string }) =>
  new ApiCapabilityError({ name: "OperatorCapabilityError", data: { message: error.message } })

export const operatorCapabilityHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorCapabilities", (handlers) =>
  Effect.gen(function* () {
    const capabilities = yield* OperatorCapabilities.Service
    const patterns = yield* OperatorToolPatterns.Service
    return handlers
      .handle("list", (ctx) => capabilities.inventory({ namespace: ctx.query.namespace }))
      .handle("override", (ctx) =>
        capabilities
          .override(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("disable", (ctx) =>
        capabilities
          .disable(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("revert", (ctx) =>
        capabilities
          .revert(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("remove", (ctx) =>
        capabilities
          .remove(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("create", (ctx) =>
        capabilities
          .create(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("copy", (ctx) => capabilities.copyTo(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("toolPatterns", () => patterns.list())
      .handle("saveToolPattern", (ctx) => patterns.save(ctx.payload).pipe(Effect.mapError(apiError)))
      .handle("source", (ctx) =>
        capabilities
          .read({ kind: ctx.query.kind, name: ctx.query.name, namespace: ctx.query.namespace })
          .pipe(Effect.mapError(apiError)),
      )
      .handle("edit", (ctx) =>
        capabilities
          .write(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("takeOpenCode", (ctx) =>
        capabilities
          .takeOpenCode(ctx.payload)
          .pipe(Effect.mapError(copyOr(apiError)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("seed", (ctx) => capabilities.seed(ctx.payload).pipe(Effect.mapError(apiError)))
  }),
)
