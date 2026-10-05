import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import { useLanguage } from "@/context/language"
import { fieldHelp } from "../ui/field-help"

// Settings → General → Appearance: turns the field helper (the (i) next to every field) on or off.
export function FieldHelpSetting() {
  const language = useLanguage()
  return (
    <SettingsRowV2
      title={language.t("settings.general.row.fieldHelp.title")}
      description={language.t("settings.general.row.fieldHelp.description")}
    >
      <div data-action="settings-field-help">
        <Switch checked={fieldHelp.enabled()} onChange={fieldHelp.set} />
      </div>
    </SettingsRowV2>
  )
}
