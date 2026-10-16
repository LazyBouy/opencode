import { createMemo, createSignal, For, Show } from "solid-js"
import type { Tone } from "./theme"
import "./charts.css"

// Ranked rows with inline bars (observability_spec.md §17), plain HTML and CSS: a split's top values and "Other",
// whose values can be shown, so nothing is dropped silently. A row can open Events.

export type BarRow = {
  key: string
  label: string
  value: number
  display: string
  tone?: Tone
  /** The values counted in this row (Other). */
  members?: ReadonlyArray<string>
}

export function BarList(props: {
  rows: ReadonlyArray<BarRow>
  label: string
  onOpen?: (row: BarRow) => void
  membersLabel?: (count: number) => string
}) {
  const max = createMemo(() => Math.max(1e-12, ...props.rows.map((row) => row.value)))
  const [open, setOpen] = createSignal(false)
  return (
    <ul data-component="operator-bar-list" aria-label={props.label}>
      <For each={props.rows}>
        {(row, index) => (
          <li>
            <Show when={props.onOpen} fallback={<span data-slot="operator-bar-list-label">{row.label}</span>}>
              <button type="button" data-slot="operator-bar-list-label" onClick={() => props.onOpen!(row)}>
                {row.label}
              </button>
            </Show>
            <span data-slot="operator-bar-list-track" aria-hidden="true">
              <span
                data-slot="operator-bar-list-bar"
                data-tone={row.tone ?? (row.key === "Other" ? "muted" : undefined)}
                data-color={row.tone || row.key === "Other" ? undefined : String(index() % 5)}
                style={{ width: `${(row.value / max()) * 100}%` }}
              />
            </span>
            <span data-slot="operator-bar-list-value">{row.display}</span>
            <Show when={row.members?.length}>
              <button type="button" data-slot="operator-link" aria-expanded={open()} onClick={() => setOpen(!open())}>
                {props.membersLabel?.(row.members!.length) ?? row.members!.length}
              </button>
              <Show when={open()}>
                <p data-slot="operator-note">{row.members!.map((member) => member || "—").join(", ")}</p>
              </Show>
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}
