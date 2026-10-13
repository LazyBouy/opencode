import { useSearchParams } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { asList, useOperatorClient } from "./data"
import { useOperatorScope } from "./scope"

/** A project as the operator pages offer it: the console's record of a folder (specs/docs/issues/002). */
export type ProjectOption = { directory: string; id: string; name: string; namespace: string; label: string }

// The projects the operator pages offer: the Projects page's (the console's records, GET /operator/project-settings),
// and only the chosen namespace's when a page names one (`?ns=`). A folder OpenCode only knows from its database,
// or that is open in this browser's sidebar, is not a project. Each is labelled "name · id": the id is unique on
// the server, so two projects with one name never share a label.
export function useOperatorProjects() {
  const api = useOperatorClient()
  const [params] = useSearchParams<{ ns?: string }>()
  const settings = useQuery(() => ({
    queryKey: api.key("project-settings"),
    queryFn: () =>
      api
        .client()
        .operator.projectSettings.list()
        .then((result) => asList(result.data)),
  }))
  return createMemo<ProjectOption[]>(() =>
    projectOptions(settings.data ?? [], params.ns && params.ns !== "*" ? params.ns : undefined),
  )
}

/** The options for the console's projects (its records), only `namespace`'s when one is given. */
export function projectOptions(
  records: ReadonlyArray<{ key: string; id?: string; name: string; namespace: string }>,
  namespace?: string,
): ProjectOption[] {
  return records
    .filter((project) => !namespace || project.namespace === namespace)
    .map((project) => ({
      directory: project.key,
      id: project.id ?? "",
      name: project.name,
      namespace: project.namespace,
      label: project.id ? `${project.name} · ${project.id}` : project.name,
    }))
}

// The project a per-project operator page shows: the one in `?dir=`, else the one chosen last on any operator page
// (while it is still a project), else the first project. A link to a folder that isn't a project shows none (the
// scope picker says so).
export function useScopedProject() {
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  return createMemo(() => {
    const chosen = scope.directory()
    const list = projects()
    if (chosen && (!list.length || list.some((item) => item.directory === chosen))) return chosen
    if (scope.linked()) return undefined
    return list[0]?.directory
  })
}
