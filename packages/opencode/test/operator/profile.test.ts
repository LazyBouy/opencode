import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, test } from "bun:test"
import { OperatorProfile } from "@/operator/profile"
import { OperatorPromptText } from "@/operator/prompt-text"

const model = { providerID: "test", api: { id: "test-model" } }
const DEFAULT_BASE = OperatorPromptText.BUILTINS.find((item) => item.id === "base.default")!.text
const REPO = "/work/repo"
const on = { environment: true, skills: true, mcp: true }
const parts: OperatorProfile.Parts = {
  environment: ["<env>here</env>", "<available_references>refs</available_references>"],
  instructions: ["Instructions from: /work/repo/AGENTS.md\nUse Bun."],
  mcp: "<mcp_instructions>docs</mcp_instructions>",
  skills: "<available_skills>release</available_skills>",
}

const layer = (fields: Partial<OperatorProfile.Layer> & { id: string; section: OperatorProfile.Section }) =>
  ({
    name: fields.id,
    projects: "*",
    priority: 50,
    enabled: true,
    text: `text of ${fields.id}`,
    origin: "profile",
    ...fields,
  }) as OperatorProfile.Layer

const catalog = (fields: Partial<OperatorProfile.Catalog> = {}): OperatorProfile.Catalog => ({
  layers: [],
  groups: [],
  profiles: [],
  defaults: { projects: {} },
  ...fields,
})

const assemble = (
  input: Partial<OperatorProfile.AssembleInput> & { agent?: OperatorProfile.AssembleInput["agent"] } = {},
) =>
  OperatorProfile.assemble({
    catalog: catalog(),
    project: OperatorProfile.OPENCODE,
    agent: { name: "build" },
    model,
    parts,
    toggles: on,
    ...input,
  })

describe("scope", () => {
  test("a layer applies when it is on, in scope and for the agent", () => {
    const ctx = { project: REPO, agent: "build" }
    expect(OperatorProfile.applies(layer({ id: "a", section: "role" }), ctx)).toBe(true)
    expect(OperatorProfile.applies(layer({ id: "a", section: "role", enabled: false }), ctx)).toBe(false)
    expect(OperatorProfile.applies(layer({ id: "a", section: "role", projects: ["/other"] }), ctx)).toBe(false)
    expect(OperatorProfile.applies(layer({ id: "a", section: "role", agents: ["plan"] }), ctx)).toBe(false)
    expect(OperatorProfile.applies(layer({ id: "a", section: "role", agents: ["build"] }), ctx)).toBe(true)
  })

  test("the most specific override of a base prompt wins", () => {
    const all = layer({ id: "all", section: "base", overrides: "base", text: "all models, all projects" })
    const allHere = layer({ id: "all-here", section: "base", overrides: "base", projects: [REPO], text: "all here" })
    const family = layer({ id: "family", section: "base", overrides: "base.default", text: "family everywhere" })
    const familyHere = layer({
      id: "family-here",
      section: "base",
      overrides: "base.default",
      projects: [REPO],
      text: "family here",
    })
    const ctx = { project: REPO }
    const text = (layers: OperatorProfile.Layer[]) => OperatorProfile.baseText(layers, model, ctx).text
    expect(text([all, allHere, family, familyHere])).toBe("family here")
    expect(text([all, allHere, family])).toBe("family everywhere")
    expect(text([all, allHere])).toBe("all here")
    expect(text([all])).toBe("all models, all projects")
    expect(text([])).toBe(DEFAULT_BASE)
    expect(OperatorProfile.baseText([familyHere], model, { project: "/other" }).text).toBe(DEFAULT_BASE)
  })
})

describe("assembly", () => {
  test("the Default profile puts groups in spec order, in two system messages", () => {
    const identity = layer({ id: "voice", section: "identity", text: "Be brief." })
    const result = assemble({
      catalog: catalog({ layers: [identity] }),
      agent: { name: "explore", prompt: "Explore." },
    })

    expect(result.profile.id).toBe("default")
    expect(result.sections.map((item) => [item.groupName, item.layerName])).toEqual([
      ["Purpose", "base.default"],
      ["Identity", "voice"],
      ["Identity", "Agent prompt"],
      ["Capabilities", "MCP instructions"],
      ["Capabilities", "Skills"],
      ["Environment", "Environment"],
      ["Environment", "References"],
      ["Project instructions", "Instructions"],
    ])
    expect(result.system).toEqual([
      `${DEFAULT_BASE}\nBe brief.\nExplore.`,
      [parts.mcp, parts.skills, ...parts.environment, ...parts.instructions].join("\n"),
    ])
  })

  test("the message's own system text and unlabelled system text come last", () => {
    const result = assemble({ parts: { ...parts, user: "Answer in French.", extra: ["Extra."] } })
    expect(result.system[1]).toEndWith("Use Bun.\nExtra.\nAnswer in French.")
  })

  test("the structured-output notice is sent only when asked for", () => {
    expect(assemble().system.join("\n")).not.toContain("StructuredOutput")
    expect(assemble({ parts: { ...parts, output: OperatorPromptText.STRUCTURED_OUTPUT } }).system[1]).toEndWith(
      OperatorPromptText.STRUCTURED_OUTPUT,
    )
  })

  test("title, summary and compaction get the Helper profile", () => {
    const result = assemble({
      agent: { name: "title", prompt: "Write a title." },
      parts: { environment: [], instructions: [] },
    })
    expect(result.profile.id).toBe("helper")
    expect(result.system).toEqual([`${DEFAULT_BASE}\nWrite a title.`])
  })

  test("legacy switches still leave generated sections out", () => {
    const result = assemble({ toggles: { environment: false, skills: false, mcp: true } })
    expect(result.sections.map((item) => item.layerName)).toEqual(["base.default", "MCP instructions", "Instructions"])
  })

  test("layers longer than their limit are cut, and a layer is sent once", () => {
    const long = layer({ id: "long", section: "identity", text: "abcdef", maxLength: 3 })
    const group: OperatorProfile.PromptGroup = {
      id: "mine",
      name: "Mine",
      type: "identity",
      projects: "*",
      layers: ["long", "identity.shared"],
      builtin: false,
    }
    const profile: OperatorProfile.Profile = {
      id: "p",
      name: "P",
      projects: "*",
      groups: ["builtin.purpose", "builtin.role", "mine"],
      builtin: false,
    }
    const result = assemble({
      catalog: catalog({
        layers: [long],
        groups: [group],
        profiles: [profile],
        defaults: { global: "p", projects: {} },
      }),
    })
    expect(result.system).toEqual([`${DEFAULT_BASE}\nabc`])
  })
})

describe("purpose", () => {
  const org = layer({ id: "org", section: "purpose", purpose: "org", text: "We value care." })
  const goal = layer({ id: "goal", section: "purpose", purpose: "goal", projects: [REPO], text: "Ship the report." })

  test("org values and the project goal come first, even when a profile's Purpose group leaves them out", () => {
    const purpose: OperatorProfile.PromptGroup = {
      id: "bare",
      name: "Bare purpose",
      type: "purpose",
      projects: "*",
      layers: [],
      builtin: false,
    }
    const profile: OperatorProfile.Profile = {
      id: "bare",
      name: "Bare",
      projects: "*",
      groups: ["bare", "builtin.role", "builtin.helper-identity"],
      builtin: false,
    }
    const result = assemble({
      catalog: catalog({ layers: [org, goal], groups: [purpose], profiles: [profile] }),
      project: REPO,
      agent: { name: "triage", prompt: "Triage.", settings: { mode: "profile", profile: "bare" } },
    })
    expect(result.system).toEqual(["We value care.\nShip the report.\nTriage."])
    expect(result.sections.filter((item) => item.mandatory).map((item) => item.layer)).toEqual(["org", "goal"])
  })

  test("a project without a goal uses OpenCode's: the base prompt for the model", () => {
    const result = assemble({ catalog: catalog({ layers: [org, goal] }), project: "/other" })
    expect(result.system[0]).toBe(`We value care.\n${DEFAULT_BASE}`)
  })

  test("Full custom mode still sends Purpose", () => {
    const result = assemble({
      catalog: catalog({ layers: [org, goal] }),
      project: REPO,
      agent: { name: "triage", prompt: "Triage.", settings: { mode: "custom", generated: ["instructions"] } },
    })
    expect(result.profile.id).toBe("custom")
    expect(result.system).toEqual(["We value care.\nShip the report.\nTriage.", parts.instructions[0]])
  })

  test("Profile + layers adds the agent's layers to the end of a group", () => {
    const role = layer({ id: "role", section: "role", text: "You review drafts." })
    const result = assemble({
      catalog: catalog({ layers: [role] }),
      agent: { name: "build", settings: { mode: "layers", layers: [{ layer: "role", group: "builtin.role" }] } },
    })
    expect(result.system[0]).toBe(`${DEFAULT_BASE}\nYou review drafts.`)
  })
})

describe("profile choice", () => {
  const mine: OperatorProfile.Profile = {
    id: "mine",
    name: "Mine",
    projects: "*",
    groups: ["builtin.purpose", "builtin.role", "builtin.helper-identity"],
    builtin: false,
  }
  const here: OperatorProfile.Profile = { ...mine, id: "here", name: "Here", projects: [REPO] }

  test("the agent's profile, then the project's default, then the global default, then the built-in one", () => {
    const loaded = catalog({ profiles: [mine, here], defaults: { global: "mine", projects: { [REPO]: "here" } } })
    expect(OperatorProfile.profileFor(loaded, "build", { profile: "mine" }, REPO).id).toBe("mine")
    expect(OperatorProfile.profileFor(loaded, "build", undefined, REPO).id).toBe("here")
    expect(OperatorProfile.profileFor(loaded, "build", undefined, "/other").id).toBe("mine")
    expect(OperatorProfile.profileFor(catalog(), "build", undefined, REPO).id).toBe("default")
    expect(OperatorProfile.profileFor(catalog(), "compaction", undefined, REPO).id).toBe("helper")
    // A profile scoped to other projects is skipped.
    expect(OperatorProfile.profileFor(loaded, "build", { profile: "here" }, "/other").id).toBe("mine")
  })
})

describe("agent project", () => {
  const root = path.join(os.tmpdir(), `operator-profile-${process.pid}`)
  afterAll(() => fs.rm(root, { recursive: true, force: true }))

  test("built-in and global agents are OpenCode's; agents defined in a project are the project's", async () => {
    await fs.mkdir(path.join(root, ".opencode", "agent"), { recursive: true })
    await fs.writeFile(path.join(root, ".opencode", "agent", "triage.md"), "---\nmode: primary\n---\nTriage.\n")
    await fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ agent: { docs: { prompt: "Docs." } } }))
    const ctx = { directory: path.join(root, "src"), worktree: root }
    await fs.mkdir(ctx.directory, { recursive: true })

    expect(await OperatorProfile.agentProject({ name: "build", native: true }, ctx)).toBe(OperatorProfile.OPENCODE)
    expect(await OperatorProfile.agentProject({ name: "triage" }, ctx)).toBe(root)
    expect(await OperatorProfile.agentProject({ name: "docs" }, ctx)).toBe(root)
    expect(await OperatorProfile.agentProject({ name: "elsewhere" }, ctx)).toBe(OperatorProfile.OPENCODE)
    // A built-in agent that the project customizes is still OpenCode's.
    expect(await OperatorProfile.agentProject({ name: "triage", native: true }, ctx)).toBe(OperatorProfile.OPENCODE)
  })
})

describe("save checks", () => {
  const goal = layer({ id: "goal", section: "purpose", purpose: "goal", projects: [REPO] })

  test("a project has one goal, and OpenCode's goal is the base prompt", () => {
    const loaded = catalog({ layers: [goal] })
    expect(OperatorProfile.checkLayer(loaded, { ...goal, id: "second" })).toContain("already this project's goal")
    expect(OperatorProfile.checkLayer(loaded, goal)).toBeUndefined()
    expect(OperatorProfile.checkLayer(loaded, { ...goal, id: "x", projects: [OperatorProfile.OPENCODE] })).toContain(
      "Base Model Group",
    )
    expect(OperatorProfile.checkLayer(loaded, { ...goal, id: "x", projects: "*" })).toContain("exactly one project")
  })

  test("a project has one project-scoped override of each text, in the text's section", () => {
    const first = layer({ id: "first", section: "base", overrides: "base.kimi", projects: [REPO, "/b"] })
    const loaded = catalog({ layers: [first] })
    expect(
      OperatorProfile.checkLayer(
        loaded,
        layer({ id: "second", section: "base", overrides: "base.kimi", projects: ["/b"] }),
      ),
    ).toContain("already replaces")
    expect(
      OperatorProfile.checkLayer(loaded, layer({ id: "second", section: "base", overrides: "base.kimi" })),
    ).toBeUndefined()
    expect(
      OperatorProfile.checkLayer(loaded, layer({ id: "x", section: "message", overrides: "base.kimi" })),
    ).toContain("base section")
    expect(OperatorProfile.checkLayer(loaded, layer({ id: "x", section: "base", overrides: "nope" }))).toContain(
      "not one of OpenCode's texts",
    )
    expect(OperatorProfile.checkLayer(loaded, layer({ id: "x", section: "generated" }))).toContain("override one")
  })

  test("groups take only the layers their type allows", () => {
    const role = layer({ id: "role", section: "role" })
    const loaded = catalog({ layers: [role] })
    const group = (type: OperatorProfile.GroupType, layers: string[]): OperatorProfile.PromptGroup => ({
      id: "g",
      name: "G",
      type,
      projects: "*",
      layers,
      builtin: false,
    })
    expect(OperatorProfile.checkGroup(loaded, group("role", ["role", "slot.base"]))).toBeUndefined()
    expect(OperatorProfile.checkGroup(loaded, group("platform", ["role"]))).toContain("cannot go in")
    expect(OperatorProfile.checkGroup(loaded, group("capabilities", ["generated.skills"]))).toBeUndefined()
    expect(OperatorProfile.checkGroup(loaded, group("capabilities", ["role"]))).toContain("cannot go in")
    expect(OperatorProfile.checkGroup(loaded, group("tool", ["tool.read"]))).toBeUndefined()
    expect(OperatorProfile.checkGroup(loaded, group("role", ["reminder.plan"]))).toContain("cannot go in")
    expect(OperatorProfile.checkGroup(loaded, group("role", ["purpose.goal"]))).toContain("cannot go in")
    expect(OperatorProfile.checkGroup(loaded, group("role", ["role", "role"]))).toContain("only once")
    expect(OperatorProfile.checkGroup(loaded, group("role", ["missing"]))).toContain("No layer")
  })

  test("profiles need Purpose, Role and Identity, in spec order, with each layer once", () => {
    const profile = (groups: string[]): OperatorProfile.Profile => ({
      id: "p",
      name: "P",
      projects: "*",
      groups,
      builtin: false,
    })
    const extra: OperatorProfile.PromptGroup = {
      id: "again",
      name: "Again",
      type: "custom",
      projects: "*",
      layers: ["slot.agent"],
      builtin: false,
    }
    const loaded = catalog({ groups: [extra] })
    expect(
      OperatorProfile.checkProfile(loaded, profile(["builtin.purpose", "builtin.role", "builtin.helper-identity"])),
    ).toBeUndefined()
    expect(OperatorProfile.checkProfile(loaded, profile(["builtin.purpose", "builtin.identity"]))).toContain("role")
    expect(
      OperatorProfile.checkProfile(loaded, profile(["builtin.role", "builtin.purpose", "builtin.identity"])),
    ).toContain("order")
    expect(
      OperatorProfile.checkProfile(
        loaded,
        profile(["builtin.purpose", "builtin.role", "builtin.identity", "builtin.helper-identity"]),
      ),
    ).toContain("only one identity")
    expect(
      OperatorProfile.checkProfile(loaded, profile(["builtin.purpose", "builtin.role", "builtin.identity", "again"])),
    ).toContain("more than one group")
  })

  test("defaults name profiles that apply to the project", () => {
    const here: OperatorProfile.Profile = {
      id: "here",
      name: "Here",
      projects: [REPO],
      groups: ["builtin.purpose", "builtin.role", "builtin.identity"],
      builtin: false,
    }
    const loaded = catalog({ profiles: [here] })
    expect(OperatorProfile.checkDefaults(loaded, { global: "helper", projects: { [REPO]: "here" } })).toBeUndefined()
    expect(OperatorProfile.checkDefaults(loaded, { projects: { "/other": "here" } })).toContain("does not apply")
    expect(OperatorProfile.checkDefaults(loaded, { global: "nope", projects: {} })).toContain("No profile")
  })
})
