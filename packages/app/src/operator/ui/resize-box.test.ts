import { describe, expect, test } from "bun:test"
import { MIN_HEIGHT, MIN_WIDTH, resized } from "./resize-box"

const start = { left: 100, top: 100, width: 600, height: 400 }
const view = { width: 1280, height: 800 }

describe("resizing an overlay", () => {
  test("an edge moves one side; a corner moves two", () => {
    expect(resized(start, "e", 50, 30, view)).toEqual({ left: 100, top: 100, width: 650, height: 400 })
    expect(resized(start, "s", 50, 30, view)).toEqual({ left: 100, top: 100, width: 600, height: 430 })
    expect(resized(start, "w", -40, 0, view)).toEqual({ left: 60, top: 100, width: 640, height: 400 })
    expect(resized(start, "n", 0, 20, view)).toEqual({ left: 100, top: 120, width: 600, height: 380 })
    expect(resized(start, "se", 50, 30, view)).toEqual({ left: 100, top: 100, width: 650, height: 430 })
    expect(resized(start, "nw", -20, -20, view)).toEqual({ left: 80, top: 80, width: 620, height: 420 })
  })

  test("it stays above the minimum size and inside the window", () => {
    expect(resized(start, "e", -1000, 0, view).width).toBe(MIN_WIDTH)
    expect(resized(start, "s", 0, -1000, view).height).toBe(MIN_HEIGHT)
    expect(resized(start, "w", 1000, 0, view)).toMatchObject({ left: 700 - MIN_WIDTH, width: MIN_WIDTH })
    expect(resized(start, "se", 5000, 5000, view)).toEqual({ left: 100, top: 100, width: 1172, height: 692 })
    expect(resized(start, "nw", -500, -500, view)).toMatchObject({ left: 8, top: 8 })
  })
})
