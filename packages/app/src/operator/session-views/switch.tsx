import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { createMemo, For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { type SessionView, useSessionView, VIEWS } from "./view"
import "./session-views.css"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// User | Transcript | Detailed in the session page's title bar, and the same in the command palette.
// Mounted by the operator sidebar, so the session page itself only gains the views (see index.tsx).
export function SessionViewSwitch() {
  const layout = useLayout()
  const rightMount = useTitlebarRightMount()
  const language = useLanguage()
  const command = useCommand()
  const view = useSessionView()
  const onSession = createMemo(() => layout.route().type === "session")

  command.register("operator-session-views", () =>
    onSession()
      ? VIEWS.map((name) => ({
          id: `operator.view.${name}`,
          title: language.t(`operator.sessionViews.show.${name}` as Key),
          category: language.t("operator.command.category"),
          onSelect: () => view.set(name),
        }))
      : [],
  )

  return (
    <Show when={onSession() && rightMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <SegmentedControlV2
            class="operator-segmented-fit operator-view-switch"
            value={view.view()}
            onChange={(value) => value && view.set(value as SessionView)}
            aria-label={language.t("operator.sessionViews.label")}
            data-testid="session-view-switch"
          >
            <For each={VIEWS}>
              {(name) => (
                <SegmentedControlItemV2 value={name}>
                  {language.t(`operator.sessionViews.${name}` as Key)}
                </SegmentedControlItemV2>
              )}
            </For>
          </SegmentedControlV2>
        </Portal>
      )}
    </Show>
  )
}
