import type { PermissionConfig } from "../ui/rules"

// Form values for the agent editor, and the patch they turn into. Text inputs hold strings; empty
// means "not set".

export type PromptMode = "profile" | "layers" | "custom"
export const GENERATED = ["environment", "references", "instructions", "mcp", "skills"] as const
export type Generated = (typeof GENERATED)[number]

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
  // How the system prompt is built: "profile" with no profile chosen is the default chain (unset).
  promptMode: PromptMode
  promptProfile: string
  promptLayers: Array<{ layer: string; group: string }>
  promptGenerated: Generated[]
}

const text = (value: unknown) => (value === undefined || value === null ? "" : String(value))

type Setting = {
  mode?: PromptMode
  profile?: string
  layers?: Array<{ layer: string; group: string }>
  generated?: Generated[]
}

export function formFromSettings(name: string, settings: Record<string, unknown>): AgentForm {
  const mode = settings.mode
  const setting = settings.promptProfile as Setting | undefined
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
    promptMode: setting?.mode ?? "profile",
    promptProfile: setting?.profile ?? "",
    promptLayers: (setting?.layers ?? []).map((item) => ({ ...item })),
    promptGenerated: [...(setting?.generated ?? GENERATED)],
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
  | "promptProfile"

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
  const setting = promptSetting(form)
  const settingChanged = JSON.stringify(setting ?? null) !== JSON.stringify(before.promptProfile ?? null)
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
    promptProfile: settingChanged ? keep("promptProfile", setting) : undefined,
  }
  return { ...patch, reset: reset.length ? reset : undefined }
}

// The `promptProfile` setting the form describes, or undefined for the default chain.
export function promptSetting(form: AgentForm) {
  if (form.promptMode === "custom")
    return {
      mode: "custom" as const,
      ...(form.promptGenerated.length === GENERATED.length ? {} : { generated: [...form.promptGenerated] }),
    }
  if (form.promptMode === "profile" && !form.promptProfile) return undefined
  return {
    mode: form.promptMode,
    ...(form.promptProfile ? { profile: form.promptProfile } : {}),
    ...(form.promptMode === "layers" && form.promptLayers.length
      ? { layers: form.promptLayers.map((item) => ({ ...item })) }
      : {}),
  }
}
