// The charts' pure rules (observability_spec.md §12.1, §17): stacking, which series a click lands on, and the table
// alternative's CSV.

export type Values = ReadonlyArray<number | null>

/** Running totals, bottom first: the top edge of each stacked series. A step where all are empty stays empty. */
export function stack(series: ReadonlyArray<Values>): Array<Array<number | null>> {
  const length = series[0]?.length ?? 0
  const out: Array<Array<number | null>> = []
  for (let index = 0; index < series.length; index++) {
    out.push(
      Array.from({ length }, (_, at) => {
        const below = index ? (out[index - 1]![at] ?? 0) : 0
        const value = series[index]![at]
        const any = series.slice(0, index + 1).some((values) => values[at] !== null && values[at] !== undefined)
        return any ? below + (value ?? 0) : null
      }),
    )
  }
  return out
}

/**
 * The series a click at value `y` lands on, at step `at`: in a stack, the lowest series whose top edge is at or above
 * `y`; for lines, the nearest value. -1 when the step has none.
 */
export function pick(series: ReadonlyArray<Values>, at: number, y: number, stacked: boolean): number {
  if (stacked) {
    const tops = stack(series)
    const found = tops.findIndex(
      (values, index) => values[at] !== null && values[at]! >= y && (series[index]![at] ?? 0) > 0,
    )
    if (found >= 0) return found
    // Above every bar: the top one with a value.
    for (let index = series.length - 1; index >= 0; index--) if ((series[index]![at] ?? 0) > 0) return index
    return -1
  }
  let best = -1
  let distance = Infinity
  series.forEach((values, index) => {
    const value = values[at]
    if (value === null || value === undefined) return
    const gap = Math.abs(value - y)
    if (gap < distance) {
      best = index
      distance = gap
    }
  })
  return best
}

const cell = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return ""
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Rows as CSV, with a header row. */
export function csv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string | number | null>>) {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n")
}

/** A step's start as an ISO time with its offset, for CSV and tooltips. */
export function isoLocal(time: number) {
  const date = new Date(time)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, "0")
  const local = new Date(time + offset * 60_000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}
