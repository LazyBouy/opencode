import { OperatorHooks } from "@/operator/hooks/hooks"
import { OperatorHookEvents } from "@/operator/hooks/events"
import { OperatorHookManage } from "@/operator/hooks/manage"
import { OperatorHookTemplates } from "@/operator/hooks/templates"
import { OperatorProjectConfig } from "@/operator/project-config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { OperatorProjects } from "@/operator/projects"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiHookInvalidError, ApiHookNotFoundError } from "../groups/hooks"
import { copyOr } from "../groups/project-config"

const invalid = (error: { readonly message: string }) =>
  new ApiHookInvalidError({ name: "OperatorHookInvalidError", data: { message: error.message } })

const number = (value: string | undefined) => {
  const parsed = value === undefined ? NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const operatorHookHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorHooks", (handlers) =>
  Effect.gen(function* () {
    const hooks = yield* OperatorHooks.Service
    const manage = yield* OperatorHookManage.Service
    const flags = yield* RuntimeFlags.Service
    return handlers
      .handle("list", (ctx) =>
        hooks
          .effective(ctx.query.agent, ctx.query.namespace)
          .pipe(Effect.map((found) => ({ ...found, pluginsOff: flags.disableDefaultPlugins === true }))),
      )
      .handle("save", (ctx) =>
        manage
          .save(ctx.payload)
          .pipe(Effect.mapError(copyOr(invalid)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("state", (ctx) =>
        manage
          .setState(ctx.payload)
          .pipe(Effect.mapError(copyOr(invalid)), OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("remove", (ctx) =>
        manage
          .remove(ctx.payload)
          .pipe(
            Effect.as(true),
            Effect.mapError(copyOr(invalid)),
            OperatorProjectConfig.consent(ctx.query.confirmCopy),
          ),
      )
      .handle("test", (ctx) => manage.test(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("sample", (ctx) =>
        Effect.succeed({
          input: OperatorHookTemplates.sample(ctx.query.event),
          ...(ctx.query.language ? { script: OperatorHookTemplates.script(ctx.query.event, ctx.query.language) } : {}),
        }),
      )
      .handle("scripts", (ctx) => manage.scripts(ctx.query.namespace))
      .handle("script", (ctx) =>
        manage.readScript({ path: ctx.query.path, namespace: ctx.query.namespace }).pipe(Effect.mapError(invalid)),
      )
      .handle("saveScript", (ctx) => manage.writeScript(ctx.payload).pipe(Effect.as(true), Effect.mapError(invalid)))
      .handle("newScript", (ctx) => manage.newScript(ctx.payload).pipe(Effect.mapError(invalid)))
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
          // Test runs belong to no project: they run in their hook's level's folder.
          const project =
            query.scope === "all" || query.session || query.test === "true"
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
