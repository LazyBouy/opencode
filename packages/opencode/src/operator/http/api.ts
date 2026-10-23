import { HttpApi } from "effect/unstable/httpapi"
import { OperatorAgentPromptApi } from "./groups/agent-prompt"
import { OperatorConfigApi } from "./groups/config"
import { OperatorMemoryApi } from "./groups/memory"
import { MergeApi } from "./groups/merge"
import { OperatorProjectApi } from "./groups/project"
import { OperatorPromptApi } from "./groups/prompts"
import { OperatorCallApi } from "./groups/calls"
import { OperatorToolPromptApi } from "./groups/tool-prompt"
import { OperatorAgentPermissionApi } from "./groups/agent-permissions"
import { OperatorPermissionLevelApi } from "./groups/permission-levels"
import { OperatorSessionPermissionApi } from "./groups/session-permissions"
import { OperatorAgentSessionApi } from "./groups/agent-sessions"
import { OperatorQueueApi } from "./groups/queue"
import { OperatorTrashItemApi } from "./groups/trash"
import { OperatorCapabilityApi } from "./groups/capabilities"
import { OperatorHookApi } from "./groups/hooks"
import { OperatorProjectInboxApi } from "./groups/project-inbox"

export { OperatorRootApi } from "./groups/overview"

// Every per-project route this fork adds. Upstream's InstanceHttpApi mounts this once (and the server
// mounts OperatorRootApi beside its root API), so new fork routes are added here without touching
// upstream files.
// Keep group files free of handler imports.
export const OperatorApi = HttpApi.make("operator")
  .addHttpApi(MergeApi)
  .addHttpApi(OperatorConfigApi)
  .addHttpApi(OperatorProjectApi)
  .addHttpApi(OperatorPromptApi)
  .addHttpApi(OperatorMemoryApi)
  .addHttpApi(OperatorAgentPromptApi)
  .addHttpApi(OperatorTrashItemApi)
  .addHttpApi(OperatorToolPromptApi)
  .addHttpApi(OperatorCallApi)
  .addHttpApi(OperatorAgentPermissionApi)
  .addHttpApi(OperatorPermissionLevelApi)
  .addHttpApi(OperatorSessionPermissionApi)
  .addHttpApi(OperatorAgentSessionApi)
  .addHttpApi(OperatorQueueApi)
  .addHttpApi(OperatorCapabilityApi)
  .addHttpApi(OperatorHookApi)
  .addHttpApi(OperatorProjectInboxApi)
