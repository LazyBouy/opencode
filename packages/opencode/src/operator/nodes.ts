import { MergeAdapterRegistry } from "@/merge/adapter/registry"
import { MergeBinding } from "@/merge/binding"
import { OperatorAgents } from "./agents"
import { OperatorConfig } from "./config"
import { OperatorFolders } from "./folders"
import { OperatorInbox } from "./inbox"
import { OperatorMemory } from "./memory"
import { OperatorModels } from "./models"
import { OperatorOverview } from "./overview"
import { OperatorGenerate } from "./generate"
import { OperatorHelperTexts } from "./helper-texts"
import { OperatorHelpers } from "./helpers"
import { OperatorHelperRuns } from "./helper-runs"
import { OperatorHelperTriggers } from "./helper-triggers"
import { OperatorProfileStore } from "./profile-store"
import { OperatorTrash } from "./trash"
import { OperatorTrashItems } from "./trash-items"
import { OperatorCapabilities } from "./capabilities"
import { OperatorLayoutMove } from "./layout-move"
import { OperatorProjectSessions } from "./project-sessions"
import { OperatorPrompts } from "./prompts"
import { OperatorTools } from "./tools"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorToolPrompt } from "./tool-prompt"
import { OperatorCalls } from "./calls"
import { OperatorAgentPermissions } from "./agent-permissions"
import { OperatorPermissionLevels } from "./permission-levels"
import { OperatorSessionPermissions } from "./session-permissions"
import { OperatorAgentSessions } from "./agent-sessions"
import { OperatorQueue } from "./queue"
import { OperatorMessagingSeams } from "./messaging/seams"
import { OperatorProjectInbox } from "./messaging/inbox"
import { OperatorPing } from "./messaging/ping"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorPermissionDecisions } from "./permission-decisions"
import { OperatorPermissionDecide } from "./permission-decide"
import { OperatorReloadWhenIdle } from "./reload-when-idle"
import { OperatorProviderRefresh } from "./provider-refresh"
import { OperatorPermissionLocks } from "./permission-locks"
import { OperatorResolutions } from "./resolutions"
import { OperatorDynamicLayers } from "./dynamic-layers"
import { OperatorMemoryPage } from "./memory-page"
import { OperatorToolPatterns } from "./tool-patterns"
import { OperatorMemoryService } from "./memory-service"
import { OperatorTelemetryAlerting } from "./telemetry/alerting"
import { OperatorTelemetry } from "./telemetry/telemetry"
import { OperatorHooks } from "./hooks/hooks"
import { OperatorHookSeams } from "./hooks/seams"
import { OperatorHookManage } from "./hooks/manage"

// Services the fork's routes need, added to the server's service graph in one place.
export const operatorNodes = [
  MergeBinding.node,
  MergeAdapterRegistry.node,
  OperatorConfig.node,
  OperatorOverview.node,
  OperatorInbox.node,
  OperatorAgents.node,
  OperatorModels.node,
  OperatorTools.node,
  OperatorPermissionRules.node,
  OperatorToolPrompt.node,
  OperatorCalls.node,
  OperatorAgentPermissions.node,
  OperatorPermissionLevels.node,
  OperatorSessionPermissions.node,
  OperatorAgentSessions.node,
  OperatorMessagingSeams.node,
  OperatorQueue.node,
  OperatorProjectInbox.node,
  OperatorPing.node,
  OperatorPermissionLive.node,
  OperatorPermissionDecisions.node,
  OperatorPermissionDecide.node,
  OperatorReloadWhenIdle.node,
  OperatorProviderRefresh.node,
  OperatorPermissionLocks.node,
  OperatorResolutions.node,
  OperatorDynamicLayers.node,
  OperatorMemoryService.node,
  OperatorMemoryPage.node,
  OperatorToolPatterns.node,
  OperatorPrompts.node,
  OperatorFolders.node,
  OperatorMemory.node,
  OperatorProfileStore.node,
  OperatorProjectSessions.node,
  OperatorGenerate.node,
  OperatorHelperTexts.node,
  OperatorHelpers.node,
  OperatorHelperRuns.node,
  OperatorHelperTriggers.node,
  OperatorTrash.node,
  OperatorTrashItems.node,
  OperatorCapabilities.node,
  OperatorLayoutMove.node,
  OperatorTelemetry.node,
  OperatorTelemetryAlerting.node,
  OperatorHooks.node,
  OperatorHookSeams.node,
  OperatorHookManage.node,
] as const
