import { createUniqueId, type JSX, onMount, Show } from "solid-js"
import { FieldHelp } from "./field-help"

// A labelled form control. `hint` is the field's help, shown from the (i) beside the label (the
// field helper); `note` is status text under the control, such as a character count.
//
// A text input is named by the <label> (linked to it by id, so the (i) stays out of its name);
// controls made of buttons (switches, segmented controls, editors) are a group named by the label.
export function Field(props: {
  label: string
  hint: JSX.Element
  note?: JSX.Element
  group?: boolean
  children: JSX.Element
}) {
  const id = createUniqueId()
  let label: HTMLLabelElement | undefined
  let control: HTMLDivElement | undefined
  onMount(() => {
    if (props.group || !label || !control) return
    const target = control.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")
    if (!target) return
    if (!target.id) target.id = `${id}-control`
    label.htmlFor = target.id
  })
  return (
    <div data-slot="operator-field">
      <div data-slot="operator-field-head">
        <Show
          when={props.group}
          fallback={
            <label ref={label} data-slot="operator-field-label">
              {props.label}
            </label>
          }
        >
          <span id={id} data-slot="operator-field-label">
            {props.label}
          </span>
        </Show>
        <FieldHelp field={props.label} text={props.hint} />
      </div>
      <div
        ref={control}
        data-slot="operator-field-control"
        role={props.group ? "group" : undefined}
        aria-labelledby={props.group ? id : undefined}
      >
        {props.children}
      </div>
      <Show when={props.note}>
        <span data-slot="operator-field-hint">{props.note}</span>
      </Show>
    </div>
  )
}
