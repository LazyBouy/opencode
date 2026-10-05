export * as OperatorPromptText from "./prompt-text"

import { Effect, Fiber } from "effect"
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

// Every prompt text OpenCode adds on its own, and helpers for the versions prompt profiles choose
// (see profile.ts). Kept free of service imports, because session/prompt.ts and the plugin service
// import it, and services import those in turn.

// Mirrors session/prompt.ts; kept in sync by the end-to-end prompt tests.
export const STRUCTURED_OUTPUT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export type Kind = "base" | "reminder" | "notice" | "generator"

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
  const loaded = yield* Effect.promise(() => OperatorProfileStore.forProject(OperatorProfile.projectKey(ctx)))
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
