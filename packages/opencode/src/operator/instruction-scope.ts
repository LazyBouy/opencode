export * as OperatorInstructionScope from "./instruction-scope"

import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { OperatorLayout } from "./layout"
import { OperatorNamespaceScope } from "./namespace-scope"

// Instruction files (AGENTS.md, CLAUDE.md, CONTEXT.md and config `instructions`) are a coding feature: they
// apply only to the projects of the OpenCode namespace, and of Global (with a blank working directory
// Global is OpenCode) (specs/docs/feedbacks/memory/memory_spec.md §7). Other namespaces' projects use their
// profile and `.memory`. Upstream's session/instruction.ts asks here in `system()` and `resolve()`; no
// service imports, because it is imported by upstream code.

/** Whether instruction files apply to a folder's project. */
export async function applies(directory: string, worktree: string) {
  const layer = await OperatorNamespaceScope.layerOf(directory, worktree)
  if (layer.namespace === OperatorLayout.OPENCODE) return true
  return OperatorLayout.isGlobal(layer.namespace, await OperatorLayout.snapshot())
}

/** The same for the current instance; when it can't tell, they apply (upstream's behaviour). */
export const here = () =>
  InstanceState.context.pipe(
    Effect.flatMap((ctx) => Effect.promise(() => applies(ctx.directory, ctx.worktree))),
    Effect.orElseSucceed(() => true),
  )

export const NOT_HERE = "instruction files apply only to the OpenCode namespace's projects"
