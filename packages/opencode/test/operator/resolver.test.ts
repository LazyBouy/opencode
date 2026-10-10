import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OperatorResolutions } from "@/operator/resolutions"
import { OperatorResolver as R } from "@/operator/resolver"

// The resolution pipeline's core (dynamic_layer_resolution_spec.md §2–§5): sources' candidates through
// filter, score, select and render, with a trace of every candidate; per-session reuse.

const resolver = (input: Partial<R.Resolver> & Pick<R.Resolver, "sources">): R.Resolver => ({
  filter: [{ kind: "available", need: "text" }],
  score: [],
  select: { policy: "all" },
  template: { item: "{text}", separator: "\n" },
  ...input,
})

// Instructions as OpenCode chooses them: the first existing of the global files; the first name with any
// match from the folder up (all its matches); then config's files. An empty file stays chosen, renders
// nothing.
const instructions = resolver({
  sources: [
    { kind: "file", location: "~/.config/opencode/AGENTS.md", group: "global", name: "AGENTS.md" },
    { kind: "file", location: "~/.claude/CLAUDE.md", group: "global", name: "CLAUDE.md" },
    { kind: "file", location: "AGENTS.md", group: "project", name: "AGENTS.md" },
    { kind: "file", location: "CLAUDE.md", group: "project", name: "CLAUDE.md" },
    { kind: "file", location: "CONTEXT.md", group: "project", name: "CONTEXT.md" },
    { kind: "config", location: "instructions", group: "config" },
  ],
  filter: [{ kind: "available", need: "exists" }],
  score: [{ kind: "precedence", attribute: "name", order: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"], weight: 10 }],
  select: { policy: "one", per: { config: "all" }, unique: "path", groups: ["global", "project", "config"] },
  template: { item: "Instructions from: {path}\n{text}", separator: "\n" },
})

describe("the pipeline", () => {
  test("Instructions: one per group (all files of the winning name), losers traced, empties render nothing", () => {
    const { text, trace } = R.run(instructions, [
      { source: 0, location: "/g/AGENTS.md", reason: "missing" },
      {
        source: 1,
        location: "/h/.claude/CLAUDE.md",
        text: "global claude",
        attributes: { path: "/h/.claude/CLAUDE.md" },
      },
      { source: 2, location: "/p/sub/AGENTS.md", text: "deep", attributes: { path: "/p/sub/AGENTS.md" } },
      { source: 2, location: "/p/AGENTS.md", text: "", attributes: { path: "/p/AGENTS.md" } },
      { source: 3, location: "/p/CLAUDE.md", text: "claude", attributes: { path: "/p/CLAUDE.md" } },
      { source: 4, location: "/p/CONTEXT.md", text: "context", attributes: { path: "/p/CONTEXT.md" } },
      { source: 5, location: "/p/rules.md", text: "rules", attributes: { path: "/p/rules.md", name: "rules.md" } },
      { source: 5, location: "/p/sub/AGENTS.md", text: "deep", attributes: { path: "/p/sub/AGENTS.md" } },
    ])
    expect(text).toBe(
      [
        "Instructions from: /h/.claude/CLAUDE.md\nglobal claude",
        "Instructions from: /p/sub/AGENTS.md\ndeep",
        "Instructions from: /p/rules.md\nrules",
      ].join("\n"),
    )
    const of = (location: string, source?: number) =>
      trace.candidates.find((item) => item.location === location && (source === undefined || item.source === source))!
    expect(of("/g/AGENTS.md").why).toBe("filtered: not available (missing)")
    expect(of("/p/CLAUDE.md").why).toBe("lost to AGENTS.md (precedence (name))")
    expect(of("/p/CONTEXT.md").why).toBe("lost to AGENTS.md (precedence (name))")
    expect(of("/p/AGENTS.md").selected).toBe(true)
    expect(of("/p/sub/AGENTS.md", 5).why).toBe("already included (same path)")
  })

  test("one, top and all, in score order; ties by the sources' order", () => {
    const sources = [0, 1, 2, 3].map((index) => ({
      kind: "text" as const,
      location: `t${index}`,
      priority: [1, 3, 3, 2][index],
    }))
    const candidates = sources.map((source, index) => ({
      source: index,
      location: source.location,
      text: source.location,
    }))
    const of = (select: R.Select) =>
      R.run(resolver({ sources, score: [{ kind: "priority", weight: 1 }], select }), candidates).text
    expect(of({ policy: "one" })).toBe("t1")
    expect(of({ policy: "top", n: 2 })).toBe("t1\nt2")
    expect(of({ policy: "all" })).toBe("t1\nt2\nt3\nt0")
  })

  test("the budget, the per-source cut and the overflow line", () => {
    const sources = [{ kind: "memory" as const, location: "MEMORY.md" }]
    const candidates = ["aaaa", "bbbbbbbbbb", "cc", "dd"].map((text, index) => ({
      source: 0,
      location: `m${index}`,
      text,
      attributes: { updated: 10 - index },
    }))
    const { text, trace } = R.run(
      resolver({
        sources,
        score: [{ kind: "recency", weight: 1 }],
        select: { policy: "all", budget: 20, perSource: 8, overflow: "…{count} more memories: use the memory tool" },
      }),
      candidates,
    )
    expect(text).toBe("aaaa\nbbbbbbbb\n(cut)\ncc\n…1 more memories: use the memory tool")
    expect(trace.overBudget).toBe(1)
    expect(trace.candidates.find((item) => item.location === "m1")).toMatchObject({ cut: true, selected: true })
    expect(trace.candidates.find((item) => item.location === "m3")?.why).toBe("over budget")
  })

  test("an empty selection renders nothing: no header, footer or separator", () => {
    const layer = resolver({
      sources: [{ kind: "registry", location: "skills" }],
      template: { header: "<skills>\n", item: "{name}", separator: "\n", footer: "\n</skills>" },
    })
    expect(R.run(layer, []).text).toBe("")
    expect(R.run(layer, [{ source: 0, location: "a", text: "" }]).text).toBe("")
    expect(R.run(layer, [{ source: 0, location: "a", text: "x", attributes: { name: "a" } }]).text).toBe(
      "<skills>\na\n</skills>",
    )
  })

  test("filters: permission, size, an attribute; match rules against the context; indent", () => {
    const layer = resolver({
      sources: [{ kind: "registry", location: "skills" }],
      filter: [
        { kind: "available", need: "text" },
        { kind: "permission", permission: "skill" },
        { kind: "size", max: 5 },
        { kind: "attribute", attribute: "description", present: true },
      ],
      template: { item: "- {name}:\n{text|indent:2}", separator: "\n" },
    })
    const { text, trace } = R.run(
      layer,
      [
        { source: 0, location: "a", text: "a\nb", attributes: { name: "a", description: "A" } },
        { source: 0, location: "b", text: "b", attributes: { name: "secret", description: "B" } },
        { source: 0, location: "c", text: "too long", attributes: { name: "c", description: "C" } },
        { source: 0, location: "d", text: "d", attributes: { name: "d" } },
      ],
      { decide: (_permission, input) => (input === "secret" ? "deny" : "allow") },
    )
    expect(text).toBe("- a:\n  a\n  b")
    expect(trace.candidates.map((item) => item.why)).toEqual([
      "selected",
      "filtered: permission: skill denied for secret",
      "filtered: size: over 5 characters",
      "filtered: description: none",
    ])
    const base = resolver({
      sources: ["anthropic", "gemini", "default"].map((family) => ({ kind: "text" as const, location: family })),
      score: [{ kind: "match", attribute: "family", equals: "$family", weight: 10 }],
      select: { policy: "one" },
    })
    const families = ["anthropic", "gemini", "default"].map((family, index) => ({
      source: index,
      location: family,
      text: `${family} prompt`,
      attributes: { family },
    }))
    expect(R.run(base, families, { values: { family: "gemini" } }).text).toBe("gemini prompt")
    expect(R.run(base, families, { values: { family: "gemini" } }).trace.candidates[0]?.why).toBe(
      "lost to gemini (match (family))",
    )
  })

  test("the same candidates always give the same text and trace", () => {
    const candidates = [{ source: 0, location: "x", text: "x" }]
    const layer = resolver({ sources: [{ kind: "text", location: "x" }] })
    expect(R.run(layer, candidates)).toEqual(R.run(layer, candidates))
  })
})

describe("per-session resolutions", () => {
  const session = "ses_resolver_test"
  afterEach(() => OperatorResolutions.forget(session))

  test("reused while the signature is the same, resolved again when it changes, gone with the session", async () => {
    let calls = 0
    const compute = (text: string) => async () => {
      calls++
      return { text, trace: { policy: "one" as const, candidates: [], chars: text.length, overBudget: 0 } }
    }
    const first = await OperatorResolutions.reuse(session, "layer", "s1", compute("one"))
    const again = await OperatorResolutions.reuse(session, "layer", "s1", compute("two"))
    expect([first.text, again.text, again.reused, calls]).toEqual(["one", "one", true, 1])
    const changed = await OperatorResolutions.reuse(session, "layer", "s2", compute("two"))
    expect([changed.text, changed.reused, calls]).toEqual(["two", false, 2])
    const file = path.join(OperatorResolutions.folder(), `${session}.json`)
    expect(JSON.parse(await fs.readFile(file, "utf8")).layer.text).toBe("two")
    await OperatorResolutions.forget(session)
    expect(await Bun.file(file).exists()).toBe(false)
    // Without a session, nothing is kept.
    await OperatorResolutions.reuse(undefined, "layer", "s1", compute("three"))
    expect(calls).toBe(3)
  })
})
