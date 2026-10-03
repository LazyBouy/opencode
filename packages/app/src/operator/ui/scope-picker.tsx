import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { displayName } from "@/pages/layout/helpers"
import { useOperatorScope } from "../scope"

type Option = { directory?: string; label: string }

// Narrows an operator page to one project, or shows all of them.
export function ScopePicker() {
  const language = useLanguage()
  const layout = useLayout()
  const scope = useOperatorScope()
  const options = createMemo<Option[]>(() => [
    { label: language.t("operator.scope.all") },
    ...layout.projects.list().map((project) => ({ directory: project.worktree, label: displayName(project) })),
  ])
  return (
    <SelectV2<Option>
      appearance="inline"
      aria-label={language.t("operator.scope.picker")}
      options={options()}
      current={options().find((option) => option.directory === scope.directory()) ?? options()[0]}
      value={(option) => option.directory ?? ""}
      label={(option) => option.label}
      onSelect={(option) => scope.setDirectory(option?.directory)}
    />
  )
}
