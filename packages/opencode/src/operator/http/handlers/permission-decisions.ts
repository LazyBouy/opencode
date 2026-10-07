import { OperatorPermissionDecide } from "@/operator/permission-decide"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OperatorRootApi } from "../groups/overview"
import { ApiPermissionGoneError, ApiPermissionRefusedError } from "../groups/permission-decisions"

export const operatorPermissionDecisionHandlers = HttpApiBuilder.group(
  OperatorRootApi,
  "operatorPermissionDecisions",
  (handlers) =>
    Effect.gen(function* () {
      const decide = yield* OperatorPermissionDecide.Service
      const decisions = yield* OperatorPermissionDecisions.Service
      return handlers
        .handle("decide", (ctx) =>
          decide.decide(ctx.params.requestID, ctx.payload).pipe(
            Effect.mapError((error) =>
              error._tag === "OperatorPermissionGone"
                ? new ApiPermissionGoneError({ name: "OperatorPermissionGoneError", data: { message: error.message } })
                : new ApiPermissionRefusedError({
                    name: "OperatorPermissionRefusedError",
                    data: { message: error.message },
                  }),
            ),
          ),
        )
        .handle("decisions", (ctx) =>
          decisions.list({
            ...(ctx.query.sessionID ? { sessionID: ctx.query.sessionID } : {}),
            ...(ctx.query.agent ? { agent: ctx.query.agent } : {}),
            ...(ctx.query.project ? { project: ctx.query.project } : {}),
            ...(ctx.query.limit ? { limit: ctx.query.limit } : {}),
          }),
        )
    }),
)
