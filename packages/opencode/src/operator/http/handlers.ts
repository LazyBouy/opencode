import { operatorConfigHandlers } from "./handlers/config"
import { operatorFolderHandlers } from "./handlers/folders"
import { operatorIdentityHandlers } from "./handlers/identity"
import { operatorMemoryHandlers } from "./handlers/memory"
import { mergeHandlers } from "./handlers/merge"
import { operatorOverviewHandlers } from "./handlers/overview"
import { operatorProjectHandlers } from "./handlers/project"
import { operatorPromptProfileHandlers } from "./handlers/prompt-profile"
import { operatorPromptHandlers } from "./handlers/prompts"

// Handler layers for OperatorApi (per project) and OperatorRootApi (server-wide), provided by
// upstream's route assembly in one place each.
export const operatorHandlers = [
  mergeHandlers,
  operatorConfigHandlers,
  operatorProjectHandlers,
  operatorIdentityHandlers,
  operatorPromptHandlers,
  operatorMemoryHandlers,
] as const
export const operatorRootHandlers = [
  operatorOverviewHandlers,
  operatorFolderHandlers,
  operatorPromptProfileHandlers,
] as const
