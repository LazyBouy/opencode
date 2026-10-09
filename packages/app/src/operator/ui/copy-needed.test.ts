import { describe, expect, test } from "bun:test"
import { copyNeeded } from "./copy-needed"

// The server refuses a project write that would copy its namespace's config without consent; the SDK
// throws that refusal as an Error with the response body as its cause.
const body = {
  name: "OperatorProjectConfigCopyNeededError",
  data: {
    message: "This project uses Acme's config.",
    project: "/p",
    namespace: "acme",
    file: "/p/.opencode/opencode.jsonc",
  },
}

describe("copyNeeded", () => {
  test("finds the refusal in the SDK's error, or as a plain body", () => {
    expect(copyNeeded(new Error("x", { cause: { body, status: 409 } }))).toEqual(body.data)
    expect(copyNeeded(body)).toEqual(body.data)
  })

  test("other errors are not a refusal", () => {
    expect(copyNeeded(new Error("x", { cause: { body: { name: "OperatorConfigInvalidError", data: {} } } }))).toBe(
      undefined,
    )
    expect(copyNeeded(new Error("network"))).toBeUndefined()
    expect(copyNeeded(undefined)).toBeUndefined()
  })
})
