import { type JSX, Show } from "solid-js"

// A labelled form control with optional help text. Text inputs sit inside a <label>; controls made
// of buttons (switches, segmented controls, editors) use a labelled group instead, because a label
// would name the first button inside it.
export function Field(props: { label: string; hint?: string; group?: boolean; children: JSX.Element }) {
  return (
    <div data-slot="operator-field">
      <Show
        when={props.group}
        fallback={
          <label data-slot="operator-field-control">
            <span data-slot="operator-field-label">{props.label}</span>
            {props.children}
          </label>
        }
      >
        <div role="group" aria-label={props.label} data-slot="operator-field-control">
          <span data-slot="operator-field-label" aria-hidden="true">
            {props.label}
          </span>
          {props.children}
        </div>
      </Show>
      <Show when={props.hint}>
        <span data-slot="operator-field-hint">{props.hint}</span>
      </Show>
    </div>
  )
}
