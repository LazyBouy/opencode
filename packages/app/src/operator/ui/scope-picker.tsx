import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorProjects, useScopedProject } from "../project"
import { useOperatorScope } from "../scope"
import { FieldHelp } from "./field-help"

type Option = { directory?: string; label: string }

// Chooses the project an operator page shows. Pages that work across projects pass `all` to offer
// "All projects"; the others always show one project.
export function ScopePicker(props: { all?: boolean }) {
  const language = useLanguage()
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  const scoped = useScopedProject()
  const selected = () => (props.all ? scope.directory() : scoped())
  // A project opened through the URL may not be listed; keep it selectable.
  const options = createMemo<Option[]>(() => {
    const listed: Option[] = projects()
    const current = selected()
    return [
      ...(props.all ? [{ label: language.t("operator.scope.all") }] : []),
      ...listed,
      ...(current && !listed.some((option) => option.directory === current)
        ? [{ directory: current, label: current.split(/[\\/]/).filter(Boolean).at(-1) ?? current }]
        : []),
    ]
  })
  return (
    <span class="inline-flex items-center">
      <SelectV2<Option>
        appearance="inline"
        aria-label={language.t("operator.scope.picker")}
        options={options()}
        current={options().find((option) => option.directory === selected()) ?? options()[0]}
        value={(option) => option.directory ?? "*"}
        label={(option) => option.label}
        onSelect={(option) => scope.setDirectory(option?.directory)}
      />
      <FieldHelp field={language.t("operator.scope.picker")} text={language.t("operator.help.scopePicker")} />
    </span>
  )
}
