export * as OperatorPromptText from "./prompt-text"

import { Effect, Fiber } from "effect"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import PROMPT_GENERATE from "@/agent/generate.txt"
import PROMPT_COMPACTION from "@/agent/prompt/compaction.txt"
import PROMPT_EXPLORE from "@/agent/prompt/explore.txt"
import PROMPT_SUMMARY from "@/agent/prompt/summary.txt"
import PROMPT_TITLE from "@/agent/prompt/title.txt"
import DYNAMIC_GENERATOR from "./helper/dynamic-generator.txt"
import PURPOSE_GENERATOR from "./helper/purpose-generator.txt"
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

// Every prompt text OpenCode adds on its own, and helpers for the versions prompt profiles choose
// (see profile.ts). Kept free of service imports, because session/prompt.ts and the plugin service
// import it, and services import those in turn.

// Mirrors session/prompt.ts; kept in sync by the end-to-end prompt tests.
export const STRUCTURED_OUTPUT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export type Kind = "base" | "reminder" | "notice" | "helper"

interface Builtin {
  readonly id: string
  readonly kind: Kind
  readonly text: string
  // The file in OpenCode's code the text comes from (repo path), shown so it can be traced.
  readonly file?: string
}

const SESSION = "packages/opencode/src/session/prompt"
const AGENT = "packages/opencode/src/agent"

export const BUILTINS: readonly Builtin[] = [
  { id: "base", kind: "base", text: "" },
  { id: "base.anthropic", kind: "base", text: PROMPT_ANTHROPIC, file: `${SESSION}/anthropic.txt` },
  { id: "base.gpt", kind: "base", text: PROMPT_GPT, file: `${SESSION}/gpt.txt` },
  { id: "base.gpt-astra", kind: "base", text: PROMPT_ASTRA, file: `${SESSION}/gpt-astra.txt` },
  { id: "base.codex", kind: "base", text: PROMPT_CODEX, file: `${SESSION}/codex.txt` },
  { id: "base.beast", kind: "base", text: PROMPT_BEAST, file: `${SESSION}/beast.txt` },
  { id: "base.gemini", kind: "base", text: PROMPT_GEMINI, file: `${SESSION}/gemini.txt` },
  { id: "base.kimi", kind: "base", text: PROMPT_KIMI, file: `${SESSION}/kimi.txt` },
  { id: "base.meta", kind: "base", text: PROMPT_META, file: `${SESSION}/meta.txt` },
  { id: "base.trinity", kind: "base", text: PROMPT_TRINITY, file: `${SESSION}/trinity.txt` },
  { id: "base.default", kind: "base", text: PROMPT_DEFAULT, file: `${SESSION}/default.txt` },
  { id: "reminder.plan", kind: "reminder", text: PROMPT_PLAN, file: `${SESSION}/plan.txt` },
  { id: "reminder.plan-mode", kind: "reminder", text: PLAN_MODE, file: `${SESSION}/plan-mode.txt` },
  { id: "reminder.build-switch", kind: "reminder", text: BUILD_SWITCH, file: `${SESSION}/build-switch.txt` },
  {
    id: "notice.structured-output",
    kind: "notice",
    text: STRUCTURED_OUTPUT,
    file: "packages/opencode/src/session/prompt.ts",
  },
  {
    id: "notice.max-steps",
    kind: "notice",
    text: MAX_STEPS_PROMPT,
    file: "packages/core/src/session/runner/max-steps.ts",
  },
  // The prompts of the agents OpenCode runs for itself (title, summary, compaction) and of the agent
  // generator's one call.
  { id: "helper.title", kind: "helper", text: PROMPT_TITLE, file: `${AGENT}/prompt/title.txt` },
  { id: "helper.summary", kind: "helper", text: PROMPT_SUMMARY, file: `${AGENT}/prompt/summary.txt` },
  { id: "helper.compaction", kind: "helper", text: PROMPT_COMPACTION, file: `${AGENT}/prompt/compaction.txt` },
  { id: "helper.agent-generator", kind: "helper", text: PROMPT_GENERATE, file: `${AGENT}/generate.txt` },
  // The fork's own helpers: they draft org and project purposes, and write your Dynamic layers.
  {
    id: "helper.purpose-generator",
    kind: "helper",
    text: PURPOSE_GENERATOR,
    file: "packages/opencode/src/operator/helper/purpose-generator.txt",
  },
  {
    id: "helper.dynamic-generator",
    kind: "helper",
    text: DYNAMIC_GENERATOR,
    file: "packages/opencode/src/operator/helper/dynamic-generator.txt",
  },
]

// Built-in agents' own prompts (of build, plan, general and explore, only explore has one), set in
// agent/agent.ts. They are not layers: an agent's prompt goes through the agent-prompt slots; they are
// listed so the agent page can name the file a built-in agent's prompt comes from.
export const AGENT_DEFINITIONS = "packages/opencode/src/agent/agent.ts"
export const AGENT_PROMPTS: ReadonlyArray<{ name: string; text: string; file: string }> = [
  { name: "explore", text: PROMPT_EXPLORE, file: `${AGENT}/prompt/explore.txt` },
]

// Versions of built-in texts by their id, for rewriteReminder and text().
export type Versions = ReadonlyMap<string, string>

// Plugin hooks see the SDK's model type; SystemPrompt.provider only reads these two fields.
export type ModelRef = { readonly providerID: string; readonly api: { readonly id: string } }
export const builtinBase = (model: ModelRef) => SystemPrompt.provider(model as Provider.Model)[0] ?? ""

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

// The rule SystemPrompt.provider (session/system.ts) chose the model's base prompt by, as a short
// expression: the same tests in the same order.
export function baseRule(model: ModelRef) {
  const id = model.api.id
  if (id.includes("muse")) return 'id includes "muse"'
  if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return 'id includes "gpt-4", "o1" or "o3"'
  if (id.includes("gpt")) {
    if (id.includes("gpt-6")) return 'id includes "gpt-6"'
    if (id.includes("codex")) return 'id includes "gpt" and "codex"'
    return 'id includes "gpt"'
  }
  if (id.includes("gemini-")) return 'id includes "gemini-"'
  if (id.includes("claude")) return 'id includes "claude"'
  if (id.toLowerCase().includes("trinity")) return 'id includes "trinity"'
  if (
    id.toLowerCase().includes("kimi") ||
    ["kimi-for-coding", "moonshotai", "moonshotai-cn"].includes(model.providerID)
  )
    return 'id includes "kimi", or provider kimi-for-coding, moonshotai or moonshotai-cn'
  return "no other rule matches"
}

export function renderMeta(text: string, model: ModelRef) {
  return text.replaceAll("{{MODEL_NAME}}", model.api.id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark")
}

export function text(id: string, versions: Versions) {
  return versions.get(id) ?? BUILTINS.find((item) => item.id === id)?.text ?? ""
}

// The agent each session loop step runs, by its fiber. The prompt plugin records it when the loop
// transforms its messages; the step-limit notice, added later in the same step, reads it.
export const loopAgents = new WeakMap<object, string>()

// The step-limit notice: the copy in the agent's profile's Platform slot, else OpenCode's. Profile
// modules are imported lazily: they import this module.
export const maxSteps = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  const fiber = Fiber.getCurrent()
  const agent = fiber ? loopAgents.get(fiber) : undefined
  const { OperatorProfile } = yield* Effect.promise(() => import("./profile"))
  const { OperatorProfileStore } = yield* Effect.promise(() => import("./profile-store"))
  const { OperatorProjects } = yield* Effect.promise(() => import("./projects"))
  const loaded = yield* Effect.promise(() => OperatorProjects.keyOf(ctx).then(OperatorProfileStore.forProject))
  const slots = OperatorProfile.slotsFor(loaded.catalog, {
    agent,
    setting: agent ? loaded.agents[agent] : undefined,
    project: loaded.project,
  })
  return (
    OperatorProfile.versionOf({
      catalog: loaded.catalog,
      slots,
      builtin: `${OperatorProfile.PREFIX}notice.max-steps`,
    }) ?? MAX_STEPS_PROMPT
  )
})

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

export function rewriteReminder(value: string, versions: Versions) {
  for (const item of BUILTINS.filter((entry) => entry.kind === "reminder")) {
    const found = matchTemplate(item.text, value)
    if (!found) continue
    const replaced = Object.entries(found.values).reduce(
      (result, [name, filled]) => result.replaceAll(`\${${name}}`, () => filled),
      text(item.id, versions),
    )
    return replaced + value.slice(found.length)
  }
  return value
}
