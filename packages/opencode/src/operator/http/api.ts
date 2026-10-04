import { HttpApi } from "effect/unstable/httpapi"
import { OperatorConfigApi } from "./groups/config"
import { OperatorIdentityApi } from "./groups/identity"
import { OperatorMemoryApi } from "./groups/memory"
import { MergeApi } from "./groups/merge"
import { OperatorProjectApi } from "./groups/project"
import { OperatorPromptApi } from "./groups/prompts"

export { OperatorRootApi } from "./groups/overview"

// Every per-project route this fork adds. Upstream's InstanceHttpApi mounts this once (and the server
// mounts OperatorRootApi beside its root API), so new fork routes are added here without touching
// upstream files.
// Keep group files free of handler imports.
export const OperatorApi = HttpApi.make("operator")
  .addHttpApi(MergeApi)
  .addHttpApi(OperatorConfigApi)
  .addHttpApi(OperatorProjectApi)
  .addHttpApi(OperatorIdentityApi)
  .addHttpApi(OperatorPromptApi)
  .addHttpApi(OperatorMemoryApi)
