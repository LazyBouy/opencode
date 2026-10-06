import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createSignal, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import "./field-help.css"

// The field helper: an (i) next to every field that shows help about it on hover or focus. It is a
// viewer's preference (Settings → General → Appearance → Field helper), kept in this browser.
const KEY = "opencode.fieldHelp"

function stored() {
  try {
    return localStorage.getItem(KEY) !== "off"
  } catch {
    return true
  }
}

const [enabled, setEnabled] = createSignal(stored())

export const fieldHelp = {
  enabled,
  set(value: boolean) {
    setEnabled(value)
    try {
      localStorage.setItem(KEY, value ? "on" : "off")
    } catch {
      // The choice still holds until the page reloads.
    }
  },
}

// The (i) for one field. `field` names the field for screen readers; `text` is the help.
export function FieldHelp(props: { field: string; text: JSX.Element | undefined }) {
  const language = useLanguage()
  return (
    <Show when={fieldHelp.enabled() && props.text}>
      <TooltipV2
        class="inline-flex operator-field-help"
        placement="top"
        openDelay={150}
        ignoreSafeArea={false}
        contentClass="field-help-content"
        value={props.text}
      >
        <button
          type="button"
          data-component="field-help"
          aria-label={language.t("operator.fieldHelp.about", { field: props.field })}
          onClick={(event) => event.preventDefault()}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
            <path d="M8 7.25V11.5" stroke="currentColor" stroke-linecap="round" />
            <circle cx="8" cy="5" r="0.75" fill="currentColor" />
          </svg>
        </button>
      </TooltipV2>
    </Show>
  )
}
