import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useOperatorScope } from "./scope"

// The project a per-project operator page shows: the one in `?dir=`, or else the first open project.
export function useScopedProject() {
  const layout = useLayout()
  const scope = useOperatorScope()
  return createMemo(() => scope.directory() ?? layout.projects.list()[0]?.worktree)
}
