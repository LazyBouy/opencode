import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { fullWindowBounds } from "../ui/full-window"
import "../ui/record-overlay.css"
import "./settings-maximize.css"

// Settings' Maximize: the Settings dialog fills the window below the title bar, as a record overlay's
// Full screen does, and Restore puts it back. Mounted once in upstream's Settings dialog (FORK.md); the
// choice is remembered in this browser.

const KEY = "opencode.operator.settings.maximized"
const remembered = () => {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(KEY, "1")
    else localStorage.removeItem(KEY)
  } catch {
    // not remembered
  }
}

export function SettingsMaximize() {
  const language = useLanguage()
  const [maximized, setMaximized] = createSignal(remembered())
  let button: HTMLSpanElement | undefined

  createEffect(() => {
    const container = button?.closest('[data-slot="dialog-container"]')
    if (!container) return
    const on = maximized()
    container.classList.toggle("operator-overlay-full", on)
    container.toggleAttribute("data-operator-maximized", on)
    if (on) onCleanup(fullWindowBounds())
  })

  const toggle = () => {
    const next = !maximized()
    setMaximized(next)
    remember(next)
  }

  return (
    <span ref={button} data-component="operator-settings-maximize">
      <IconButtonV2
        variant="ghost-muted"
        size="small"
        icon={<Icon name={maximized() ? "collapse" : "expand"} />}
        aria-label={language.t(maximized() ? "operator.settings.restore" : "operator.settings.maximize")}
        title={language.t(maximized() ? "operator.settings.restore" : "operator.settings.maximize")}
        aria-pressed={maximized()}
        data-action="settings-maximize"
        onClick={toggle}
      />
    </span>
  )
}
