import { A, useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { usePageBadges } from "./alert-badge"
import { useOperatorCommands } from "./commands"
import { isChatPage, rememberChat, useOpenDefaultChat } from "./session-views/chat"
import { SessionViewCommands } from "./session-views/switch"
import { OperatorTitlebarControls } from "./titlebar-controls"
import { OnboardingGate } from "./onboarding"
import { ProjectGate } from "./project-gate"
import { useTrailKeeper } from "./ui/overlay-nav"
import { useResizableDialogs } from "./ui/resizable-dialogs"
import { isActivePage, operatorPages } from "./pages"
import "./operator.css"
import "./ui/selectable.css"

// The iphi-style left navigation: chat, the operator pages and settings. It is an icon rail by
// default on chat pages, to leave room for the conversation, and expanded on operator pages; each
// choice is remembered separately.
export function OperatorSidebar() {
  const language = useLanguage()
  const location = useLocation()
  const openSettings = useSettingsDialog()
  // A count on an item (§14.5 of the observability spec: firing alerts no one acknowledged).
  const badge = usePageBadges()
  const [store, setStore] = persisted(
    Persist.global("operator.nav"),
    createStore({ collapsed: { chat: true, operator: false } }),
  )
  useOperatorCommands()
  // The back path, and the questions before an edit is lost (ui/overlay-nav.ts).
  useTrailKeeper()
  // Every overlay box can be resized: edges and corners.
  useResizableDialogs()
  const openChat = useOpenDefaultChat()
  // Chats returns to the chat tab shown last.
  createEffect(() => rememberChat(location.pathname + location.search))

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
        {/* Chats: the chat window at the tab used last, else the default agent's main session (session-views/chat.ts). */}
        <A
          href="/"
          data-slot="operator-sidebar-item"
          data-active={location.pathname === "/" || isChatPage(location.pathname) ? "" : undefined}
          title={language.t("operator.nav.chatHint")}
          end
          onClick={(event) => {
            event.preventDefault()
            void openChat()
          }}
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
              <Show when={badge(page.id)}>
                {(count) => (
                  <span
                    data-slot="operator-sidebar-badge"
                    data-testid="operator-nav-badge"
                    aria-label={language.t("operator.nav.badge", { n: count() })}
                  >
                    {count()}
                  </span>
                )}
              </Show>
            </A>
          )}
        </For>
      </div>

      <SessionViewCommands />
      <OperatorTitlebarControls />
      <ProjectGate />
      <OnboardingGate />
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
