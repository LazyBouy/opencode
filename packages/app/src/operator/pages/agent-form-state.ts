import type { PermissionConfig } from "../ui/rules"
import { type Flavor, flavorOf, type Mode, modeOf } from "./agent-type"

// Form values for the agent editor, and the patch they turn into. Text inputs hold strings; empty
// means "not set".

/**
 * Where the agent's model comes from (agent_form_spec.md §2): the default model (no `model`), the small model
 * (`modelSource: "small"`; the server fills in and keeps `model` in step), or a model picked here.
 */
export type ModelSource = "default" | "small" | "pick"

export interface AgentForm {
  name: string
  description: string
  /** The Type (agent-type.ts): Usual, Subagent, Usual + subagent */
  mode: Mode
  /** A subagent's Flavor: only saved for Subagent and Usual + subagent */
  subagentMemory: Flavor
  modelSource: ModelSource
  /** provider/model, for Pick a model */
  model: string
  variant: string
  temperature: string
  top_p: string
  steps: string
  color: string
  hidden: boolean
  home: string
  prompt: string
}

const text = (value: unknown) => (value === undefined || value === null ? "" : String(value))

export function formFromSettings(name: string, settings: Record<string, unknown>): AgentForm {
  return {
    name,
    description: text(settings.description),
    mode: modeOf(settings.mode),
    subagentMemory: flavorOf(settings),
    // A model with no source is a picked one (§2.2).
    modelSource: settings.modelSource === "small" ? "small" : settings.model ? "pick" : "default",
    model: text(settings.model),
    variant: text(settings.variant),
    temperature: text(settings.temperature),
    top_p: text(settings.top_p),
    steps: text(settings.steps),
    color: text(settings.color),
    hidden: settings.hidden === true,
    home: text(settings.home),
    prompt: text(settings.prompt),
  }
}

export type ResetKey =
  | "description"
  | "mode"
  | "subagentMemory"
  | "model"
  | "modelSource"
  | "variant"
  | "temperature"
  | "top_p"
  | "steps"
  | "color"
  | "hidden"
  | "home"
  | "prompt"
  | "permission"

// Only filled-in settings are sent; a cleared setting that was set before goes in `reset`, which
// removes it so its default applies.
export function agentPatch(form: AgentForm, before: Record<string, unknown>, permission: PermissionConfig) {
  const reset: ResetKey[] = []
  const keep = <T>(key: ResetKey, next: T | undefined) => {
    if (next !== undefined) return next
    if (before[key] !== undefined && before[key] !== null) reset.push(key)
    return undefined
  }
  const words = (raw: string) => raw.trim() || undefined
  const number = (raw: string) => (raw.trim() === "" ? undefined : Number(raw))
  const rulesChanged = JSON.stringify(permission) !== JSON.stringify(before.permission ?? {})
  const patch = {
    description: keep("description", words(form.description)),
    mode: keep("mode", form.mode === "all" && before.mode === undefined ? undefined : form.mode),
    // Incognito is the default (nothing saved); a Usual agent has no Flavor.
    subagentMemory: keep(
      "subagentMemory",
      form.mode !== "primary" && form.subagentMemory === "retentive" ? ("retentive" as const) : undefined,
    ),
    // Default model: neither a model nor a source. Small model: the source (the server fills in `model`).
    // Pick a model: the model, and no source.
    model:
      form.modelSource === "small"
        ? undefined
        : keep("model", form.modelSource === "pick" ? words(form.model) : undefined),
    modelSource: keep("modelSource", form.modelSource === "small" ? ("small" as const) : undefined),
    // A variant applies only to an agent's own model.
    variant: keep("variant", form.modelSource === "default" ? undefined : words(form.variant)),
    temperature: keep("temperature", number(form.temperature)),
    top_p: keep("top_p", number(form.top_p)),
    steps: keep("steps", number(form.steps)),
    color: keep("color", words(form.color)),
    hidden: keep("hidden", form.hidden ? true : undefined),
    home: keep("home", words(form.home)),
    prompt: keep("prompt", words(form.prompt)),
    permission: rulesChanged
      ? keep("permission", Object.keys(permission).length > 0 ? permission : undefined)
      : undefined,
  }
  return { ...patch, reset: reset.length ? reset : undefined }
}
