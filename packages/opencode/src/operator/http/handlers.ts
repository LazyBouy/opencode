import { operatorConfigHandlers } from "./handlers/config"
import { operatorIdentityHandlers } from "./handlers/identity"
import { mergeHandlers } from "./handlers/merge"
import { operatorOverviewHandlers } from "./handlers/overview"
import { operatorProjectHandlers } from "./handlers/project"
import { operatorPromptHandlers } from "./handlers/prompts"

// Handler layers for OperatorApi (per project) and OperatorRootApi (server-wide), provided by
// upstream's route assembly in one place each.
export const operatorHandlers = [
  mergeHandlers,
  operatorConfigHandlers,
  operatorProjectHandlers,
  operatorIdentityHandlers,
  operatorPromptHandlers,
] as const
export const operatorRootHandlers = [operatorOverviewHandlers] as const
