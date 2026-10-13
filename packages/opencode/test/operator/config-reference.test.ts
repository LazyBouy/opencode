import { describe, expect, test } from "bun:test"
import { ConfigForkV1 } from "@opencode-ai/core/v1/config/fork"
import { OperatorConfigReference } from "../../src/operator/config-reference"
import { Server } from "../../src/server/server"

// The Config page's reference (specs/docs/issues/003): every option of the config schema, the fork's keys
// included, each with a description. After an upstream merge, an option upstream added without one fails here
// until it gets its text in src/operator/config-texts.ts.

describe("config reference", () => {
  test("every option has a description, from the schema or the fork's texts", () => {
    const entries = OperatorConfigReference.entries()
    expect(entries.length).toBeGreaterThan(300)
    const missing = entries.filter((entry) => !entry.description.trim()).map((entry) => entry.path)
    expect(missing).toEqual([])
    // Paths are unique.
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length)
  })

  test("GET /operator/config/reference lists nested keys, the fork's keys and deprecated ones", async () => {
    const response = await Server.Default().app.request("/operator/config/reference")
    expect(response.status).toBe(200)
    const entries = (await response.json()) as OperatorConfigReference.Entry[]
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    for (const path of [
      "provider.<id>.options",
      "provider.<id>.options.baseURL",
      "provider.<id>.models.<model>.limit.context",
      "agent.<name>.permission",
      "agent.<name>.model",
      "mcp.<name>",
      "small_model",
    ])
      expect(byPath.has(path)).toBe(true)

    // The console's own keys, marked as such.
    for (const key of Object.keys(ConfigForkV1.fields)) expect(byPath.get(key)?.fork).toBe(true)
    for (const key of Object.keys(ConfigForkV1.agentFields)) expect(byPath.get(`agent.<name>.${key}`)?.fork).toBe(true)
    expect(byPath.get("model")?.fork).toBeUndefined()

    // Deprecated options say so; a value list, a default and an example where the schema has them.
    expect(byPath.get("mode")?.deprecated).toBeDefined()
    expect(byPath.get("share")?.values).toEqual(['"manual"', '"auto"', '"disabled"'])
    expect(byPath.get("small_model")?.example).toContain('"small_model"')
    expect(byPath.get("provider")?.docs).toBe("https://opencode.ai/docs/providers")
  })
})
