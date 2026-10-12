import { describe, expect, test } from "bun:test"
import { isLong, pageOf, searchItems, sortItems } from "./paged"

const text = (item: string) => item
const names = Array.from({ length: 23 }, (_, index) => `model ${index + 1}`)

describe("long lists", () => {
  test("a list is long above 10 items", () => {
    expect(isLong(10)).toBe(false)
    expect(isLong(11)).toBe(true)
  })

  test("sorting is alphanumeric, either way", () => {
    expect(sortItems(["model 10", "Model 2", "model 1"], "asc", text)).toEqual(["model 1", "Model 2", "model 10"])
    expect(sortItems(["model 10", "Model 2", "model 1"], "desc", text)).toEqual(["model 10", "Model 2", "model 1"])
  })

  test("search keeps items holding every word", () => {
    expect(searchItems(["GPT-5 mini", "GPT-5", "Claude Haiku"], "gpt mini", text)).toEqual(["GPT-5 mini"])
  })

  test("pages of a size, kept within range, after search and sort", () => {
    const first = pageOf(names, { text, page: 0, size: 10 })
    expect(first).toMatchObject({ total: 23, pages: 3, page: 0, from: 1, to: 10 })
    expect(first.items[1]).toBe("model 2")
    const last = pageOf(names, { text, page: 9, size: 10 })
    expect(last).toMatchObject({ page: 2, from: 21, to: 23 })
    expect(last.items).toEqual(["model 21", "model 22", "model 23"])
    const desc = pageOf(names, { text, page: 0, size: 10, direction: "desc" })
    expect(desc.items[0]).toBe("model 23")
    const found = pageOf(names, { text, page: 2, size: 10, query: "model 2" })
    // Every word: "model" and "2" (model 2, 12, 20, 21, 22, 23); the page is kept within range.
    expect(found).toMatchObject({ total: 6, pages: 1, page: 0 })
    expect(pageOf([], { text, page: 0, size: 10 })).toMatchObject({ total: 0, pages: 1, from: 0, to: 0 })
    // The caller's order is kept when it isn't to be sorted.
    expect(pageOf(["b", "a"], { text, page: 0, size: 10, sorted: false }).items).toEqual(["b", "a"])
  })
})
