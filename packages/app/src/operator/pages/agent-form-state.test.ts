import { describe, expect, test } from "bun:test"
import { agentPatch, formFromSettings } from "./agent-form-state"

// Settings left undefined are not sent; compare what would be.
const sent = (value: unknown) => JSON.parse(JSON.stringify(value))

describe("agent form", () => {
  test("fills the form from an agent's own settings", () => {
    expect(
      formFromSettings("docs", { description: "Docs", mode: "subagent", temperature: 0.2, hidden: true, home: "/srv" }),
    ).toMatchObject({
      name: "docs",
      description: "Docs",
      mode: "subagent",
      temperature: "0.2",
      hidden: true,
      home: "/srv",
      model: "",
    })
  })

  test("a new agent sends only what was filled in", () => {
    const form = {
      ...formFromSettings("docs", {}),
      description: "Writes docs",
      temperature: "0.3",
      mode: "subagent" as const,
    }
    expect(sent(agentPatch(form, {}, { edit: "ask" }))).toEqual({
      description: "Writes docs",
      mode: "subagent",
      temperature: 0.3,
      permission: { edit: "ask" },
    })
  })

  test("clearing a setting that was set resets it; unchanged rules are not sent", () => {
    const before = { description: "Old", temperature: 0.1, permission: { bash: "ask" } }
    const form = { ...formFromSettings("docs", before), description: "", temperature: "" }
    expect(sent(agentPatch(form, before, { bash: "ask" }))).toEqual({ reset: ["description", "temperature"] })
    expect(agentPatch(form, before, {}).reset).toEqual(["description", "temperature", "permission"])
  })
})
