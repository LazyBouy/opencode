import { SelectV2 as Select, type SelectV2Props } from "@opencode-ai/ui/v2/select-v2"
import { Show, splitProps } from "solid-js"
import { ListPicker } from "./list-picker"
import { isLong } from "./paged"

// The operator pages' select: upstream's SelectV2 for a short list, the long-list picker (list-picker.tsx: search,
// A→Z / Z→A, pages of 10) once it has more than 10 options (the user's rule, 2026-10-11). Same props, plus
// `pinned` for options kept first (an "Inherit" choice), which don't count towards the length.

export type SelectProps<T> = SelectV2Props<T> & { "aria-label"?: string; pinned?: (option: T) => boolean }

export function SelectV2<T>(props: SelectProps<T>) {
  const [local, rest] = splitProps(props, ["pinned"])
  const long = () => isLong(props.options.filter((option) => !local.pinned?.(option)).length)
  return (
    <Show when={long()} fallback={<Select<T> {...rest} />}>
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
      />
    </Show>
  )
}
