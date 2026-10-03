import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { useLanguage } from "@/context/language"

export type Scope = "global" | "project"

// Chooses where a setting is written: the user's global config, or this project's .opencode config.
export function ScopeSwitch(props: { value: Scope; onChange: (scope: Scope) => void; projectDisabled?: boolean }) {
  const language = useLanguage()
  return (
    <SegmentedControlV2
      data-component="operator-scope-switch"
      aria-label={language.t("operator.scope.label")}
      value={props.value}
      onChange={(value) => {
        if (value === "global" || value === "project") props.onChange(value)
      }}
    >
      <SegmentedControlItemV2 value="global">{language.t("operator.scope.global")}</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="project" disabled={props.projectDisabled}>
        {language.t("operator.scope.project")}
      </SegmentedControlItemV2>
    </SegmentedControlV2>
  )
}
