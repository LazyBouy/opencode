import { operatorConfigHandlers } from "./handlers/config"
import { mergeHandlers } from "./handlers/merge"

// Handler layers for OperatorApi, provided by upstream's instance route assembly in one place.
export const operatorHandlers = [mergeHandlers, operatorConfigHandlers] as const
