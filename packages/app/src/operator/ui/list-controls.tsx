import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { type Direction, type Page, PAGE_SIZES } from "./paged"
import "./list-controls.css"

// The controls of a long list (paged.ts): a search box, A→Z / Z→A, and the pager below it.

export function ListSearch(props: {
  /** What is searched, for the box's name: "Search models". */
  label: string
  query: string
  onQuery: (query: string) => void
  direction?: Direction
  onDirection?: (direction: Direction) => void
  /** Focus the box when it appears (a picker's popover). */
  autofocus?: boolean
}) {
  const language = useLanguage()
  return (
    <div data-component="operator-list-controls">
      <TextInputV2
        type="search"
        appearance="base"
        class="operator-list-search"
        value={props.query}
        autofocus={props.autofocus}
        placeholder={props.label}
        aria-label={props.label}
        onInput={(event) => props.onQuery(event.currentTarget.value)}
      />
      <Show when={props.onDirection}>
        <ButtonV2
          size="small"
          variant="outline"
          data-testid="list-sort"
          aria-label={language.t(props.direction === "desc" ? "operator.list.sortedDesc" : "operator.list.sortedAsc")}
          onClick={() => props.onDirection?.(props.direction === "desc" ? "asc" : "desc")}
        >
          {props.direction === "desc" ? language.t("operator.list.desc") : language.t("operator.list.asc")}
        </ButtonV2>
      </Show>
    </div>
  )
}

export function Pager(props: {
  page: Page<unknown>
  onPage: (page: number) => void
  /** Page size, with a chooser when onSize is given. */
  size?: number
  onSize?: (size: number) => void
}) {
  const language = useLanguage()
  return (
    <Show when={props.page.total > 0 && (props.page.pages > 1 || props.onSize)}>
      <div data-component="operator-pager" data-testid="pager">
        <span data-slot="operator-pager-range">
          {language.t("operator.list.range", {
            from: props.page.from,
            to: props.page.to,
            total: props.page.total,
          })}
        </span>
        <Show when={props.onSize}>
          <label data-slot="operator-pager-size">
            {language.t("operator.list.perPage")}
            <select
              value={props.size}
              onChange={(event) => props.onSize?.(Number(event.currentTarget.value))}
              aria-label={language.t("operator.list.perPage")}
            >
              <For each={[...PAGE_SIZES]}>{(size) => <option value={size}>{size}</option>}</For>
            </select>
          </label>
        </Show>
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          aria-label={language.t("operator.list.previous")}
          disabled={props.page.page === 0}
          icon={<Icon name="chevron-left" />}
          onClick={() => props.onPage(props.page.page - 1)}
        />
        <span data-slot="operator-pager-page">
          {language.t("operator.list.page", { page: props.page.page + 1, pages: props.page.pages })}
        </span>
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          aria-label={language.t("operator.list.next")}
          disabled={props.page.page >= props.page.pages - 1}
          icon={<Icon name="chevron-right" />}
          onClick={() => props.onPage(props.page.page + 1)}
        />
      </div>
    </Show>
  )
}
