import { describe, expect, test } from "bun:test"
import { maskSecrets, requestError } from "./config-helpers"

describe("config page helpers", () => {
  test("masks credential values at any depth, leaving the rest", () => {
    expect(
      maskSecrets({
        model: "anthropic/claude",
        provider: { openai: { options: { apiKey: "sk-123", baseURL: "https://x" } } },
        mcp: { docs: { headers: { Authorization: "Bearer t" } } },
        list: [{ token: "t" }],
        empty: { apiKey: "" },
      }),
    ).toEqual({
      model: "anthropic/claude",
      provider: { openai: { options: { apiKey: "••••••", baseURL: "https://x" } } },
      mcp: { docs: { headers: { Authorization: "••••••" } } },
      list: [{ token: "••••••" }],
      empty: { apiKey: "" },
    })
  })

  test("reads the message from an operator error body", () => {
    expect(requestError({ name: "OperatorConfigInvalidError", data: { path: "/x", message: "share: bad" } })).toBe(
      "share: bad",
    )
    expect(requestError(new Error("offline"))).toBe("offline")
  })
})
