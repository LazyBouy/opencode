export * as OperatorPromptText from "./prompt-text"

import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import PROMPT_GENERATE from "@/agent/generate.txt"
import { InstanceState } from "@/effect/instance-state"
import type { Provider } from "@/provider/provider"
import PROMPT_ANTHROPIC from "@/session/prompt/anthropic.txt"
import PROMPT_BEAST from "@/session/prompt/beast.txt"
import BUILD_SWITCH from "@/session/prompt/build-switch.txt"
import PROMPT_CODEX from "@/session/prompt/codex.txt"
import PROMPT_DEFAULT from "@/session/prompt/default.txt"
import PROMPT_GEMINI from "@/session/prompt/gemini.txt"
import PROMPT_ASTRA from "@/session/prompt/gpt-astra.txt"
import PROMPT_GPT from "@/session/prompt/gpt.txt"
import PROMPT_KIMI from "@/session/prompt/kimi.txt"
import PROMPT_META from "@/session/prompt/meta.txt"
import PLAN_MODE from "@/session/prompt/plan-mode.txt"
import PROMPT_PLAN from "@/session/prompt/plan.txt"
import PROMPT_TRINITY from "@/session/prompt/trinity.txt"
import { SystemPrompt } from "@/session/system"
import { OperatorConfig } from "./config"

// Prompt texts and the rules that apply their overrides. Kept free of service imports, because
// session/prompt.ts and the plugin service import it, and services import those in turn.

// Every prompt text OpenCode adds on its own, with an override file per scope:
// `prompts/<id>.md` in the global config folder or the project's `.opencode` folder (project wins).
// An empty override file turns the text off. Generated sections (environment, skills, MCP
// instructions) are switched on and off with the `prompts` config key instead.

// Mirrors session/prompt.ts; kept in sync by the end-to-end prompt tests.
export const STRUCTURED_OUTPUT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export const Kind = Schema.Literals(["base", "reminder", "notice", "generator"])
export type Kind = typeof Kind.Type

interface Builtin {
  readonly id: string
  readonly kind: Kind
  readonly text: string
}

export const BUILTINS: readonly Builtin[] = [
  { id: "base", kind: "base", text: "" },
  { id: "base.anthropic", kind: "base", text: PROMPT_ANTHROPIC },
  { id: "base.gpt", kind: "base", text: PROMPT_GPT },
  { id: "base.gpt-astra", kind: "base", text: PROMPT_ASTRA },
  { id: "base.codex", kind: "base", text: PROMPT_CODEX },
  { id: "base.beast", kind: "base", text: PROMPT_BEAST },
  { id: "base.gemini", kind: "base", text: PROMPT_GEMINI },
  { id: "base.kimi", kind: "base", text: PROMPT_KIMI },
  { id: "base.meta", kind: "base", text: PROMPT_META },
  { id: "base.trinity", kind: "base", text: PROMPT_TRINITY },
  { id: "base.default", kind: "base", text: PROMPT_DEFAULT },
  { id: "reminder.plan", kind: "reminder", text: PROMPT_PLAN },
  { id: "reminder.plan-mode", kind: "reminder", text: PLAN_MODE },
  { id: "reminder.build-switch", kind: "reminder", text: BUILD_SWITCH },
  { id: "notice.structured-output", kind: "notice", text: STRUCTURED_OUTPUT },
  { id: "notice.max-steps", kind: "notice", text: MAX_STEPS_PROMPT },
  { id: "generator.agent", kind: "generator", text: PROMPT_GENERATE },
]

export type Overrides = ReadonlyMap<string, { readonly scope: OperatorConfig.Scope; readonly text: string }>

export function promptFolders(ctx: { directory: string; worktree: string }) {
  return {
    global: path.join(OperatorConfig.scopeDirectory("global", ctx), "prompts"),
    project: path.join(OperatorConfig.scopeDirectory("project", ctx), "prompts"),
  }
}

// Override files for a project; project files replace global ones with the same id.
export async function readOverrides(ctx: { directory: string; worktree: string }) {
  const folders = promptFolders(ctx)
  const read = async (scope: OperatorConfig.Scope, dir: string) => {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    return Promise.all(
      names
        .filter((name) => name.endsWith(".md"))
        .map(
          async (name) =>
            [name.slice(0, -3), { scope, text: (await fs.readFile(path.join(dir, name), "utf8")).trim() }] as const,
        ),
    )
  }
  return new Map([
    ...(await read("global", folders.global)),
    ...(folders.project === folders.global ? [] : await read("project", folders.project)),
  ])
}

// Plugin hooks see the SDK's model type; SystemPrompt.provider only reads these two fields.
type ModelRef = { readonly providerID: string; readonly api: { readonly id: string } }
const builtinBase = (model: ModelRef) => SystemPrompt.provider(model as Provider.Model)[0] ?? ""

// The catalog entry for a model's base prompt, matching SystemPrompt.provider's choice by its text.
export function baseFor(model: ModelRef) {
  const chosen = builtinBase(model)
  return (
    BUILTINS.find(
      (item) =>
        item.kind === "base" &&
        item.text !== "" &&
        (item.text === chosen || (item.id === "base.meta" && chosen === renderMeta(item.text, model))),
    ) ?? BUILTINS.find((item) => item.id === "base.default")!
  )
}

function renderMeta(text: string, model: ModelRef) {
  return text.replaceAll("{{MODEL_NAME}}", model.api.id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark")
}

// The base prompt text sent for a model: its family's override, else the all-models override,
// else the built-in text.
export function baseText(model: ModelRef, overrides: Overrides) {
  const entry = baseFor(model)
  const text = overrides.get(entry.id)?.text ?? overrides.get("base")?.text ?? builtinBase(model)
  return entry.id === "base.meta" ? renderMeta(text, model) : text
}

export function text(id: string, overrides: Overrides) {
  return overrides.get(id)?.text ?? BUILTINS.find((item) => item.id === id)?.text ?? ""
}

// Effectful lookup for code paths that need one override (the step-limit notice).
export const maxSteps = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  const overrides = yield* Effect.promise(() => readOverrides(ctx))
  return text("notice.max-steps", overrides)
})

// Generated sections, as session/system.ts writes them. Removing one keeps the rest intact.
export const SECTION_PATTERNS = {
  environment: [
    /You are powered by the model named [^\n]*\nHere is some useful information about the environment you are running in:\n<env>[\s\S]*?<\/env>\n?/,
    /Project references provide additional directories that can be accessed when relevant\.\n<available_references>[\s\S]*?<\/available_references>\n?/,
  ],
  skills: [
    /Skills provide specialized instructions and workflows for specific tasks\.\nUse the skill tool to load a skill when a task matches its description\.\n(?:<available_skills>[\s\S]*?<\/available_skills>|No skills are currently available\.)\n?/,
  ],
  mcp: [/<mcp_instructions>[\s\S]*?<\/mcp_instructions>\n?/],
} as const
export type Section = keyof typeof SECTION_PATTERNS

export const Toggles = Schema.Struct({
  environment: Schema.Boolean,
  skills: Schema.Boolean,
  mcp: Schema.Boolean,
}).annotate({ identifier: "OperatorPromptToggles" })
export type Toggles = typeof Toggles.Type

export function toggles(config: { prompts?: { environment?: boolean; skills?: boolean; mcp?: boolean } }): Toggles {
  return {
    environment: config.prompts?.environment !== false,
    skills: config.prompts?.skills !== false,
    mcp: config.prompts?.mcp !== false,
  }
}

// Applies overrides and switches to a system prompt as request preparation built it.
export function rewriteSystem(system: string, input: { model?: ModelRef; overrides: Overrides; toggles: Toggles }) {
  const replaced = [
    ...(input.model ? [{ from: builtinBase(input.model), to: baseText(input.model, input.overrides) }] : []),
    { from: STRUCTURED_OUTPUT, to: text("notice.structured-output", input.overrides) },
    { from: PROMPT_GENERATE, to: text("generator.agent", input.overrides) },
  ].reduce(
    (current, item) => (item.from && item.from !== item.to ? current.replace(item.from, () => item.to) : current),
    system,
  )
  return (Object.keys(SECTION_PATTERNS) as Section[])
    .filter((section) => !input.toggles[section])
    .flatMap((section) => SECTION_PATTERNS[section])
    .reduce((current, pattern) => current.replace(pattern, ""), replaced)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// Replaces a reminder that session/reminders.ts added; "" means it was turned off.
// Matches text written from a template back to it, returning the values of its ${name} placeholders
// and how much of the text the template covers.
export function matchTemplate(template: string, value: string) {
  const parts = template.split(/\$\{(\w+)\}/)
  if (parts.length === 1) return value.startsWith(template) ? { values: {}, length: template.length } : undefined
  const pattern = parts
    .map((part, index) => (index % 2 ? "([\\s\\S]*?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("")
  const match = new RegExp(`^${pattern}`).exec(value)
  if (!match) return undefined
  const names = parts.filter((_, index) => index % 2 === 1)
  return {
    values: Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? ""])) as Record<string, string>,
    length: match[0].length,
  }
}

export function rewriteReminder(value: string, overrides: Overrides) {
  for (const item of BUILTINS.filter((entry) => entry.kind === "reminder")) {
    const found = matchTemplate(item.text, value)
    if (!found) continue
    const replaced = Object.entries(found.values).reduce(
      (result, [name, filled]) => result.replaceAll(`\${${name}}`, () => filled),
      text(item.id, overrides),
    )
    return replaced + value.slice(found.length)
  }
  return value
}
