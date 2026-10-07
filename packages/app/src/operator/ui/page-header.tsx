import { type JSX, type ParentProps, Show } from "solid-js"
import { usePageLabel } from "./overlay-nav"

// Title block at the top of every operator page; children render below it (usually page tabs).
export function PageHeader(props: ParentProps<{ title: string; description?: string; actions?: JSX.Element }>) {
  // The page's crumb on the back path.
  usePageLabel(() => props.title)
  return (
    <header data-component="operator-page-header">
      <div data-slot="operator-page-heading">
        <div data-slot="operator-page-copy">
          <h1 class="oc-display" data-slot="operator-page-title">
            {props.title}
          </h1>
          <Show when={props.description}>
            <p data-slot="operator-page-description">{props.description}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div data-slot="operator-page-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </header>
  )
}
