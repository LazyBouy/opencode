import { describe, expect, test } from "bun:test"
import { formatAgo, formatCost, formatCount, shortPath } from "./format"

describe("operator formatting", () => {
  test("money keeps cents, with more precision below a dollar", () => {
    expect(formatCost(12.5, "en")).toBe("$12.50")
    expect(formatCost(0.0123, "en")).toBe("$0.0123")
    expect(formatCost(0, "en")).toBe("$0.00")
  })

  test("large counts are compact", () => {
    expect(formatCount(950, "en")).toBe("950")
    expect(formatCount(12_345, "en")).toBe("12.3K")
  })

  test("times read as relative, and empty times as nothing", () => {
    expect(formatAgo(Date.now() - 2 * 60 * 60 * 1000, "en")).toBe("2 hours ago")
    expect(formatAgo(undefined, "en")).toBe("")
  })

  test("paths keep their last two segments", () => {
    expect(shortPath("/root/projects/phi/i-phi")).toBe("…/phi/i-phi")
    expect(shortPath("C:\\work\\app")).toBe("…/work/app")
    expect(shortPath("/work")).toBe("/work")
  })
})
