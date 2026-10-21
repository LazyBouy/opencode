import { OperatorHooks } from "@/operator/hooks/hooks"
import { OperatorHookEvents } from "@/operator/hooks/events"
import { OperatorProjects } from "@/operator/projects"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiHookInvalidError, ApiHookNotFoundError } from "../groups/hooks"

const number = (value: string | undefined) => {
  const parsed = value === undefined ? NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const operatorHookHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorHooks", (handlers) =>
  Effect.gen(function* () {
    const hooks = yield* OperatorHooks.Service
    return handlers
      .handle("list", (ctx) => hooks.effective(ctx.query.agent))
      .handle("settings", () => hooks.settings())
      .handle("saveSettings", (ctx) =>
        hooks
          .setSettings({
            ...(ctx.payload.timeout !== undefined ? { timeout: ctx.payload.timeout } : {}),
            ...(ctx.payload.paused !== undefined ? { paused: ctx.payload.paused } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ApiHookInvalidError({ name: "OperatorHookInvalidError", data: { message: error.message } }),
            ),
          ),
      )
      .handle("runs", (ctx) =>
        Effect.gen(function* () {
          const query = ctx.query
          const directory = yield* InstanceState.directory
          const project =
            query.scope === "all" || query.session
              ? undefined
              : (yield* Effect.promise(() => OperatorProjects.projectOf(directory)))?.key
          return yield* hooks.runs({
            ...(query.session ? { sessionID: query.session } : {}),
            ...(project ? { project } : {}),
            ...(query.agent ? { agent: query.agent } : {}),
            ...(query.hook ? { hook: query.hook } : {}),
            ...(query.event ? { event: query.event } : {}),
            ...(query.outcome ? { outcome: query.outcome } : {}),
            ...(query.test ? { test: query.test === "true" } : {}),
            ...(number(query.limit) !== undefined ? { limit: number(query.limit) } : {}),
            ...(number(query.offset) !== undefined ? { offset: number(query.offset) } : {}),
          })
        }),
      )
      .handle("run", (ctx) =>
        hooks.run(ctx.params.id).pipe(
          Effect.flatMap((run) =>
            run
              ? Effect.succeed(run)
              : Effect.fail(
                  new ApiHookNotFoundError({
                    name: "OperatorHookNotFoundError",
                    data: { message: `No hook run ${ctx.params.id}` },
                  }),
                ),
          ),
        ),
      )
      .handle("events", () =>
        Effect.succeed(OperatorHookEvents.EVENTS.map((event) => ({ ...event, fields: [...event.fields] }))),
      )
  }),
)
