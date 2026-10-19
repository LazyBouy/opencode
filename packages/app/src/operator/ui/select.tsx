import { SelectV2 as Select, type SelectV2Props } from "@opencode-ai/ui/v2/select-v2"
import { Show, splitProps } from "solid-js"
import { ListPicker } from "./list-picker"
import { useOverlayFrame } from "./overlay-frame"
import { isLong } from "./paged"

// The operator pages' select: upstream's SelectV2 for a short list, the long-list picker (list-picker.tsx: search,
// A→Z / Z→A, pages of 10) once it has more than 10 options (the user's rule, 2026-10-11). Same props, plus
// `pinned` for options kept first (an "Inherit" choice), which don't count towards the length. Inside an overlay a
// short list is modal: its list opens outside the overlay's dialog, which would otherwise hide it from screen readers.

export type SelectProps<T> = SelectV2Props<T> & {
  "aria-label"?: string
  pinned?: (option: T) => boolean
  /** Shown when hovering an option (a project's or namespace's folder). */
  optionTitle?: (option: T) => string | undefined
}

export function SelectV2<T>(props: SelectProps<T>) {
  const [local, rest] = splitProps(props, ["pinned", "optionTitle"])
  const long = () => isLong(props.options.filter((option) => !local.pinned?.(option)).length)
  const inOverlay = !!useOverlayFrame()
  return (
    <Show
      when={long()}
      fallback={
        <Select<T>
          {...(inOverlay ? { modal: true } : {})}
          {...rest}
          {...(local.optionTitle
            ? {
                children: (option: T) => (
                  <span title={local.optionTitle!(option)}>{props.label ? props.label(option) : String(option)}</span>
                ),
              }
            : {})}
        />
      }
    >
      <ListPicker<T>
        options={props.options}
        current={props.current}
        value={props.value}
        label={props.label}
        groupBy={props.groupBy}
        placeholder={props.placeholder}
        onSelect={props.onSelect}
        disabled={props.disabled}
        appearance={props.appearance}
        aria-label={props["aria-label"]}
        pinned={local.pinned}
        optionTitle={local.optionTitle}
      />
    </Show>
  )
}
