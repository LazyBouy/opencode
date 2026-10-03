import { OperatorAgents } from "@/operator/agents"
import { OperatorTools } from "@/operator/tools"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

export const operatorProjectHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorProject", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* OperatorAgents.Service
    const tools = yield* OperatorTools.Service

    return handlers.handle("agents", () => agents.list()).handle("tools", () => tools.list())
  }),
)
