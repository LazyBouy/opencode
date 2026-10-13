import { describe, expect, test } from "bun:test"
import type { OperatorConfigOption } from "@opencode-ai/sdk/v2/client"
import { groupsOf, setIn, shortValue } from "./config-reference-model"

const option = (path: string, description = path): OperatorConfigOption => ({
  path,
  group: path.split(".")[0]!.replace("[]", ""),
  type: "string",
  description,
  example: "{}",
})

describe("config reference", () => {
  const config = {
    small_model: "opencode/small",
    provider: { openai: { options: { baseURL: "https://x" } }, local: { name: "Local" } },
    experimental: { policies: [{ effect: "deny" }, { effect: "allow", action: "provider.use" }] },
  }

  test("finds where an option is set: keys of your choosing match any key, lists each item", () => {
    expect(setIn(config, "small_model")).toEqual([{ path: "small_model", value: "opencode/small" }])
    expect(setIn(config, "model")).toEqual([])
    expect(setIn(config, "provider.<id>.options.baseURL")).toEqual([
      { path: "provider.openai.options.baseURL", value: "https://x" },
    ])
    expect(setIn(config, "provider.<id>").map((item) => item.path)).toEqual(["provider.openai", "provider.local"])
    expect(setIn(config, "experimental.policies[].effect").map((item) => item.path)).toEqual([
      "experimental.policies[0].effect",
      "experimental.policies[1].effect",
    ])
    expect(setIn(config, "experimental.policies[].action")).toEqual([
      { path: "experimental.policies[1].action", value: "provider.use" },
    ])
    // A value that isn't an object stops the walk.
    expect(setIn(config, "small_model.x")).toEqual([])
  })

  test("groups by top-level key, searches paths and descriptions, and keeps only set options when asked", () => {
    const options = [
      option("provider"),
      option("provider.<id>.options.baseURL", "The URL its requests go to"),
      option("model"),
      option("small_model", "A cheaper model for titles"),
      option("agent.<name>.model"),
    ]
    const all = groupsOf(options, { query: "", filter: "all", config })
    expect(all.map((group) => group.key)).toEqual(["agent", "model", "provider", "small_model"])
    expect(all.find((group) => group.key === "provider")?.head?.path).toBe("provider")
    expect(all.find((group) => group.key === "provider")?.options.map((item) => item.path)).toEqual([
      "provider",
      "provider.<id>.options.baseURL",
    ])

    expect(groupsOf(options, { query: "cheaper", filter: "all", config }).map((group) => group.key)).toEqual([
      "small_model",
    ])
    expect(groupsOf(options, { query: "url", filter: "all", config })[0]?.options.map((item) => item.path)).toEqual([
      "provider.<id>.options.baseURL",
    ])
    const set = groupsOf(options, { query: "", filter: "set", config })
    expect(set.map((group) => group.key)).toEqual(["provider", "small_model"])
  })

  test("shows a value as one short line", () => {
    expect(shortValue("x")).toBe('"x"')
    expect(shortValue({ a: 1 })).toBe('{"a":1}')
    expect(shortValue("y".repeat(200), 10)).toBe(`"${"y".repeat(8)}…`)
  })
})
