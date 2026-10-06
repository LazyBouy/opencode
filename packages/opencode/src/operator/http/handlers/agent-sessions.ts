import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiAgentSessionsNotFoundError } from "../groups/agent-sessions"

export const operatorAgentSessionsHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "operatorAgentSessions",
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* OperatorAgentSessions.Service
      const notFound = (error: { message: string }) =>
        new ApiAgentSessionsNotFoundError({
          name: "OperatorAgentSessionsNotFoundError",
          data: { message: error.message },
        })
      return handlers
        .handle("state", (ctx) => service.state(ctx.params.name).pipe(Effect.mapError(notFound)))
        .handle("setMain", (ctx) =>
          service.setMain(ctx.params.name, ctx.payload.sessionID || undefined).pipe(Effect.mapError(notFound)),
        )
        .handle("mainSession", (ctx) =>
          Effect.gen(function* () {
            const agent = ctx.query.agent || (yield* service.defaultAgent())
            const found = yield* service.ensureMain(agent).pipe(Effect.mapError(notFound))
            return { agent, ...found }
          }),
        )
    }),
)
