import { useLanguage } from "@/context/language"
import { useNamespaces } from "../pages/profile-data"
import { ready } from "../data"
import { useConfirm } from "./confirm"
import { copyNeeded } from "./copy-needed"

// A write into a project's config (global_and_opencode_namespaces_spec.md §7.3). A project without a
// config of its own uses its namespace's; the first change saved from a project page gives it its own
// copy, which the server only makes when asked (`confirmCopy`). It refuses with this error until then:
// the app asks "Save as this project's own config?" and repeats the request with `confirmCopy`.

/**
 * Runs a write that may need the project's own copy of its namespace's config: on the server's refusal it
 * asks, and runs it again with `confirmCopy`. Resolves undefined when the user cancels.
 */
export function useProjectConfigWrite() {
  const confirm = useConfirm()
  const language = useLanguage()
  const namespaces = useNamespaces()
  const nameOf = (id: string) => ready(namespaces)?.find((item) => item.namespace.id === id)?.namespace.name ?? id
  return async <T,>(run: (confirmCopy?: "true") => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      const copy = copyNeeded(error)
      if (!copy) throw error
      const name = nameOf(copy.namespace)
      const ok = await confirm({
        title: language.t("operator.projectConfig.copyTitle"),
        description: language.t("operator.projectConfig.copyBody", { name, file: copy.file }),
        confirm: language.t("operator.projectConfig.copyConfirm"),
      })
      if (!ok) return undefined
      return run("true")
    }
  }
}
