import { createEffect, createMemo, For, type JSX, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { ColumnPicker } from "./column-picker"
import { FieldHelp } from "./field-help"
import { ListSearch, Pager } from "./list-controls"
import { isLong, pageOf } from "./paged"
import { filterRows, nextSort, type Sort, sortRows } from "./table"

export interface Column<T> {
  readonly id: string
  readonly header: string
  /** Help about the column, shown by the field helper's (i) beside its header. */
  readonly help?: string
  readonly cell: (row: T) => JSX.Element
  /** The value used for sorting; columns without one are not sortable. */
  readonly value?: (row: T) => unknown
  readonly width?: string
  readonly align?: "start" | "end"
  /** An optional column: the viewer can add or remove it. Columns without this always show. */
  readonly optional?: boolean
  /** An optional column that is off until the viewer adds it. */
  readonly hidden?: boolean
}

export interface DataTableProps<T> {
  readonly label: string
  readonly rows: readonly T[]
  readonly columns: readonly Column<T>[]
  /** Where the viewer's choice of optional columns is kept; tables sharing it share the choice. */
  readonly columnsKey?: string
  readonly filter?: string
  readonly search?: (row: T) => string
  readonly initialSort?: Sort
  readonly loading?: boolean
  readonly empty?: JSX.Element
  readonly onRowClick?: (row: T) => void
  /** Sorted and paged by the server: rows show as given; a sortable header asks for `onSort`. */
  readonly server?: { readonly sort: Sort | undefined; readonly onSort: (sort: Sort | undefined) => void }
  /** Data attributes for a row (data-depth, …). */
  readonly rowAttrs?: (row: T) => Record<string, string | undefined>
  /** Told the ids of the columns shown, in order, whenever they change (an export of what is on screen). */
  readonly onColumns?: (ids: ReadonlyArray<string>) => void
  /** Shows these optional columns and hides the others when it changes (a saved view applied); the picker still works. */
  readonly applyColumns?: ReadonlyArray<string>
}

// Sortable, filterable table for operator pages. Rows open with a click or Enter when onRowClick is set.
// Optional columns can be added or removed from the picker at the end of the header row. More than 10 rows
// (paged.ts) are shown a page at a time, and get a search box when the page has no search of its own.
export function DataTable<T>(props: DataTableProps<T>) {
  const language = useLanguage()
  const [store, setStore] = createStore<{ sort?: Sort; query: string; page: number; size: number }>({
    sort: props.initialSort,
    query: "",
    page: 0,
    size: 10,
  })
  const fresh = createStore({ shown: {} as Record<string, boolean> })
  const [choice, setChoice] = props.columnsKey
    ? persisted(Persist.global(`operator.columns.${props.columnsKey}`), fresh)
    : fresh
  const visible = (column: Column<T>) => !column.optional || (choice.shown[column.id] ?? !column.hidden)
  const columns = createMemo(() => props.columns.filter(visible))
  createEffect(() => props.onColumns?.(columns().map((column) => column.id)))
  createEffect(
    on(
      () => props.applyColumns,
      (ids) => {
        if (!ids) return
        for (const column of props.columns) if (column.optional) setChoice("shown", column.id, ids.includes(column.id))
      },
    ),
  )
  const picker = () => !!props.columnsKey && props.columns.some((column) => column.optional)
  // A server that answers with an unexpected shape shows an empty table rather than breaking the page.
  const source = () => (Array.isArray(props.rows) ? props.rows : [])
  // The page's own search, else the table's (a long table on a page without one).
  const ownSearch = () => !props.server && props.filter === undefined && isLong(source().length)
  const sort = () => (props.server ? props.server.sort : store.sort)
  const textOf = (row: T) =>
    props.search
      ? props.search(row)
      : props.columns
          .map((column) => column.value?.(row))
          .filter((value) => value !== undefined && value !== null)
          .join(" ")
  const sorted = createMemo(() => {
    if (props.server) return source()
    const query = ownSearch() ? store.query : props.filter
    const filtered = query ? filterRows(source(), query, textOf) : source()
    return sortRows(filtered, store.sort, (row, id) => props.columns.find((column) => column.id === id)?.value?.(row))
  })
  const page = createMemo(() => pageOf(sorted(), { text: () => "", sorted: false, page: store.page, size: store.size }))
  const paged = () => !props.server && isLong(sorted().length)
  const rows = () => (paged() ? page().items : sorted())
  const direction = (column: Column<T>) => {
    if (sort()?.column !== column.id) return column.value ? "none" : undefined
    return sort()!.direction === "asc" ? "ascending" : "descending"
  }

  return (
    <div data-component="operator-table" aria-busy={props.loading ? "true" : undefined}>
      <Show when={ownSearch()}>
        <ListSearch
          label={language.t("operator.list.search", { what: props.label })}
          query={store.query}
          onQuery={(query) => setStore({ query, page: 0 })}
        />
      </Show>
      <table aria-label={props.label}>
        <thead>
          <tr>
            <For each={columns()}>
              {(column) => (
                <th
                  scope="col"
                  style={{ width: column.width }}
                  data-align={column.align ?? "start"}
                  aria-sort={direction(column)}
                >
                  <Show when={column.value} fallback={column.header}>
                    <button
                      type="button"
                      data-slot="operator-table-sort"
                      onClick={() =>
                        props.server
                          ? props.server.onSort(nextSort(sort(), column.id))
                          : setStore({ sort: nextSort(store.sort, column.id), page: 0 })
                      }
                    >
                      {column.header}
                      <span
                        data-slot="operator-table-sort-indicator"
                        data-direction={direction(column)}
                        aria-hidden="true"
                      />
                    </button>
                  </Show>
                  <Show when={column.help}>
                    <FieldHelp field={column.header} text={column.help} />
                  </Show>
                </th>
              )}
            </For>
            <Show when={picker()}>
              <th scope="col" data-slot="operator-table-picker">
                <ColumnPicker
                  label={props.label}
                  columns={props.columns}
                  visible={visible}
                  onChange={(id, shown) => setChoice("shown", id, shown)}
                />
              </th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr
                {...(props.rowAttrs?.(row) ?? {})}
                data-clickable={props.onRowClick ? "" : undefined}
                tabIndex={props.onRowClick ? 0 : undefined}
                onClick={() => {
                  // Dragging across a row selects its text to copy; only a plain click opens it.
                  if (window.getSelection()?.toString()) return
                  props.onRowClick?.(row)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !props.onRowClick) return
                  event.preventDefault()
                  props.onRowClick(row)
                }}
              >
                <For each={columns()}>
                  {(column) => <td data-align={column.align ?? "start"}>{column.cell(row)}</td>}
                </For>
                <Show when={picker()}>
                  <td data-slot="operator-table-picker" />
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={paged()}>
        <Pager
          page={page()}
          onPage={(next) => setStore("page", next)}
          size={store.size}
          onSize={(size) => setStore({ size, page: 0 })}
        />
      </Show>
      <Show when={rows().length === 0}>
        <div data-slot="operator-table-empty">
          <Show
            when={!props.loading}
            fallback={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}
          >
            {props.empty ?? language.t("operator.table.empty")}
          </Show>
        </div>
      </Show>
    </div>
  )
}
