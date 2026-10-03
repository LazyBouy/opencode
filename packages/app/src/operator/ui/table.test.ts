import { describe, expect, test } from "bun:test"
import { compareValues, filterRows, nextSort, sortRows } from "./table"

describe("operator table helpers", () => {
  test("compares numbers, dates and strings naturally, with missing values last", () => {
    expect(compareValues(2, 10)).toBeLessThan(0)
    expect(compareValues("item 2", "item 10")).toBeLessThan(0)
    expect(compareValues(new Date(1), new Date(2))).toBeLessThan(0)
    expect(compareValues(undefined, "a")).toBeGreaterThan(0)
    expect(compareValues(undefined, null)).toBe(0)
  })

  test("sorts in both directions and keeps missing values last", () => {
    const rows = [{ n: 2 }, { n: undefined }, { n: 10 }, { n: 1 }]
    const value = (row: { n?: number }) => row.n
    expect(sortRows(rows, { column: "n", direction: "asc" }, value).map((row) => row.n)).toEqual([1, 2, 10, undefined])
    expect(sortRows(rows, { column: "n", direction: "desc" }, value).map((row) => row.n)).toEqual([10, 2, 1, undefined])
    expect(sortRows(rows, undefined, value)).toEqual(rows)
  })

  test("filters by every search term, ignoring case", () => {
    const rows = ["Build agent", "Plan agent", "Explore"]
    expect(filterRows(rows, "AGENT pl", (row) => row)).toEqual(["Plan agent"])
    expect(filterRows(rows, "  ", (row) => row)).toEqual(rows)
  })

  test("header clicks cycle ascending, descending, then unsorted", () => {
    const first = nextSort(undefined, "name")
    const second = nextSort(first, "name")
    expect(first).toEqual({ column: "name", direction: "asc" })
    expect(second).toEqual({ column: "name", direction: "desc" })
    expect(nextSort(second, "name")).toBeUndefined()
    expect(nextSort(second, "age")).toEqual({ column: "age", direction: "asc" })
  })
})
