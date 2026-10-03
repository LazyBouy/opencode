import { MergeAdapterRegistry } from "@/merge/adapter/registry"
import { MergeBinding } from "@/merge/binding"
import { OperatorConfig } from "./config"

// Services the fork's routes need, added to the server's service graph in one place.
export const operatorNodes = [MergeBinding.node, MergeAdapterRegistry.node, OperatorConfig.node] as const
