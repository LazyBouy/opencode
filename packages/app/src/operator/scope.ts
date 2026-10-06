import { useSearchParams } from "@solidjs/router"
import { createEffect, createSignal } from "solid-js"

// The project the operator pages are narrowed to. It is the viewer's choice, shared by every operator
// page and kept in this browser, until they change it: a page's project selector, or a link that names
// a project (`?dir=`), changes it. The URL keeps it too, so a page can be reloaded or shared.
const KEY = "opencode.projectScope"
// The choice "All projects" (project folders are absolute paths, so never this).
const ALL = "*"

function stored() {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    return undefined
  }
}

const [chosen, setChosen] = createSignal<string | undefined>(stored())

function remember(value: string) {
  setChosen(value)
  try {
    localStorage.setItem(KEY, value)
  } catch {
    // The choice still holds until the page reloads.
  }
}

// The project chosen last on any operator page, if one (not "All projects") was.
export function rememberedProject() {
  const value = chosen()
  return value && value !== ALL ? value : undefined
}

export function useRememberedProject() {
  return rememberedProject
}

// Undefined means all projects.
export function useOperatorScope() {
  const [params, setParams] = useSearchParams<{ dir?: string }>()
  createEffect(() => {
    if (params.dir && params.dir !== chosen()) remember(params.dir)
  })
  return {
    directory: () => params.dir || rememberedProject(),
    setDirectory: (directory: string | undefined) => {
      remember(directory ?? ALL)
      setParams({ dir: directory })
    },
  }
}
