export * as OperatorResolverBuiltins from "./resolver-builtins"

import { escapeHtml } from "@/util/html"
import type { OperatorResolver } from "./resolver"

// OpenCode's Dynamic layers as resolvers (dynamic_layer_resolution_spec.md §4), with the candidates their
// sources give. Each reproduces the text OpenCode writes, byte for byte (test/operator/prompts-e2e.test.ts
// and resolver-builtins.test.ts compare them with upstream's on every request they make); when a request's
// text still differs (an upstream release changed its rules), profile.ts sends upstream's and the trace
// says so. Pure: dynamic-layers.ts reads the sources.

const P = "opencode:"
export const ENVIRONMENT = `${P}generated.environment`
export const REFERENCES = `${P}generated.references`
export const INSTRUCTIONS = `${P}generated.instructions`
export const MCP = `${P}generated.mcp`
export const SKILLS = `${P}generated.skills`
export const BASE = `${P}slot.base`
export const AGENT = `${P}slot.agent`
export const AGENT_OR_BASE = `${P}slot.agent-or-base`
// The memory layers (memory_spec.md §4.1): one per level.
export const MEMORY_NAMESPACE = `${P}generated.memory-namespace`
export const MEMORY_PROJECT = `${P}generated.memory-project`
export const MEMORY_AGENT = `${P}generated.memory-agent`
export const MEMORY_LAYERS = [MEMORY_NAMESPACE, MEMORY_PROJECT, MEMORY_AGENT]

export const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const

const SKILLS_HEADER = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
].join("\n")

export const RESOLVERS: Readonly<Record<string, OperatorResolver.Resolver>> = {
  [ENVIRONMENT]: {
    sources: [{ kind: "live", location: "environment", name: "Environment" }],
    filter: [],
    score: [],
    select: { policy: "one" },
    template: {
      item: [
        "You are powered by the model named {model}. The exact model ID is {provider}/{model}",
        "Here is some useful information about the environment you are running in:",
        "<env>",
        "  Working directory: {directory}",
        "  Workspace root folder: {worktree}",
        "  Is directory a git repo: {git}",
        "  Platform: {platform}",
        "  Today's date: {date}",
        "</env>",
      ].join("\n"),
      separator: "\n",
      keepEmpty: true,
    },
  },
  [REFERENCES]: {
    sources: [{ kind: "config", location: "references" }],
    filter: [{ kind: "attribute", attribute: "description", present: true }],
    score: [{ kind: "precedence", attribute: "name", weight: 1 }],
    select: { policy: "all" },
    template: {
      header:
        "Project references provide additional directories that can be accessed when relevant.\n<available_references>\n",
      item: "  <reference>\n    <name>{name}</name>\n    <path>{path}</path>\n    <description>{description}</description>\n  </reference>",
      separator: "\n",
      footer: "\n</available_references>",
      keepEmpty: true,
    },
  },
  [INSTRUCTIONS]: {
    sources: [
      { kind: "file", location: "~/.config/opencode/AGENTS.md", group: "global", name: "AGENTS.md" },
      { kind: "file", location: "~/.claude/CLAUDE.md", group: "global", name: "CLAUDE.md" },
      ...INSTRUCTION_NAMES.map((name) => ({ kind: "file" as const, location: name, group: "project", name })),
      { kind: "config", location: "instructions", group: "config" },
    ],
    filter: [{ kind: "available", need: "exists" }],
    score: [{ kind: "precedence", attribute: "name", order: [...INSTRUCTION_NAMES], weight: 10 }],
    select: { policy: "one", per: { config: "all" }, unique: "path", groups: ["global", "project", "config"] },
    template: { item: "Instructions from: {path}\n{text}", separator: "\n" },
  },
  [MCP]: {
    sources: [{ kind: "registry", location: "mcp" }],
    filter: [{ kind: "flag", attribute: "usable", reason: "the agent may use none of its tools" }],
    score: [],
    select: { policy: "all" },
    template: {
      header: "<mcp_instructions>\n",
      item: '  <server name="{name}">\n{text|indent:4}\n  </server>',
      separator: "\n",
      footer: "\n</mcp_instructions>",
      keepEmpty: true,
    },
  },
  [SKILLS]: {
    sources: [{ kind: "registry", location: "skills" }],
    filter: [
      { kind: "permission", permission: "skill" },
      { kind: "attribute", attribute: "description", present: true },
    ],
    score: [{ kind: "precedence", attribute: "name", weight: 1 }],
    select: { policy: "all" },
    template: {
      header: `${SKILLS_HEADER}\n<available_skills>\n`,
      item: "  <skill>\n    <name>{name}</name>\n    <description>{description}</description>\n    <location>{where}</location>\n  </skill>",
      separator: "\n",
      footer: "\n</available_skills>",
      keepEmpty: true,
      empty: `${SKILLS_HEADER}\nNo skills are currently available.`,
    },
  },
  // The family texts (OpenCode's, the namespace's versions, the profile's copies): the one whose family
  // the model's rule chose, the profile's copy first, then the namespace's version, then OpenCode's.
  [BASE]: {
    sources: [{ kind: "text", location: "base prompts" }],
    filter: [{ kind: "available", need: "exists" }],
    score: [
      { kind: "match", attribute: "family", equals: "$family", weight: 100 },
      { kind: "prefer", order: ["profile", "namespace", "opencode"], weight: 10 },
    ],
    select: { policy: "one" },
    template: { item: "{text}", separator: "\n" },
  },
  [AGENT]: {
    sources: [{ kind: "agent-field", location: "prompt" }],
    filter: [{ kind: "available", need: "text" }],
    score: [],
    select: { policy: "one" },
    template: { item: "{text}", separator: "\n" },
  },
  // The agent's own prompt when it has one, else the base prompt for the model (OpenCode's rule).
  [AGENT_OR_BASE]: {
    sources: [
      { kind: "agent-field", location: "prompt", name: "Agent prompt" },
      { kind: "text", location: "base prompt (by model)", name: "Base prompt" },
    ],
    filter: [{ kind: "available", need: "text" }],
    score: [{ kind: "present", weight: 1 }],
    select: { policy: "one" },
    template: { item: "{text}", separator: "\n" },
  },
}

export const isBuiltinResolver = (id: string) => id in RESOLVERS

// The memory layers (memory_spec.md §4.1): the level's index lines, newest first, cut at the limits (Memory →
// Settings) with an overflow line; nothing when the index is empty. Built per request with the level's folder
// and the limits; RESOLVERS shows them with the default limits.
export const MEMORY_LEVEL: Readonly<Record<string, "namespace" | "project" | "agent">> = {
  [MEMORY_NAMESPACE]: "namespace",
  [MEMORY_PROJECT]: "project",
  [MEMORY_AGENT]: "agent",
}
export function memoryResolver(
  level: "namespace" | "project" | "agent",
  input: { folder: string; lines: number; chars: number },
): OperatorResolver.Resolver {
  return {
    sources: [{ kind: "memory", location: level, name: `${level} memory` }],
    filter: [{ kind: "available", need: "text" }],
    score: [{ kind: "recency", weight: 1 }],
    select: {
      policy: "top",
      n: input.lines,
      budget: input.chars,
      overflow: "…{count} more memories: use the memory tool to list them",
    },
    template: {
      header: `<${level}_memory path="${input.folder}">\n`,
      item: "{text}",
      separator: "\n",
      footer: `\n</${level}_memory>`,
    },
  }
}
// What a level shows when reading it asks (§7): one line, and the memory tool asks when it reads.
export const memoryAvailable = (level: string) =>
  `${level.charAt(0).toUpperCase()}${level.slice(1)} memory is available. Read it with the memory tool; reading asks for permission.`

// The memory layers' rules as the editor shows them (the default limits; the folder is the level's).
for (const [id, level] of Object.entries(MEMORY_LEVEL))
  (RESOLVERS as Record<string, OperatorResolver.Resolver>)[id] = memoryResolver(level, {
    folder: "{folder}",
    lines: 200,
    chars: 25_000,
  })

// Your Dynamic layers written by a helper (before they had rules of their own): one helper source, the
// layer's prompt, written once per session. The same text as before.
export const HELPER_RESOLVER: OperatorResolver.Resolver = {
  sources: [{ kind: "helper", location: "prompt", name: "Helper" }],
  filter: [{ kind: "available", need: "text" }],
  score: [],
  select: { policy: "one" },
  template: { item: "{text}", separator: "\n" },
}

// The layers whose rules can be edited in a copy: the sources of OpenCode's per-request layers can be
// read for any layer (dynamic-layers.ts). The base and agent prompts are chosen in the profile itself.
export const EDITABLE = [ENVIRONMENT, REFERENCES, INSTRUCTIONS, MCP, SKILLS]

// Candidates, from what was read.

export function environment(input: {
  model: string
  provider: string
  directory: string
  worktree: string
  git: boolean
  platform: string
  date: string
}): OperatorResolver.Candidate[] {
  const { git, ...values } = input
  return [{ source: 0, location: "environment", text: "", attributes: { ...values, git: git ? "yes" : "no" } }]
}

export function references(
  list: ReadonlyArray<{ name: string; path: string; description?: string }>,
): OperatorResolver.Candidate[] {
  return list.map((item) => ({
    source: 0,
    location: item.path,
    text: item.description ?? "",
    attributes: { name: item.name, path: item.path, description: item.description },
  }))
}

export function skills(
  list: ReadonlyArray<{ name: string; description?: string; location: string }>,
): OperatorResolver.Candidate[] {
  return list.map((item) => ({
    source: 0,
    location: item.location,
    text: item.description ?? "",
    attributes: { name: item.name, description: item.description, where: escapeHtml(item.location) },
  }))
}

export function mcp(
  list: ReadonlyArray<{ name: string; instructions: string; usable: boolean }>,
): OperatorResolver.Candidate[] {
  return list.map((item) => ({
    source: 0,
    location: item.name,
    text: item.instructions,
    attributes: { name: item.name, usable: item.usable ? "yes" : "no" },
  }))
}

// Instructions: each global file (found or not), each project file found from the folder up (per name, as
// upstream finds them), then config's files and URLs (files first, in config's order). Texts as read;
// a file that can't be read is empty, as upstream reads it.
export function instructions(input: {
  global: ReadonlyArray<{ name: (typeof INSTRUCTION_NAMES)[number]; path: string; text?: string }>
  project: ReadonlyArray<{ name: (typeof INSTRUCTION_NAMES)[number]; path: string; text: string }>
  config: ReadonlyArray<{ path: string; text: string; url?: boolean }>
}): OperatorResolver.Candidate[] {
  const globalSource = (name: string) => (name === "AGENTS.md" ? 0 : 1)
  const projectSource = (name: string) => 2 + INSTRUCTION_NAMES.indexOf(name as (typeof INSTRUCTION_NAMES)[number])
  return [
    ...input.global.map((item) => ({
      source: globalSource(item.name),
      location: item.path,
      ...(item.text === undefined ? { reason: "missing" } : { text: item.text }),
      attributes: { path: item.path },
    })),
    ...input.project.map((item) => ({
      source: projectSource(item.name),
      location: item.path,
      text: item.text,
      attributes: { path: item.path },
    })),
    ...input.config.map((item) => ({
      source: 5,
      location: item.path,
      text: item.text,
      attributes: { path: item.path, ...(item.url ? { url: "yes" } : {}) },
    })),
  ]
}

// The base prompts: every family's texts, each marked with its origin.
export function bases(
  list: ReadonlyArray<{ family: string; origin: "profile" | "namespace" | "opencode"; text: string; name: string }>,
): OperatorResolver.Candidate[] {
  return list.map((item) => ({
    source: 0,
    location: item.name,
    text: item.text,
    attributes: { family: item.family, origin: item.origin, name: item.name },
  }))
}

export function agentOrBase(agentPrompt: string | undefined, base: string): OperatorResolver.Candidate[] {
  return [
    { source: 0, location: "prompt", ...(agentPrompt ? { text: agentPrompt } : { reason: "missing" }) },
    { source: 1, location: "base prompt (by model)", text: base },
  ]
}
