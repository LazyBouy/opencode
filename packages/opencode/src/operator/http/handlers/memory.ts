import { InstanceState } from "@/effect/instance-state"
import { OperatorMemory } from "@/operator/memory"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiMemoryNotAllowedError } from "../groups/memory"

export const operatorMemoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorMemory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* OperatorMemory.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const apiError = (error: OperatorMemory.NotAllowedError) =>
      new ApiMemoryNotAllowedError({ name: "OperatorMemoryNotAllowedError", data: { message: error.message } })

    return handlers
      .handle("overview", () => memory.overview())
      .handle("read", (ctx) =>
        memory.read(ctx.query.path).pipe(
          Effect.map((text) => ({ path: ctx.query.path, text })),
          Effect.mapError(apiError),
        ),
      )
      .handle("write", (ctx) =>
        memory.write(ctx.payload.path, ctx.payload.text).pipe(
          // Skills load with the project; the other files are read on every request. A skill reloads
          // what reads it: its project, its namespace's projects, or every project for Global's.
          Effect.tap((written) =>
            written.kind === "skill"
              ? InstanceState.context.pipe(Effect.flatMap((ctx2) => reloads.wantFile(ctx.payload.path, ctx2.directory)))
              : Effect.void,
          ),
          Effect.as(true),
          Effect.mapError(apiError),
        ),
      )
  }),
)
