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

  test("the model source: default sends no model, small sends the source, a pick sends the model", () => {
    expect(formFromSettings("a", {}).modelSource).toBe("default")
    expect(formFromSettings("a", { model: "openai/gpt-5" }).modelSource).toBe("pick")
    expect(formFromSettings("a", { model: "anthropic/haiku", modelSource: "small" }).modelSource).toBe("small")

    const picked = {
      ...formFromSettings("a", {}),
      modelSource: "pick" as const,
      model: "openai/gpt-5",
      variant: "high",
    }
    expect(sent(agentPatch(picked, {}, {}))).toEqual({ model: "openai/gpt-5", variant: "high" })
    // Small model: the server fills in `model`; the variant stays.
    const small = { ...picked, modelSource: "small" as const }
    expect(sent(agentPatch(small, { model: "openai/gpt-5" }, {}))).toEqual({ modelSource: "small", variant: "high" })
    // Back to the default model: model, source and variant go.
    const before = { model: "anthropic/haiku", modelSource: "small", variant: "high" }
    const back = { ...formFromSettings("a", before), modelSource: "default" as const }
    expect(agentPatch(back, before, {}).reset).toEqual(["model", "modelSource", "variant"])
    // Picking a model for a small agent drops the source.
    const pick = { ...formFromSettings("a", before), modelSource: "pick" as const, model: "openai/gpt-5" }
    expect(sent(agentPatch(pick, before, {}))).toEqual({
      model: "openai/gpt-5",
      variant: "high",
      reset: ["modelSource"],
    })
  })
})
