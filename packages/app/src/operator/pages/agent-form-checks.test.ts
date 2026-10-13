import { describe, expect, test } from "bun:test"
import {
  checkSteps,
  checkTemperature,
  checkTopP,
  hexOf,
  homeFolder,
  homeOf,
  hsvOf,
  isAnthropic,
  rgbOf,
  rgbOfHsv,
} from "./agent-form-checks"

describe("agent form checks", () => {
  test("temperature 0–2 (Anthropic above 1 warns), Top P above 0 up to 1, step limit a whole number ≥ 1", () => {
    expect(checkTemperature("", false)).toEqual({})
    expect(checkTemperature("2.5", false)).toEqual({ error: "temperatureRange" })
    expect(checkTemperature("abc", false)).toEqual({ error: "notNumber" })
    expect(checkTemperature("1.5", true)).toEqual({ warning: "temperatureAnthropic" })
    expect(checkTemperature("1.5", false)).toEqual({})
    expect(checkTopP("0")).toEqual({ error: "topPRange" })
    expect(checkTopP("1")).toEqual({})
    expect(checkTopP("0.9")).toEqual({})
    expect(checkSteps("0")).toEqual({ error: "stepsRange" })
    expect(checkSteps("2.5")).toEqual({ error: "stepsRange" })
    expect(checkSteps("12")).toEqual({})
    expect(isAnthropic("anthropic/claude-sonnet-4")).toBe(true)
    expect(isAnthropic("opencode/claude-opus-4-6")).toBe(true)
    expect(isAnthropic("openai/gpt-5")).toBe(false)
  })

  test("the home folder is stored relative to the project and never leaves it", () => {
    const project = "/work/app"
    expect(homeOf("agents/reviewer/", project)).toEqual({ home: "./agents/reviewer" })
    expect(homeOf("./agents/../notes", project)).toEqual({ home: "./notes" })
    expect(homeOf("", project)).toEqual({ home: "" })
    expect(homeOf("/work/app/agents/reviewer", project)).toEqual({ home: "./agents/reviewer" })
    expect(homeOf("/work/app", project)).toEqual({ home: "" })
    expect(homeOf("../x", project).error).toBe("homeUp")
    expect(homeOf("/etc", project).error).toBe("homeOutside")
    expect(homeOf("/work/application", project).error).toBe("homeOutside")
    expect(homeFolder("./agents/reviewer", project)).toBe("/work/app/agents/reviewer")
    expect(homeFolder("", project)).toBe("/work/app")
  })

  test("colours: hex and RGB and HSV agree", () => {
    expect(rgbOf("#FF6600")).toEqual({ r: 255, g: 102, b: 0 })
    expect(rgbOf("orange")).toBeUndefined()
    expect(hexOf({ r: 255, g: 102, b: 0 })).toBe("#FF6600")
    const hsv = hsvOf({ r: 255, g: 102, b: 0 })
    expect(Math.round(hsv.h)).toBe(24)
    expect(rgbOfHsv(hsv)).toEqual({ r: 255, g: 102, b: 0 })
    expect(rgbOfHsv({ h: 0, s: 0, v: 1 })).toEqual({ r: 255, g: 255, b: 255 })
  })
})
