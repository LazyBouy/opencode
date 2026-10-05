import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { displayName } from "@/pages/layout/helpers"
import { useOperatorClient } from "./data"
import { useOperatorScope } from "./scope"

export type ProjectOption = { directory: string; label: string }

const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory

// Projects the operator pages can show: the ones open in this browser first, then every other
// project the server knows, and folders outside git registered as projects. The global project
// (sessions outside git, rooted at "/") is left out. Each is named by its name, else its folder's; two
// with the same name get their parent folder too.
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
  const settings = useQuery(() => ({
    queryKey: api.key("project-settings"),
    queryFn: () =>
      api
        .client()
        .operator.projectSettings.list()
        .then((result) => result.data ?? []),
  }))
  return createMemo<ProjectOption[]>(() => {
    const listed = new Map<string, string>()
    const add = (directory: string, name: string | undefined) => {
      if (directory === "/" || listed.has(directory)) return
      listed.set(directory, name || folderName(directory))
    }
    for (const project of layout.projects.list()) add(project.worktree, displayName(project))
    for (const project of known.data ?? []) add(project.worktree, project.name)
    for (const project of settings.data ?? []) if (project.registered) add(project.key, project.name)
    const names = [...listed.values()]
    return [...listed].map(([directory, name]) => ({
      directory,
      label:
        names.indexOf(name) === names.lastIndexOf(name)
          ? name
          : `${name} (${folderName(directory.slice(0, -folderName(directory).length - 1))})`,
    }))
  })
}

// The project a per-project operator page shows: the one in `?dir=`, or else the first project.
export function useScopedProject() {
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  return createMemo(() => scope.directory() ?? projects()[0]?.directory)
}
