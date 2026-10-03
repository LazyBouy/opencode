import { A, useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { useOperatorCommands } from "./commands"
import { SessionInspector } from "./inspector/inspector"
import { isActivePage, operatorPages } from "./pages"
import "./operator.css"

// The iphi-style left navigation: chat, the operator pages and settings. It is an icon rail by
// default on chat pages, to leave room for the conversation, and expanded on operator pages; each
// choice is remembered separately.
export function OperatorSidebar() {
  const language = useLanguage()
  const location = useLocation()
  const openSettings = useSettingsDialog()
  const [store, setStore] = persisted(
    Persist.global("operator.nav"),
    createStore({ collapsed: { chat: true, operator: false } }),
  )
  useOperatorCommands()

  const area = () => (location.pathname.startsWith("/operator") ? "operator" : "chat")
  const collapsed = () => store.collapsed[area()]
  const toggleLabel = () => (collapsed() ? language.t("operator.nav.expand") : language.t("operator.nav.collapse"))

  return (
    <nav
      data-component="operator-sidebar"
      data-collapsed={collapsed() ? "" : undefined}
      aria-label={language.t("operator.nav.label")}
    >
      <div data-slot="operator-sidebar-head">
        <span data-slot="operator-sidebar-brand" class="oc-display">
          {language.t("operator.nav.label")}
        </span>
        <button
          type="button"
          data-slot="operator-sidebar-toggle"
          aria-label={toggleLabel()}
          title={toggleLabel()}
          aria-expanded={!collapsed()}
          onClick={() => setStore("collapsed", area(), !collapsed())}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      <div data-slot="operator-sidebar-items">
        <A
          href="/"
          data-slot="operator-sidebar-item"
          data-active={location.pathname === "/" ? "" : undefined}
          title={language.t("operator.nav.chat")}
          end
        >
          <Icon name="speech-bubble" />
          <span data-slot="operator-sidebar-label">{language.t("operator.nav.chat")}</span>
        </A>
        <For each={operatorPages}>
          {(page) => (
            <A
              href={page.path}
              data-slot="operator-sidebar-item"
              data-page={page.id}
              data-active={isActivePage(page, location.pathname) ? "" : undefined}
              aria-current={isActivePage(page, location.pathname) ? "page" : undefined}
              title={language.t(`operator.page.${page.id}.title`)}
            >
              <Icon name={page.icon} />
              <span data-slot="operator-sidebar-label">{language.t(`operator.page.${page.id}.title`)}</span>
            </A>
          )}
        </For>
      </div>

      <SessionInspector />
      <div data-slot="operator-sidebar-footer">
        <button
          type="button"
          data-slot="operator-sidebar-item"
          title={language.t("operator.nav.settings")}
          onClick={() => openSettings()}
        >
          <Icon name="settings-gear" />
          <span data-slot="operator-sidebar-label">{language.t("operator.nav.settings")}</span>
        </button>
      </div>
    </nav>
  )
}
