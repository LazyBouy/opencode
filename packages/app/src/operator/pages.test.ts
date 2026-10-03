import { describe, expect, test } from "bun:test"
import { isActivePage, operatorPages } from "./pages"

describe("operator pages", () => {
  const page = (id: string) => operatorPages.find((item) => item.id === id)!

  test("the dashboard is active only on /operator itself", () => {
    expect(isActivePage(page("dashboard"), "/operator")).toBe(true)
    expect(isActivePage(page("dashboard"), "/operator/")).toBe(true)
    expect(isActivePage(page("dashboard"), "/operator/agents")).toBe(false)
  })

  test("other pages stay active on their detail routes", () => {
    expect(isActivePage(page("agents"), "/operator/agents/build")).toBe(true)
    expect(isActivePage(page("agents"), "/operator/agentsx")).toBe(false)
  })

  test("every page lives under /operator with a unique id", () => {
    expect(new Set(operatorPages.map((item) => item.id)).size).toBe(operatorPages.length)
    expect(operatorPages.every((item) => item.path.startsWith("/operator"))).toBe(true)
  })
})
