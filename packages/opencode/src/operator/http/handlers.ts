import { operatorAgentPromptHandlers } from "./handlers/agent-prompt"
import { operatorConfigHandlers } from "./handlers/config"
import { operatorFolderHandlers } from "./handlers/folders"
import { operatorMemoryHandlers } from "./handlers/memory"
import { operatorNamespaceHandlers } from "./handlers/namespaces"
import { mergeHandlers } from "./handlers/merge"
import { operatorOverviewHandlers } from "./handlers/overview"
import { operatorProjectHandlers } from "./handlers/project"
import { operatorPromptHandlers } from "./handlers/prompts"
import { operatorToolPromptHandlers } from "./handlers/tool-prompt"
import { operatorCallHandlers } from "./handlers/calls"
import { operatorAgentPermissionsHandlers } from "./handlers/agent-permissions"
import { operatorPermissionLevelsHandlers } from "./handlers/permission-levels"
import { operatorSessionPermissionsHandlers } from "./handlers/session-permissions"
import { operatorAgentSessionsHandlers } from "./handlers/agent-sessions"
import { operatorQueueHandlers } from "./handlers/queue"
import { operatorTrashHandlers, operatorTrashItemHandlers } from "./handlers/trash"
import { operatorLayoutHandlers } from "./handlers/layout"
import { operatorOnboardingHandlers } from "./handlers/onboarding"
import { operatorModelDefaultsHandlers } from "./handlers/model-defaults"
import { operatorNamespaceConfigHandlers } from "./handlers/namespace-config"
import { operatorProjectRecordHandlers } from "./handlers/project-records"
import { operatorPermissionDecisionHandlers } from "./handlers/permission-decisions"
import { operatorCapabilityHandlers } from "./handlers/capabilities"
import { operatorHelperHandlers } from "./handlers/helpers"

// Handler layers for OperatorApi (per project) and OperatorRootApi (server-wide), provided by
// upstream's route assembly in one place each.
export const operatorHandlers = [
  mergeHandlers,
  operatorConfigHandlers,
  operatorProjectHandlers,
  operatorPromptHandlers,
  operatorMemoryHandlers,
  operatorAgentPromptHandlers,
  operatorTrashItemHandlers,
  operatorToolPromptHandlers,
  operatorCallHandlers,
  operatorAgentPermissionsHandlers,
  operatorPermissionLevelsHandlers,
  operatorSessionPermissionsHandlers,
  operatorAgentSessionsHandlers,
  operatorQueueHandlers,
  operatorCapabilityHandlers,
] as const
export const operatorRootHandlers = [
  operatorOverviewHandlers,
  operatorFolderHandlers,
  operatorNamespaceHandlers,
  operatorTrashHandlers,
  operatorLayoutHandlers,
  operatorOnboardingHandlers,
  operatorModelDefaultsHandlers,
  operatorNamespaceConfigHandlers,
  operatorProjectRecordHandlers,
  operatorPermissionDecisionHandlers,
  operatorHelperHandlers,
] as const
