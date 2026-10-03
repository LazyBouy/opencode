import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { displayName } from "@/pages/layout/helpers"
import { shortPath } from "../format"
import { useOperatorScope } from "../scope"

type Option = { directory?: string; label: string }

// Narrows an operator page to one project, or shows all of them.
export function ScopePicker() {
  const language = useLanguage()
  const layout = useLayout()
  const scope = useOperatorScope()
  // A project opened through the URL may not be in the open-project list; keep it selectable.
  const options = createMemo<Option[]>(() => {
    const open = layout.projects.list().map((project) => ({ directory: project.worktree, label: displayName(project) }))
    const current = scope.directory()
    return [
      { label: language.t("operator.scope.all") },
      ...open,
      ...(current && !open.some((option) => option.directory === current)
        ? [{ directory: current, label: shortPath(current) }]
        : []),
    ]
  })
  return (
    <SelectV2<Option>
      appearance="inline"
      aria-label={language.t("operator.scope.picker")}
      options={options()}
      current={options().find((option) => option.directory === scope.directory()) ?? options()[0]}
      value={(option) => option.directory ?? "*"}
      label={(option) => option.label}
      onSelect={(option) => scope.setDirectory(option?.directory)}
    />
  )
}
