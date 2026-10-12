// Long lists (the user's rule, 2026-10-11): a list of more than LONG items can be searched, sorted A→Z or Z→A
// (alphanumerically: "model 2" before "model 10") and is shown a page at a time.

export const LONG = 10
export const PAGE_SIZES = [10, 25, 50] as const

export type Direction = "asc" | "desc"

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Alphanumeric order of two texts. */
export const compareText = (a: string, b: string) => collator.compare(a, b)

/** Whether a list is long: it gets search, sorting and pages. */
export const isLong = (count: number) => count > LONG

/** The items whose text holds every word of the query (case-insensitive). */
export function searchItems<T>(items: readonly T[], query: string, text: (item: T) => string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return [...items]
  return items.filter((item) => {
    const haystack = text(item).toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/** The items in alphanumeric order of their text. */
export function sortItems<T>(items: readonly T[], direction: Direction, text: (item: T) => string) {
  const sign = direction === "asc" ? 1 : -1
  return [...items].sort((a, b) => sign * compareText(text(a), text(b)))
}

export type Page<T> = {
  items: T[]
  /** Items after the search, on every page. */
  total: number
  pages: number
  /** The page shown, 0-based, kept within the pages there are. */
  page: number
  /** 1-based positions of the first and last item shown (0 and 0 when none). */
  from: number
  to: number
}

/** One page of the items: searched, then sorted (unless `sorted` is false: the caller's order), then cut. */
export function pageOf<T>(
  items: readonly T[],
  input: {
    text: (item: T) => string
    query?: string
    direction?: Direction
    sorted?: boolean
    page: number
    size: number
  },
): Page<T> {
  const found = searchItems(items, input.query ?? "", input.text)
  const ordered = input.sorted === false ? found : sortItems(found, input.direction ?? "asc", input.text)
  const pages = Math.max(1, Math.ceil(ordered.length / input.size))
  const page = Math.min(Math.max(0, input.page), pages - 1)
  const start = page * input.size
  const shown = ordered.slice(start, start + input.size)
  return {
    items: shown,
    total: ordered.length,
    pages,
    page,
    from: shown.length ? start + 1 : 0,
    to: start + shown.length,
  }
}
