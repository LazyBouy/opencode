import { Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useLayout } from "@/context/layout"
import { SessionInspector } from "./inspector/inspector"
import { SessionViewSwitch } from "./session-views/switch"
import "./operator.css"

// The fork's controls in the session page's title bar, in a fixed order: Session details, an 8 px gap,
// then User | Detailed | Transcript. One container, portalled once: two portals into the same mount
// append in the order they mount, which changed with each session switch or page visit.
export function OperatorTitlebarControls() {
  const layout = useLayout()
  const rightMount = useTitlebarRightMount()
  return (
    <Show when={layout.route().type === "session" && rightMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div data-component="operator-titlebar-controls" data-testid="operator-titlebar-controls">
            <SessionInspector />
            <SessionViewSwitch />
          </div>
        </Portal>
      )}
    </Show>
  )
}
