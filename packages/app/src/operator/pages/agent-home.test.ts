import { describe, expect, test } from "bun:test"
import { homeFolder } from "./agent-home"

describe("an agent's home folder", () => {
  test("relative to its project, or absolute", () => {
    expect(homeFolder("/repo", "agents/docs/")).toBe("/repo/agents/docs")
    expect(homeFolder("/repo/", "./agents/../docs")).toBe("/repo/docs")
    expect(homeFolder("/repo", "/work/docs")).toBe("/work/docs")
  })
})
