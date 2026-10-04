import { describe, expect, test } from "bun:test"
import {
  allowedIn,
  type Catalog,
  copyName,
  defaultFor,
  goalOf,
  type Layer,
  move,
  overridesOf,
  profileGroups,
  profileProblem,
} from "./profile-model"

const layer = (fields: Partial<Layer> & Pick<Layer, "id" | "section">): Layer => ({
  name: fields.id,
  projects: "*",
  priority: 50,
  enabled: true,
  text: "",
  origin: "profile",
  ...fields,
})

const catalog: Catalog = {
  layers: [
    layer({ id: "role", section: "role" }),
    layer({ id: "goal", section: "purpose", purpose: "goal", projects: ["/repo"] }),
    layer({ id: "all", section: "base", overrides: "base.kimi" }),
    layer({ id: "here", section: "base", overrides: "base.kimi", projects: ["/repo"] }),
  ],
  groups: [
    { id: "p", name: "P", type: "purpose", projects: "*", layers: ["purpose.org", "purpose.goal"], builtin: true },
    { id: "r", name: "R", type: "role", projects: "*", layers: ["role"], builtin: false },
    { id: "i", name: "I", type: "identity", projects: "*", layers: ["slot.agent"], builtin: true },
    { id: "c", name: "C", type: "custom", projects: "*", layers: ["role"], builtin: false },
  ],
  profiles: [],
  defaults: { global: "x", projects: { "/repo": "x", "/other": "y" } },
  projects: [],
}

describe("prompt profile rules", () => {
  test("group types take the layers the server accepts", () => {
    expect(allowedIn("role", layer({ id: "a", section: "custom" }))).toBe(true)
    expect(allowedIn("platform", layer({ id: "a", section: "role" }))).toBe(false)
    expect(allowedIn("tool", layer({ id: "a", section: "tool" }))).toBe(true)
    expect(allowedIn("role", layer({ id: "a", section: "tool" }))).toBe(false)
    expect(allowedIn("output", layer({ id: "a", section: "generated" }))).toBe(true)
    expect(allowedIn("identity", layer({ id: "purpose.goal", section: "purpose" }))).toBe(false)
    expect(allowedIn("purpose", layer({ id: "purpose.goal", section: "purpose" }))).toBe(true)
    expect(allowedIn("custom", layer({ id: "a", section: "message" }))).toBe(false)
  })

  test("overrides list the project-scoped one first; goals and defaults are found", () => {
    expect(overridesOf(catalog, "base.kimi").map((item) => item.id)).toEqual(["here", "all"])
    expect(goalOf(catalog, "/repo")?.id).toBe("goal")
    expect(goalOf(catalog, "/other")).toBeUndefined()
    expect(defaultFor(catalog, "x")).toEqual(["global", "/repo"])
  })

  test("a profile's groups follow the spec order, and missing or repeated parts are reported", () => {
    expect(profileGroups(catalog, ["i", "c", "p", "r"])).toEqual(["p", "r", "i", "c"])
    expect(profileProblem(catalog, ["p", "i"])).toEqual({ kind: "required", type: "role" })
    expect(profileProblem(catalog, ["p", "r", "i", "c"])).toEqual({ kind: "repeated", layer: "role" })
    expect(profileProblem(catalog, ["p", "r", "i"])).toBeUndefined()
  })

  test("moving and copying", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"])
    expect(move(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"])
    expect(copyName("Default", ["Default copy"])).toBe("Default copy 2")
  })
})
