import { createMemo, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { filterRows, nextSort, type Sort, sortRows } from "./table"

export interface Column<T> {
  readonly id: string
  readonly header: string
  readonly cell: (row: T) => JSX.Element
  /** The value used for sorting; columns without one are not sortable. */
  readonly value?: (row: T) => unknown
  readonly width?: string
  readonly align?: "start" | "end"
}

export interface DataTableProps<T> {
  readonly label: string
  readonly rows: readonly T[]
  readonly columns: readonly Column<T>[]
  readonly hidden?: readonly string[]
  readonly filter?: string
  readonly search?: (row: T) => string
  readonly initialSort?: Sort
  readonly loading?: boolean
  readonly empty?: JSX.Element
  readonly onRowClick?: (row: T) => void
}

// Sortable, filterable table for operator pages. Rows open with a click or Enter when onRowClick is set.
export function DataTable<T>(props: DataTableProps<T>) {
  const language = useLanguage()
  const [store, setStore] = createStore<{ sort?: Sort }>({ sort: props.initialSort })
  const columns = createMemo(() => props.columns.filter((column) => !props.hidden?.includes(column.id)))
  const rows = createMemo(() => {
    // A server that answers with an unexpected shape shows an empty table rather than breaking the page.
    const source = Array.isArray(props.rows) ? props.rows : []
    const search = props.search
    const filtered = search && props.filter ? filterRows(source, props.filter, search) : source
    return sortRows(filtered, store.sort, (row, id) => props.columns.find((column) => column.id === id)?.value?.(row))
  })
  const direction = (column: Column<T>) => {
    if (store.sort?.column !== column.id) return column.value ? "none" : undefined
    return store.sort.direction === "asc" ? "ascending" : "descending"
  }

  return (
    <div data-component="operator-table" aria-busy={props.loading ? "true" : undefined}>
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
                      onClick={() => setStore("sort", nextSort(store.sort, column.id))}
                    >
                      {column.header}
                      <span
                        data-slot="operator-table-sort-indicator"
                        data-direction={direction(column)}
                        aria-hidden="true"
                      />
                    </button>
                  </Show>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr
                data-clickable={props.onRowClick ? "" : undefined}
                tabIndex={props.onRowClick ? 0 : undefined}
                onClick={() => props.onRowClick?.(row)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !props.onRowClick) return
                  event.preventDefault()
                  props.onRowClick(row)
                }}
              >
                <For each={columns()}>
                  {(column) => <td data-align={column.align ?? "start"}>{column.cell(row)}</td>}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
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
