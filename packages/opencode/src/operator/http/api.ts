import { HttpApi } from "effect/unstable/httpapi"
import { OperatorConfigApi } from "./groups/config"
import { MergeApi } from "./groups/merge"

// Every route this fork adds. Upstream's InstanceHttpApi mounts this once, so new fork routes are
// added here without touching upstream files. Keep group files free of handler imports.
export const OperatorApi = HttpApi.make("operator").addHttpApi(MergeApi).addHttpApi(OperatorConfigApi)
