import { describe, expect, test } from "bun:test"
import { sparklinePoints } from "./chart"

describe("sparklinePoints", () => {
  test("spans the box from the lowest to the highest value", () => {
    expect(sparklinePoints([0, 5, 10], 102, 22)).toBe("1,21 51,11 101,1")
  })

  test("draws a constant series through the middle and handles empty input", () => {
    expect(sparklinePoints([3, 3], 10, 10, 0)).toBe("0,5 10,5")
    expect(sparklinePoints([], 10, 10)).toBe("")
  })
})
