import { MergeAdapterRegistry } from "@/merge/adapter/registry"
import { MergeBinding } from "@/merge/binding"
import { OperatorAgents } from "./agents"
import { OperatorConfig } from "./config"
import { OperatorFolders } from "./folders"
import { OperatorIdentity } from "./identity"
import { OperatorInbox } from "./inbox"
import { OperatorMemory } from "./memory"
import { OperatorOverview } from "./overview"
import { OperatorPrompts } from "./prompts"
import { OperatorTools } from "./tools"

// Services the fork's routes need, added to the server's service graph in one place.
export const operatorNodes = [
  MergeBinding.node,
  MergeAdapterRegistry.node,
  OperatorConfig.node,
  OperatorOverview.node,
  OperatorInbox.node,
  OperatorAgents.node,
  OperatorTools.node,
  OperatorIdentity.node,
  OperatorPrompts.node,
  OperatorFolders.node,
  OperatorMemory.node,
] as const
