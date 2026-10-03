import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { displayName } from "@/pages/layout/helpers"
import { useOperatorClient } from "./data"
import { shortPath } from "./format"
import { useOperatorScope } from "./scope"

export type ProjectOption = { directory: string; label: string }

// Projects the operator pages can show: the ones open in this browser first, then every other
// project the server knows. The global project (sessions outside git, rooted at "/") is left out.
export function useOperatorProjects() {
  const layout = useLayout()
  const api = useOperatorClient()
  const known = useQuery(() => ({
    queryKey: api.key("projects"),
    queryFn: () =>
      api
        .client()
        .project.list()
        .then((result) => result.data ?? []),
    staleTime: 60_000,
  }))
  return createMemo<ProjectOption[]>(() => {
    const open = layout.projects.list().map((project) => ({ directory: project.worktree, label: displayName(project) }))
    const others = (known.data ?? [])
      .filter((project) => project.worktree !== "/" && !open.some((option) => option.directory === project.worktree))
      .map((project) => ({ directory: project.worktree, label: project.name || shortPath(project.worktree) }))
    return [...open, ...others]
  })
}

// The project a per-project operator page shows: the one in `?dir=`, or else the first project.
export function useScopedProject() {
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  return createMemo(() => scope.directory() ?? projects()[0]?.directory)
}
