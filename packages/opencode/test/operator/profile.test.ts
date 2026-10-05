import { describe, expect, test } from "bun:test"
import { OperatorProfile } from "@/operator/profile"
import { OperatorPromptText } from "@/operator/prompt-text"

const P = OperatorProfile.PREFIX
const test_model = { providerID: "test", api: { id: "test-model" } }
const gemini = { providerID: "google", api: { id: "gemini-3-pro" } }
const DEFAULT_BASE = OperatorPromptText.BUILTINS.find((item) => item.id === "base.default")!.text
const GEMINI_BASE = OperatorPromptText.BUILTINS.find((item) => item.id === "base.gemini")!.text
const parts: OperatorProfile.Parts = {
  environment: ["<env>here</env>", "<available_references>refs</available_references>"],
  instructions: ["Instructions from: /work/AGENTS.md\nUse Bun."],
  mcp: "<mcp_instructions>docs</mcp_instructions>",
  skills: "<available_skills>release</available_skills>",
}

const namespace = (fields: Partial<OperatorProfile.Namespace> = {}): OperatorProfile.Namespace => ({
  id: "opencode",
  name: "OpenCode",
  purpose: "",
  createdAt: 0,
  updatedAt: 0,
  ...fields,
})
const catalog = (fields: Partial<OperatorProfile.Catalog> = {}): OperatorProfile.Catalog => ({
  namespace: namespace(),
  types: [],
  layers: [],
  groups: [],
  profiles: [],
  ...fields,
})
const layer = (fields: Partial<OperatorProfile.Layer> & Pick<OperatorProfile.Layer, "id" | "type">) =>
  ({
    name: fields.id,
    section: "custom",
    text: `text of ${fields.id}`,
    origin: "user",
    ...fields,
  }) as OperatorProfile.Layer
const assemble = (input: Partial<OperatorProfile.AssembleInput> = {}) =>
  OperatorProfile.assemble({ catalog: catalog(), agent: { name: "build" }, model: test_model, parts, ...input })

// What upstream sends: the agent's prompt or the base prompt, then the session's sections, then the
// message's own system text, joined with "\n" (session/llm/request.ts).
const upstream = (agentPrompt: string | undefined, model: OperatorPromptText.ModelRef, input: OperatorProfile.Parts) =>
  [
    agentPrompt || OperatorPromptText.builtinBase(model),
    ...input.environment,
    ...input.instructions,
    input.mcp,
    input.skills,
    input.output,
    input.user,
  ]
    .filter((text) => text)
    .join("\n")

describe("OpenCode profile", () => {
  test("gives upstream's system prompt for agents with and without a prompt, and with JSON answers", () => {
    expect(assemble().system).toEqual([upstream(undefined, test_model, parts)])
    expect(assemble({ agent: { name: "explore", prompt: "Explore." } }).system).toEqual([
      upstream("Explore.", test_model, parts),
    ])
    const json = { ...parts, output: OperatorPromptText.STRUCTURED_OUTPUT, user: "Answer briefly." }
    expect(assemble({ parts: json, model: gemini }).system).toEqual([upstream(undefined, gemini, json)])
  })

  test("the helper profiles give upstream's prompt for title, summary and compaction", () => {
    const bare = { environment: [], instructions: [], user: "From the user." }
    for (const name of ["title", "summary", "compaction"]) {
      const text = OperatorPromptText.BUILTINS.find((item) => item.id === `helper.${name}`)!.text
      const result = assemble({ agent: { name, prompt: text }, parts: bare })
      expect(result.profile).toMatchObject({ id: `${P}profile.helper.${name}`, source: "helper" })
      expect(result.system).toEqual([upstream(text, test_model, bare)])
    }
  })
})

describe("which profile an agent uses", () => {
  const mine: OperatorProfile.Profile = {
    id: "mine",
    name: "Mine",
    group: `${P}group.opencode`,
    slots: {},
    builtin: false,
  }
  const team: OperatorProfile.Profile = { ...mine, id: "team", name: "Team" }
  const loaded = catalog({ profiles: [mine, team], namespace: namespace({ defaultProfile: "team" }) })

  test("its own setting, the helper rule, the project default, then the namespace default", () => {
    const pick = (agent: string, setting?: OperatorProfile.AgentSetting, project?: OperatorProfile.ProjectSetting) =>
      OperatorProfile.profileFor(loaded, { agent, setting, project })
    expect(pick("build", { profile: "mine" })).toMatchObject({ profile: { id: "mine" }, source: "agent" })
    expect(pick("title", undefined, { namespace: "opencode", defaultProfile: "mine" })).toMatchObject({
      profile: { id: `${P}profile.helper.title` },
      source: "helper",
    })
    expect(pick("title", { profile: "mine" }).source).toBe("agent")
    expect(pick("build", undefined, { namespace: "opencode", defaultProfile: "mine" })).toMatchObject({
      profile: { id: "mine" },
      source: "project",
    })
    expect(pick("build")).toMatchObject({ profile: { id: "team" }, source: "namespace" })
    expect(OperatorProfile.profileFor(catalog(), { agent: "build" }).profile.id).toBe(OperatorProfile.OPENCODE_PROFILE)
  })
})

describe("assembly", () => {
  test("sections follow the group's order, then each slot's order, with a custom type in its place", () => {
    const custom: OperatorProfile.GroupType = { id: "rules", name: "House rules", description: "", builtin: false }
    const group: OperatorProfile.Group = {
      id: "g",
      name: "G",
      types: ["purpose", "rules", "role", "identity"],
      builtin: false,
    }
    const profile: OperatorProfile.Profile = {
      id: "p",
      name: "P",
      group: "g",
      slots: { rules: ["r2", "r1"], role: ["role"], identity: [`${P}slot.agent`] },
      builtin: false,
    }
    const loaded = catalog({
      types: [custom],
      groups: [group],
      profiles: [profile],
      layers: [
        layer({ id: "r1", type: "rules" }),
        layer({ id: "r2", type: "rules" }),
        layer({ id: "role", type: "role" }),
      ],
    })
    const result = assemble({ catalog: loaded, agent: { name: "build", prompt: "Build." }, setting: { profile: "p" } })
    expect(result.sections.map((item) => [item.typeName, item.layerName])).toEqual([
      ["House rules", "r2"],
      ["House rules", "r1"],
      ["Agent role", "role"],
      ["Agent identity", "Agent prompt"],
    ])
    expect(result.system).toEqual(["text of r2\ntext of r1\ntext of role\nBuild."])
  })

  test("the Spec profile puts the base prompt and the agent prompt in identity, then capabilities, then the rest", () => {
    const result = assemble({
      agent: { name: "explore", prompt: "Explore." },
      setting: { profile: `${P}profile.spec` },
    })
    expect(result.sections.map((item) => [item.layerName, item.source])).toEqual([
      ["Base prompt (by model)", "base.default"],
      ["Agent prompt", "explore"],
      ["MCP instructions", "generated"],
      ["Skills", "generated"],
      ["Environment", "generated"],
      ["References", "generated"],
      ["Instructions", "/work/AGENTS.md"],
    ])
  })

  test("Purpose is the namespace's purpose, then the project's Project Purpose, for every agent", () => {
    const purpose = layer({ id: "goal", type: "purpose", section: "purpose", text: "Ship the release." })
    const loaded = catalog({ namespace: namespace({ purpose: "We value care." }), layers: [purpose] })
    const project = { namespace: "opencode", purpose: "goal" }
    const result = assemble({ catalog: loaded, project, agent: { name: "build" } })
    expect(result.system[0]).toStartWith("We value care.\nShip the release.\n")
    expect(result.sections.filter((item) => item.automatic).map((item) => item.layer)).toEqual([
      `${P}purpose.org`,
      "goal",
    ])
    // A helper agent sends its helper text only.
    const title = OperatorPromptText.BUILTINS.find((item) => item.id === "helper.title")!.text
    const bare = { environment: [], instructions: [] }
    expect(assemble({ catalog: loaded, project, agent: { name: "title", prompt: title }, parts: bare }).system).toEqual(
      [upstream(title, test_model, bare)],
    )
    // An override cannot change it either.
    const dynamic = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === `${P}profile.opencode`)!.slots.dynamic!
    const changed = assemble({
      catalog: loaded,
      project,
      setting: { override: { slots: { dynamic: [`${P}slot.agent`, ...dynamic.slice(1)] } } },
      agent: { name: "build", prompt: "Mine." },
    })
    expect(changed.system).toEqual([`We value care.\nShip the release.\n${upstream("Mine.", test_model, parts)}`])
  })

  test("a copy of base.gemini changes Gemini's base prompt only, and only in a profile that holds it", () => {
    const copy = layer({
      id: "gem",
      type: "identity",
      section: "base",
      replaces: `${P}base.gemini`,
      text: "Gemini, be brief.",
    })
    const profile: OperatorProfile.Profile = {
      ...OperatorProfile.BUILTIN_PROFILES[0]!,
      id: "brief",
      slots: { ...OperatorProfile.BUILTIN_PROFILES[0]!.slots, identity: [`${P}slot.agent-or-base`, "gem"] },
      builtin: false,
    }
    const loaded = catalog({ layers: [copy], profiles: [profile] })
    const run = (model: OperatorPromptText.ModelRef, setting?: OperatorProfile.AgentSetting) =>
      assemble({ catalog: loaded, model, setting }).system[0]!
    expect(run(gemini, { profile: "brief" })).toStartWith("Gemini, be brief.\n")
    expect(run(gemini, { profile: "brief" })).not.toContain(GEMINI_BASE.slice(0, 50))
    expect(run(test_model, { profile: "brief" })).toStartWith(DEFAULT_BASE.slice(0, 50))
    expect(run(gemini)).toStartWith(GEMINI_BASE.slice(0, 50))
  })

  test("a tool description and a reminder come from copies in the profile's slots", () => {
    const bash = layer({
      id: "bash",
      type: "capabilities",
      section: "tool",
      replaces: `${P}tool.bash`,
      text: "Run commands.",
    })
    const plan = layer({
      id: "plan",
      type: "platform",
      section: "message",
      replaces: `${P}reminder.plan`,
      text: "Plan.",
    })
    const spec = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === `${P}profile.spec`)!
    const profile: OperatorProfile.Profile = {
      ...spec,
      id: "tools",
      slots: { ...spec.slots, capabilities: ["bash"], platform: ["plan"] },
      builtin: false,
    }
    const loaded = catalog({ layers: [bash, plan], profiles: [profile] })
    const slots = OperatorProfile.slotsFor(loaded, { agent: "build", setting: { profile: "tools" } })
    expect(OperatorProfile.versionOf({ catalog: loaded, slots, builtin: `${P}tool.bash` })).toBe("Run commands.")
    expect(OperatorProfile.versionOf({ catalog: loaded, slots, builtin: `${P}reminder.plan` })).toBe("Plan.")
    expect(OperatorProfile.versionOf({ catalog: loaded, slots, builtin: `${P}tool.read` })).toBeUndefined()
    const plain = OperatorProfile.slotsFor(loaded, { agent: "plan" })
    expect(OperatorProfile.versionOf({ catalog: loaded, slots: plain, builtin: `${P}tool.bash` })).toBeUndefined()
    // Neither adds system prompt text.
    expect(assemble({ catalog: loaded, setting: { profile: "tools" } }).system[0]).not.toContain("Run commands.")
  })
})

describe("override", () => {
  const role = (id: string) => layer({ id, type: "role", section: "role" })
  const profile = (slots: OperatorProfile.Slots): OperatorProfile.Profile => ({
    id: "p",
    name: "P",
    group: `${P}group.spec`,
    slots,
    builtin: false,
  })

  test("an override keeps its own slots and follows the profile's other slots", () => {
    const setting = { profile: "p", override: { slots: { role: ["mine"] } } }
    const before = catalog({ layers: [role("a"), role("mine")], profiles: [profile({ role: ["a"] })] })
    expect(assemble({ catalog: before, setting }).sections.find((item) => item.type === "role")).toMatchObject({
      layer: "mine",
      changed: true,
    })
    // The profile then changes role and identity: the agent keeps its role, and gets the new identity.
    const after = catalog({
      layers: [role("a"), role("b"), role("mine"), layer({ id: "voice", type: "identity" })],
      profiles: [profile({ role: ["b"], identity: ["voice"] })],
    })
    const result = assemble({ catalog: after, setting })
    expect(result.sections.map((item) => [item.layer, item.changed])).toEqual([
      ["mine", true],
      ["voice", false],
    ])
  })

  test("an override's group drops a type's slot and starts an added one empty", () => {
    const narrow: OperatorProfile.Group = {
      id: "narrow",
      name: "Narrow",
      types: ["purpose", "role", "identity"],
      builtin: false,
    }
    const loaded = catalog({
      groups: [narrow],
      layers: [role("a")],
      profiles: [profile({ role: ["a"], capabilities: [`${P}generated.skills`] })],
    })
    const result = assemble({ catalog: loaded, setting: { profile: "p", override: { group: "narrow" } } })
    expect(result.group.id).toBe("narrow")
    expect(result.sections.map((item) => item.layer)).toEqual(["a"])
  })
})

describe("save checks", () => {
  const loaded = catalog({
    types: [{ id: "rules", name: "House rules", description: "", builtin: false }],
    layers: [
      layer({ id: "role", type: "role" }),
      layer({ id: "gem1", type: "identity", replaces: `${P}base.gemini` }),
      layer({ id: "gem2", type: "identity", replaces: `${P}base.gemini` }),
      layer({ id: "goal", type: "purpose", section: "purpose" }),
    ],
  })

  test("groups need Purpose, Agent role and Agent identity, with no type twice", () => {
    expect(
      OperatorProfile.checkGroup(loaded, { name: "G", types: ["purpose", "role", "identity", "rules"] }),
    ).toBeUndefined()
    expect(OperatorProfile.checkGroup(loaded, { name: "G", types: ["purpose", "identity"] })).toContain("Agent role")
    expect(OperatorProfile.checkGroup(loaded, { name: "G", types: ["purpose", "role", "identity", "role"] })).toContain(
      "only once",
    )
    expect(OperatorProfile.checkGroup(loaded, { name: "G", types: ["purpose", "role", "identity", "nope"] })).toContain(
      "No group type",
    )
  })

  test("slots hold layers of their type, each once, one copy per built-in, nothing in Purpose", () => {
    const shape = (slots: OperatorProfile.Slots) =>
      OperatorProfile.checkSlots(loaded, { group: `${P}group.spec`, slots })
    expect(shape({ role: ["role"], identity: ["gem1"], dynamic: [`${P}slot.agent`] })).toBeUndefined()
    expect(shape({ identity: [`${P}slot.agent`] })).toContain("is Dynamic, not Agent identity")
    expect(shape({ identity: ["role"] })).toContain("not Agent identity")
    expect(shape({ role: ["role", "role"] })).toContain("more than once")
    expect(shape({ identity: ["gem1", "gem2"] })).toContain("one copy of base.gemini")
    expect(shape({ purpose: ["goal"] })).toContain("Purpose is automatic")
    expect(shape({ identity: [`${P}purpose.org`] })).toBeDefined()
    expect(shape({ capabilities: [`${P}tool.bash`] })).toBeUndefined()
  })

  test("a helper group holds only the Helper type, and a helper profile one helper layer", () => {
    expect(OperatorProfile.checkGroup(loaded, { name: "Helpers", types: ["helper"] })).toBeUndefined()
    expect(OperatorProfile.checkGroup(loaded, { name: "Mixed", types: ["helper", "role"] })).toContain(
      "holds no other type",
    )
    const helper = (slots: OperatorProfile.Slots) =>
      OperatorProfile.checkSlots(loaded, { group: `${P}group.helper`, slots })
    expect(helper({ helper: [`${P}helper.title`] })).toBeUndefined()
    expect(helper({ helper: [] })).toContain("one helper layer")
    expect(helper({ helper: [`${P}helper.title`, `${P}helper.summary`] })).toContain("one helper layer")
    expect(helper({ helper: [`${P}slot.agent`] })).toContain("not Helper")
  })

  test("profiles and overrides saved before the Dynamic type are read with it", () => {
    const old = { identity: [`${P}slot.agent-or-base`, "gem1"], additional: [`${P}generated.environment`] }
    expect(OperatorProfile.migrateSlots(old, ["purpose", "role", "identity", "dynamic", "additional"])).toEqual({
      identity: ["gem1"],
      additional: [],
      dynamic: [`${P}slot.agent-or-base`, `${P}generated.environment`],
    })
    expect(
      OperatorProfile.migrateGroup({
        id: "g",
        name: "G",
        types: ["purpose", "role", "identity", "output"],
        builtin: false,
      }).types,
    ).toEqual(["purpose", "role", "identity", "dynamic", "output"])
    expect(OperatorProfile.migrateSetting("title", { profile: `${P}profile.helper` })).toEqual({
      profile: `${P}profile.helper.title`,
    })
  })

  test("a copy keeps its built-in's type", () => {
    expect(OperatorProfile.checkLayer(loaded, { name: "x", type: "role", replaces: `${P}base.gemini` })).toContain(
      "keeps its type",
    )
    expect(OperatorProfile.checkLayer(loaded, { name: "x", type: "identity", replaces: `${P}slot.base` })).toContain(
      "not one of OpenCode's texts",
    )
    expect(OperatorProfile.checkLayer(loaded, { name: "x", type: "rules" })).toBeUndefined()
  })
})
