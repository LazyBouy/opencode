import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode-ai/ui/icon"
import type { SelectV2Props } from "@opencode-ai/ui/v2/select-v2"
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ListSearch, Pager } from "./list-controls"
import { type Direction, LONG, pageOf } from "./paged"
import "./list-controls.css"

// A picker for a long list (more than 10 options; paged.ts): it opens a popover with a search box, A→Z / Z→A and
// pages of 10. Pinned options (an "Inherit" choice) stay first, outside the search, sort and pages. It takes
// SelectV2's props, so select.tsx can stand in for SelectV2 whatever the list's length.

export type ListPickerProps<T> = Pick<
  SelectV2Props<T>,
  "options" | "current" | "value" | "label" | "groupBy" | "placeholder" | "onSelect" | "disabled" | "appearance"
> & {
  "aria-label"?: string
  /** Options kept first and always shown. */
  pinned?: (option: T) => boolean
}

export function ListPicker<T>(props: ListPickerProps<T>) {
  const language = useLanguage()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [direction, setDirection] = createSignal<Direction>("asc")
  const [page, setPage] = createSignal(0)
  const keyOf = (option: T) => (props.value ? props.value(option) : String(option))
  const textOf = (option: T) => (props.label ? props.label(option) : String(option))
  // The option's text and its group's, for search and order.
  const searchText = (option: T) => `${textOf(option)} ${props.groupBy?.(option) ?? ""}`
  const pinned = createMemo(() => props.options.filter((option) => props.pinned?.(option)))
  const rest = createMemo(() => props.options.filter((option) => !props.pinned?.(option)))
  const shown = createMemo(() =>
    pageOf(rest(), { text: searchText, query: query(), direction: direction(), page: page(), size: LONG }),
  )
  const reset = () => {
    setQuery("")
    setPage(0)
  }
  const choose = (option: T) => {
    props.onSelect?.(option)
    setOpen(false)
    reset()
  }
  const current = () => (props.current === undefined ? undefined : keyOf(props.current))
  // Arrow keys move between the options; Enter or Space picks one (a button).
  const move = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const list = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]')
    const items = [...list]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = items[event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)]
    next?.focus()
    event.preventDefault()
  }
  const option = (item: T) => (
    <button
      type="button"
      role="option"
      aria-selected={current() === keyOf(item)}
      data-value={keyOf(item)}
      onClick={() => choose(item)}
    >
      <span>{textOf(item)}</span>
      <Show when={props.groupBy?.(item)}>{(group) => <span data-slot="list-picker-group">{group()}</span>}</Show>
    </button>
  )

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
      placement="bottom-start"
      gutter={4}
      flip
    >
      <div data-component="operator-list-picker" aria-label={props["aria-label"]}>
        <Popover.Trigger
          as="button"
          type="button"
          data-component="select-v2"
          data-appearance={props.appearance ?? "base"}
          data-slot="list-picker-trigger"
          disabled={props.disabled}
          data-disabled={props.disabled ? "" : undefined}
          aria-label={props["aria-label"]}
          aria-haspopup="listbox"
        >
          <div data-slot="select-v2-value">
            <span data-slot="select-v2-value-text">
              {props.current !== undefined ? textOf(props.current) : (props.placeholder ?? "")}
            </span>
          </div>
          <span data-slot="select-v2-chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content data-component="operator-list-picker-content" aria-label={props["aria-label"]}>
          <ListSearch
            label={language.t("operator.list.search", { what: props["aria-label"] ?? "" })}
            query={query()}
            onQuery={(value) => {
              setQuery(value)
              setPage(0)
            }}
            direction={direction()}
            onDirection={(value) => {
              setDirection(value)
              setPage(0)
            }}
            autofocus
          />
          <div role="listbox" id={id} aria-label={props["aria-label"]} onKeyDown={move}>
            <For each={pinned()}>{(item) => option(item)}</For>
            <For each={shown().items}>{(item) => option(item)}</For>
            <Show when={!shown().total}>
              <span data-slot="list-picker-empty">{language.t("operator.list.none")}</span>
            </Show>
          </div>
          <Pager page={shown()} onPage={setPage} />
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
