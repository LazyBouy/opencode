import type { PermissionConfig } from "../ui/rules"

// Form values for the agent editor, and the patch they turn into. Text inputs hold strings; empty
// means "not set".

export interface AgentForm {
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
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
  const mode = settings.mode
  return {
    name,
    description: text(settings.description),
    mode: mode === "primary" || mode === "subagent" ? mode : "all",
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
  | "model"
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
    model: keep("model", words(form.model)),
    variant: keep("variant", words(form.variant)),
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
