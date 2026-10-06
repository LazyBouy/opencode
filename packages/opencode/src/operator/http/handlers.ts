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
import { operatorTrashHandlers, operatorTrashItemHandlers } from "./handlers/trash"

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
] as const
export const operatorRootHandlers = [
  operatorOverviewHandlers,
  operatorFolderHandlers,
  operatorNamespaceHandlers,
  operatorTrashHandlers,
] as const
