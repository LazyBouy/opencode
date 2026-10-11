import { InstanceState } from "@/effect/instance-state"
import { OperatorMemory } from "@/operator/memory"
import { OperatorMemoryFolders } from "@/operator/memory-folders"
import { OperatorMemoryPage } from "@/operator/memory-page"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiMemoryInvalidError, ApiMemoryNotAllowedError } from "../groups/memory"

export const operatorMemoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorMemory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* OperatorMemory.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const store = yield* OperatorProfileStore.Service
    const page = yield* OperatorMemoryPage.Service
    const invalid = (error: OperatorMemoryPage.InvalidError) =>
      new ApiMemoryInvalidError({ name: "OperatorMemoryInvalidError", data: { message: error.message } })
    const apiError = (error: OperatorMemory.NotAllowedError) =>
      new ApiMemoryNotAllowedError({ name: "OperatorMemoryNotAllowedError", data: { message: error.message } })

    return handlers
      .handle("overview", () => memory.overview())
      .handle("levels", (ctx) => page.levels(ctx.query.agent))
      .handle("entry", (ctx) =>
        page
          .entry({
            level: ctx.query.level,
            file: ctx.query.file,
            ...(ctx.query.agent ? { agent: ctx.query.agent } : {}),
          })
          .pipe(Effect.mapError(invalid)),
      )
      .handle("saveEntry", (ctx) => page.save(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("forgetEntry", (ctx) =>
        page
          .forget({
            level: ctx.query.level,
            file: ctx.query.file,
            ...(ctx.query.agent ? { agent: ctx.query.agent } : {}),
          })
          .pipe(Effect.as(true), Effect.mapError(invalid)),
      )
      .handle("writeIndex", (ctx) => page.writeIndex(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("settings", () =>
        store.projects().pipe(Effect.flatMap((known) => Effect.promise(() => OperatorMemoryFolders.view(known)))),
      )
      .handle("saveSettings", (ctx) =>
        Effect.flatMap(store.projects(), (known) =>
          Effect.tryPromise({
            try: () => OperatorMemoryFolders.update(ctx.payload, known),
            catch: (error) =>
              new ApiMemoryNotAllowedError({
                name: "OperatorMemoryNotAllowedError",
                data: { message: error instanceof Error ? error.message : String(error) },
              }),
          }),
        ),
      )
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
