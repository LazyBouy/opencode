// The agent form's checks (agent_form_spec.md §3–§5): Temperature, Top P and Step limit as typed, the home folder
// inside the project, and the colours OpenCode accepts. Messages are i18n keys; the form shows them inline, and an
// error blocks Save.

export type Check = { error?: CheckKey; warning?: CheckKey }
export type CheckKey =
  | "notNumber"
  | "temperatureRange"
  | "temperatureAnthropic"
  | "topPRange"
  | "stepsRange"
  | "homeOutside"
  | "homeUp"

const number = (text: string) => (text.trim() === "" ? undefined : Number(text.trim()))

/** 0 to 2; above 1 on an Anthropic model is only a warning (its API refuses it). */
export function checkTemperature(text: string, anthropic: boolean): Check {
  const value = number(text)
  if (value === undefined) return {}
  if (!Number.isFinite(value)) return { error: "notNumber" }
  if (value < 0 || value > 2) return { error: "temperatureRange" }
  if (anthropic && value > 1) return { warning: "temperatureAnthropic" }
  return {}
}

/** Above 0 and up to 1. */
export function checkTopP(text: string): Check {
  const value = number(text)
  if (value === undefined) return {}
  if (!Number.isFinite(value)) return { error: "notNumber" }
  if (value <= 0 || value > 1) return { error: "topPRange" }
  return {}
}

/** A whole number, 1 or more. */
export function checkSteps(text: string): Check {
  const value = number(text)
  if (value === undefined) return {}
  if (!Number.isInteger(value) || value < 1) return { error: "stepsRange" }
  return {}
}

/** A model Anthropic serves (temperature up to 1). */
export const isAnthropic = (model: string | undefined) => !!model && /^anthropic\/|claude/i.test(model)

// Paths here are the server's (POSIX).
function normalize(parts: string[]) {
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (!out.length || out.at(-1) === "..") out.push("..")
      else out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * The home folder as stored: relative to the project (`./agents/reviewer`; empty is the project itself). An absolute
 * path inside the project becomes relative; one outside it, or a relative one leading out, is an error.
 */
export function homeOf(text: string, project: string | undefined): { home: string; error?: CheckKey } {
  const raw = text.trim()
  if (!raw) return { home: "" }
  if (raw.startsWith("/")) {
    // Without one project (a namespace's or Global's agent), the home is inside each project it runs in.
    if (!project) return { home: raw, error: "homeOutside" }
    const root = normalize(project.split("/"))
    const parts = normalize(raw.split("/"))
    const inside = root.every((part, at) => parts[at] === part)
    if (!inside) return { home: raw, error: "homeOutside" }
    const rest = parts.slice(root.length)
    return { home: rest.length ? `./${rest.join("/")}` : "" }
  }
  const parts = normalize(raw.split("/"))
  if (parts[0] === "..") return { home: raw, error: "homeUp" }
  return { home: parts.length ? `./${parts.join("/")}` : "" }
}

/** The folder a stored home stands for in a project. */
export function homeFolder(home: string, project: string) {
  const { home: relative } = homeOf(home, project)
  return relative ? `${project.replace(/\/$/, "")}/${relative.slice(2)}` : project
}

// Colours (agent_form_spec.md §4): OpenCode's theme colours, or #RRGGBB.
export const THEME_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"] as const
export type ThemeColor = (typeof THEME_COLORS)[number]
export const isThemeColor = (value: string): value is ThemeColor => (THEME_COLORS as readonly string[]).includes(value)
export const HEX = /^#[0-9a-fA-F]{6}$/

export type RGB = { r: number; g: number; b: number }
export type HSV = { h: number; s: number; v: number }

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)))
export function hexOf(rgb: RGB) {
  return `#${[rgb.r, rgb.g, rgb.b].map((part) => clamp(part, 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase()
}
export function rgbOf(hex: string): RGB | undefined {
  if (!HEX.test(hex)) return undefined
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
export function hsvOf({ r, g, b }: RGB): HSV {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const h =
    delta === 0
      ? 0
      : max === red
        ? 60 * (((green - blue) / delta + 6) % 6)
        : max === green
          ? 60 * ((blue - red) / delta + 2)
          : 60 * ((red - green) / delta + 4)
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}
export function rgbOfHsv({ h, s, v }: HSV): RGB {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return { r: clamp((r + m) * 255, 255), g: clamp((g + m) * 255, 255), b: clamp((b + m) * 255, 255) }
}
