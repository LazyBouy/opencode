import type { ParentProps } from "solid-js"
import "./operator.css"

// Scrolling page frame for every /operator route.
export function OperatorShell(props: ParentProps) {
  return (
    <div data-component="operator-shell">
      <div data-slot="operator-shell-content">{props.children}</div>
    </div>
  )
}
