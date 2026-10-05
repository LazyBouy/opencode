import { InstanceState } from "@/effect/instance-state"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { apiError } from "./namespaces"

export const operatorAgentPromptHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorAgentPrompt", (handlers) =>
  Effect.gen(function* () {
    const store = yield* OperatorProfileStore.Service
    const project = InstanceState.context.pipe(Effect.map(OperatorProfile.projectKey))

    return handlers
      .handle("get", (ctx) => project.pipe(Effect.flatMap((key) => store.agentPrompt(key, ctx.params.name))))
      .handle("update", (ctx) =>
        project.pipe(
          Effect.flatMap((key) => store.setAgent(key, ctx.params.name, ctx.payload)),
          Effect.mapError(apiError),
        ),
      )
  }),
)
