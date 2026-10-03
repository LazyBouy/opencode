// Pure helpers behind DataTable: sorting, text filtering and column visibility.

export type SortDirection = "asc" | "desc"
export interface Sort {
  readonly column: string
  readonly direction: SortDirection
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

// Orders numbers, dates, booleans and strings naturally; missing values always sort last.
export function compareValues(a: unknown, b: unknown) {
  const aMissing = a === undefined || a === null || a === ""
  const bMissing = b === undefined || b === null || b === ""
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1
  if (typeof a === "number" && typeof b === "number") return a - b
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  return collator.compare(String(a), String(b))
}

export function sortRows<T>(rows: readonly T[], sort: Sort | undefined, value: (row: T, column: string) => unknown) {
  if (!sort) return [...rows]
  const sign = sort.direction === "asc" ? 1 : -1
  // Missing values stay last in both directions, so only present values are flipped.
  return [...rows].sort((a, b) => {
    const left = value(a, sort.column)
    const right = value(b, sort.column)
    const order = compareValues(left, right)
    const missing = [left, right].some((item) => item === undefined || item === null || item === "")
    return missing ? order : order * sign
  })
}

export function filterRows<T>(rows: readonly T[], query: string, text: (row: T) => string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...rows]
  return rows.filter((row) => {
    const haystack = text(row).toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

// Clicking a header cycles ascending → descending → unsorted.
export function nextSort(current: Sort | undefined, column: string): Sort | undefined {
  if (current?.column !== column) return { column, direction: "asc" }
  if (current.direction === "asc") return { column, direction: "desc" }
  return undefined
}
