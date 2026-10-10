import { describe, expect, test } from "bun:test"
import { OperatorProfile } from "@/operator/profile"
import { OperatorPromptText } from "@/operator/prompt-text"
import { OperatorResolver as R } from "@/operator/resolver"
import { OperatorResolverBuiltins as B } from "@/operator/resolver-builtins"
import type { Provider } from "@/provider/provider"
import { SystemPrompt } from "@/session/system"
import { Skill } from "@/skill"

// OpenCode's Dynamic layers as resolvers give OpenCode's texts byte for byte
// (dynamic_layer_resolution_spec.md §4, §8). The prompt e2e test checks the same on real requests.

const P = OperatorProfile.PREFIX
const catalog = (fields: Partial<OperatorProfile.Catalog> = {}): OperatorProfile.Catalog => ({
  namespace: { id: "opencode", name: "OpenCode", purpose: "", createdAt: 0, updatedAt: 0 },
  types: [],
  layers: [],
  groups: [],
  profiles: [],
  ...fields,
})
const model = (providerID: string, id: string) => ({ providerID, id, api: { id } }) as unknown as Provider.Model
const assemble = (input: { model: Provider.Model; catalog?: OperatorProfile.Catalog; agent?: string }) =>
  OperatorProfile.assemble({
    catalog: input.catalog ?? catalog(),
    agent: { name: input.agent ?? "build" },
    model: input.model,
    parts: { environment: [], instructions: [], base: SystemPrompt.provider(input.model) },
  })

describe("the base prompt by model", () => {
  test("every family: the pipeline chooses the text upstream's rules choose", () => {
    for (const [providerID, id] of [
      ["anthropic", "claude-sonnet-4-5"],
      ["openai", "gpt-4o"],
      ["openai", "o3-mini"],
      ["openai", "gpt-5"],
      ["openai", "gpt-6-preview"],
      ["openai", "gpt-5-codex"],
      ["google", "gemini-2.5-pro"],
      ["moonshotai", "kimi-k2"],
      ["kimi-for-coding", "k2-turbo"],
      ["meta", "muse-spark-1"],
      ["meta", "muse-glimmer-1"],
      ["arcee", "Trinity-Large"],
      ["groq", "llama-3.3-70b"],
    ] as const) {
      const found = assemble({ model: model(providerID, id) })
      const section = found.sections.find((item) => item.layer === `${P}slot.agent-or-base`)
      expect({ id, text: section?.text, parity: section?.parity }).toEqual({
        id,
        text: SystemPrompt.provider(model(providerID, id))[0],
        parity: "same",
      })
      expect(section?.resolution?.candidates.find((item) => item.selected)?.name).toBe("Base prompt")
      const winner = section?.resolution?.inner?.candidates.find((item) => item.selected)
      expect(winner?.name).toBe(`base.${OperatorPromptText.baseFor(model(providerID, id)).id.slice("base.".length)}`)
    }
  })

  test("a profile's copy of a base prompt wins, and is not compared with upstream's", () => {
    const copy = {
      id: "gemini-copy",
      name: "base.gemini – copy",
      type: "identity",
      section: "base" as const,
      replaces: `${P}base.gemini`,
      text: "My Gemini prompt",
      origin: "user" as const,
    }
    const profile = {
      id: "mine",
      name: "Mine",
      group: `${P}group.opencode`,
      slots: { identity: ["gemini-copy"], dynamic: [`${P}slot.agent-or-base`] },
      builtin: false,
    }
    const found = assemble({
      model: model("google", "gemini-2.5-pro"),
      catalog: catalog({
        layers: [copy],
        profiles: [profile],
        namespace: {
          id: "opencode",
          name: "OpenCode",
          purpose: "",
          defaultProfile: "mine",
          createdAt: 0,
          updatedAt: 0,
        },
      }),
    })
    const section = found.sections.find((item) => item.layer === "gemini-copy" && item.type === "dynamic")
    expect(section?.text).toBe("My Gemini prompt")
    expect(section?.parity).toBeUndefined()
    expect(section?.resolution?.inner?.candidates.find((item) => item.selected)?.name).toBe("base.gemini – copy")
  })
})

describe("the per-request layers' templates", () => {
  test("Skills: as upstream formats them, escaped, without the denied ones; the empty text when none", () => {
    const list = [
      { name: "zeta", description: "Last", location: "/s/zeta/SKILL.md" },
      { name: "alpha", description: "First <a&b>", location: "/s/a&b/SKILL.md" },
      { name: "secret", description: "Hidden", location: "/s/secret/SKILL.md" },
      { name: "plain", location: "/s/plain/SKILL.md" },
    ]
    const header = [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
    ]
    const decide = (_permission: string, input: string) => (input === "secret" ? ("deny" as const) : ("allow" as const))
    const upstream = [
      ...header,
      Skill.fmt(list.filter((item) => item.name !== "secret") as Skill.Info[], { verbose: true }),
    ].join("\n")
    expect(R.run(B.RESOLVERS[B.SKILLS]!, B.skills(list), { decide }).text).toBe(upstream)
    expect(R.run(B.RESOLVERS[B.SKILLS]!, B.skills([]), { decide }).text).toBe(
      [...header, Skill.fmt([], { verbose: true })].join("\n"),
    )
    expect(R.run(B.RESOLVERS[B.SKILLS]!, B.skills(list), { off: "the agent may not use the skill tool" }).text).toBe("")
  })

  test("MCP instructions: each usable server, its lines indented, in the registry's order", () => {
    const text = R.run(
      B.RESOLVERS[B.MCP]!,
      B.mcp([
        { name: "docs", instructions: "Search the docs.\nCite pages.", usable: true },
        { name: "hidden", instructions: "Nope.", usable: false },
        { name: "empty", instructions: "", usable: true },
      ]),
    ).text
    expect(text).toBe(
      [
        "<mcp_instructions>",
        '  <server name="docs">',
        "    Search the docs.",
        "    Cite pages.",
        "  </server>",
        '  <server name="empty">',
        "    ",
        "  </server>",
        "</mcp_instructions>",
      ].join("\n"),
    )
  })

  test("References and Environment: upstream's layout", () => {
    const refs = R.run(
      B.RESOLVERS[B.REFERENCES]!,
      B.references([
        { name: "web", path: "/r/web", description: "The site" },
        { name: "api", path: "/r/api", description: "" },
        { name: "none", path: "/r/none" },
      ]),
    ).text
    expect(refs).toBe(
      [
        "Project references provide additional directories that can be accessed when relevant.",
        "<available_references>",
        "  <reference>",
        "    <name>api</name>",
        "    <path>/r/api</path>",
        "    <description></description>",
        "  </reference>",
        "  <reference>",
        "    <name>web</name>",
        "    <path>/r/web</path>",
        "    <description>The site</description>",
        "  </reference>",
        "</available_references>",
      ].join("\n"),
    )
    const env = R.run(
      B.RESOLVERS[B.ENVIRONMENT]!,
      B.environment({
        model: "m1",
        provider: "p",
        directory: "/w/x",
        worktree: "/w",
        git: true,
        platform: "linux",
        date: "Sat Oct 10 2026",
      }),
    ).text
    expect(env).toBe(
      [
        "You are powered by the model named m1. The exact model ID is p/m1",
        "Here is some useful information about the environment you are running in:",
        "<env>",
        "  Working directory: /w/x",
        "  Workspace root folder: /w",
        "  Is directory a git repo: yes",
        "  Platform: linux",
        "  Today's date: Sat Oct 10 2026",
        "</env>",
      ].join("\n"),
    )
  })
})
