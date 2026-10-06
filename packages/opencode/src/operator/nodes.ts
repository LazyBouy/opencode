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
import { OperatorProfileStore } from "./profile-store"
import { OperatorTrash } from "./trash"
import { OperatorTrashItems } from "./trash-items"
import { OperatorProjectSessions } from "./project-sessions"
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
  OperatorModels.node,
  OperatorTools.node,
  OperatorPrompts.node,
  OperatorFolders.node,
  OperatorMemory.node,
  OperatorProfileStore.node,
  OperatorProjectSessions.node,
  OperatorGenerate.node,
  OperatorHelperTexts.node,
  OperatorTrash.node,
  OperatorTrashItems.node,
] as const
