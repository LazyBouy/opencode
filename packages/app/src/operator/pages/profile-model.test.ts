import { describe, expect, test } from "bun:test"
import {
  textSize,
  type Catalog,
  copyName,
  copySlots,
  groupProblem,
  type Layer,
  layersOfType,
  move,
  moveTo,
  namespaceDefault,
  origin,
  profilesUsing,
  profileUsers,
  regroup,
  slotProblem,
} from "./profile-model"

const layer = (fields: Partial<Layer> & Pick<Layer, "id" | "type">): Layer => ({
  name: fields.id,
  section: "custom",
  text: "",
  origin: "user",
  ...fields,
})

const catalog: Catalog = {
  namespace: { id: "acme", name: "Acme", purpose: "", defaultProfile: "p1", createdAt: 0, updatedAt: 0 },
  types: [],
  layers: [
    layer({ id: "role", type: "role", section: "role" }),
    layer({ id: "voice", type: "identity", section: "identity" }),
    layer({ id: "gemini", type: "identity", section: "base", replaces: "opencode:base.gemini" }),
    layer({ id: "gemini2", type: "identity", section: "base", replaces: "opencode:base.gemini" }),
    layer({ id: "opencode:slot.agent", type: "identity", section: "identity", origin: "slot" }),
    layer({ id: "opencode:purpose.org", type: "purpose", section: "purpose", origin: "automatic" }),
  ],
  groups: [],
  profiles: [
    { id: "p1", name: "One", group: "g", slots: { role: ["role"], identity: ["voice"] }, builtin: false },
    { id: "p2", name: "Two", group: "g", slots: { identity: [] }, builtin: false },
  ],
  projects: [{ key: "/repo", name: "repo", namespace: "acme", defaultProfile: "p2" }],
  agents: [{ project: "/repo", name: "build", profile: "p1" }],
  resolvers: {},
  editableRules: [],
  helperRules: {
    sources: [{ kind: "helper", location: "prompt" }],
    filter: [],
    score: [],
    select: { policy: "one" },
    template: { item: "{text}", separator: "\n" },
  },
}

describe("profile model", () => {
  test("origin tells OpenCode's texts, copies and the namespace's own layers apart", () => {
    expect(origin(catalog.layers[0])).toBe("yours")
    expect(origin(catalog.layers[2])).toBe("copy")
    expect(origin(catalog.layers[4])).toBe("opencode")
  })

  test("a slot offers the layers of its type; Purpose offers none", () => {
    expect(layersOfType(catalog.layers, "identity").map((item) => item.id)).toEqual([
      "voice",
      "gemini",
      "gemini2",
      "opencode:slot.agent",
    ])
    expect(layersOfType(catalog.layers, "purpose")).toEqual([])
  })

  test("what uses a layer and a profile", () => {
    expect(profilesUsing(catalog, "voice").map((item) => item.id)).toEqual(["p1"])
    const one = profileUsers(catalog, "p1")
    expect(one.namespace).toBe(true)
    expect(one.agents.map((item) => item.name)).toEqual(["build"])
    expect(profileUsers(catalog, "p2").projects.map((item) => item.key)).toEqual(["/repo"])
    // Unset, it is OpenCode's profile: the namespace's own copy, or in OpenCode the built-in.
    const unset = { ...catalog, namespace: { ...catalog.namespace, defaultProfile: undefined } }
    expect(namespaceDefault(unset)).toBe("profile.opencode")
    expect(profileUsers(unset, "profile.opencode").namespace).toBe(true)
    const opencode = { ...unset, namespace: { ...unset.namespace, id: "opencode" } }
    expect(namespaceDefault(opencode)).toBe("opencode:profile.opencode")
  })

  test("regroup keeps slots of types the group has, in its order, and names the dropped ones", () => {
    const result = regroup({ role: ["role"], identity: ["voice"], output: ["x"], platform: [] }, [
      "purpose",
      "identity",
      "role",
    ])
    expect(result.slots).toEqual({ identity: ["voice"], role: ["role"] })
    expect(Object.keys(result.slots)).toEqual(["identity", "role"])
    expect(result.dropped).toEqual(["output"])
  })

  test("slots reject a layer twice and two copies of one text", () => {
    expect(slotProblem(catalog, { role: ["role"], identity: ["voice"] })).toBeUndefined()
    expect(slotProblem(catalog, { role: ["role"], identity: ["role"] })).toEqual({ kind: "repeated", layer: "role" })
    expect(slotProblem(catalog, { identity: ["gemini", "gemini2"] })).toEqual({
      kind: "copies",
      layer: "opencode:base.gemini",
    })
  })

  test("a group needs Purpose, Agent role and Agent identity, each type once", () => {
    expect(groupProblem(["purpose", "role", "identity", "output"])).toBeUndefined()
    expect(groupProblem(["purpose", "identity"])).toEqual({ kind: "required", type: "role" })
    expect(groupProblem(["purpose", "role", "identity", "role"])).toEqual({ kind: "repeated" })
  })

  test("moving items and naming copies", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"])
    expect(move(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"])
    expect(moveTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"])
    expect(copyName("Spec", ["Spec copy"])).toBe("Spec copy 2")
    const slots = { identity: ["voice"] }
    const copy = copySlots(slots)
    copy.identity!.push("rules")
    expect(slots.identity).toEqual(["voice"])
  })
})

describe("text size", () => {
  test("counts words, characters and estimated tokens", () => {
    expect(textSize("")).toEqual({ words: 0, tokens: 0, chars: 0 })
    expect(textSize("You are opencode.\n  An agent.")).toEqual({ words: 5, tokens: 8, chars: 29 })
  })
})
