import { operatorConfigHandlers } from "./handlers/config"
import { mergeHandlers } from "./handlers/merge"
import { operatorOverviewHandlers } from "./handlers/overview"
import { operatorProjectHandlers } from "./handlers/project"

// Handler layers for OperatorApi (per project) and OperatorRootApi (server-wide), provided by
// upstream's route assembly in one place each.
export const operatorHandlers = [mergeHandlers, operatorConfigHandlers, operatorProjectHandlers] as const
export const operatorRootHandlers = [operatorOverviewHandlers] as const
