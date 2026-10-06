import { OperatorProjectRecords } from "@/operator/project-records"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OperatorRootApi } from "../groups/overview"
import { ApiProjectRecordInvalidError } from "../groups/project-records"

export const operatorProjectRecordHandlers = HttpApiBuilder.group(
  OperatorRootApi,
  "operatorProjectRecords",
  (handlers) =>
    Effect.succeed(
      handlers
        .handle("list", () => Effect.promise(() => OperatorProjectRecords.list()))
        .handle("update", (ctx) =>
          Effect.gen(function* () {
            const { key, ...patch } = ctx.payload
            const result = yield* Effect.promise(() => OperatorProjectRecords.update(key, patch))
            if (result instanceof OperatorProjectRecords.InvalidError)
              return yield* new ApiProjectRecordInvalidError({
                name: "OperatorProjectRecordInvalidError",
                data: { message: result.message },
              })
            return result
          }),
        ),
    ),
)
