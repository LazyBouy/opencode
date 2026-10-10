export * as OperatorMemoryDefaults from "./memory-defaults"

import fs from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { OperatorConfig } from "./config"
import { OperatorLayout } from "./layout"

// The `memory` permission's default lines (specs/docs/feedbacks/memory/memory_spec.md §6, §6.1), written
// once where the user sees and edits them: the global config's (which the OpenCode namespace uses), and
// each other namespace's config at its level. Lines the user already has are never changed.

/** The global config's lines: agents read every level, write their own, ask before project changes. */
export const GLOBAL = {
  "READ(*)": "allow",
  "WRITE(agent/*)": "allow",
  "WRITE(project/*)": "ask",
  "WRITE(namespace/*)": "deny",
  "FORGET(agent/*)": "ask",
  "FORGET(project/*)": "deny",
  "FORGET(namespace/*)": "deny",
} as const

/** A namespace's own lines (other than OpenCode's): reading its and its projects' memory asks. */
export const NAMESPACE = {
  "READ(namespace/*)": "ask",
  "READ(project/*)": "ask",
  "READ(agent/*)": "allow",
  "WRITE(agent/*)": "allow",
  "WRITE(project/*)": "ask",
  "WRITE(namespace/*)": "deny",
  "FORGET(agent/*)": "ask",
  "FORGET(project/*)": "deny",
  "FORGET(namespace/*)": "deny",
} as const

const CONFIGS = ["opencode.jsonc", "opencode.json"]

// Adds `permission.memory` to a config file that has none (created when missing).
async function addTo(file: string, lines: Record<string, string>) {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  const value = (text.trim() ? parse(text) : {}) as { permission?: unknown } | undefined
  const permission = value?.permission
  if (typeof permission === "string") return false
  if (permission && typeof permission === "object" && "memory" in permission) return false
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, OperatorConfig.patchText(text, { permission: { memory: OperatorConfig.whole(lines) } }))
  return true
}

async function existing(folder: string, names: ReadonlyArray<string>) {
  for (const name of names) {
    const file = path.join(folder, name)
    if (await Bun.file(file).exists()) return file
  }
  return path.join(folder, names[0]!)
}

/** A new namespace's memory lines, in its folder's config (§6.1). Not for OpenCode or Global. */
export async function forNamespace(id: string) {
  const layout = await OperatorLayout.snapshot()
  const place = OperatorLayout.placeOf(id, layout)
  if (!place || place.global || place.id === OperatorLayout.OPENCODE) return false
  return addTo(await existing(place.configDir, CONFIGS), NAMESPACE)
}

/**
 * Writes the defaults once: the global config's lines, and each other namespace's. A flag in the
 * namespaces' settings records it, so lines the user deletes don't come back. Off in OpenCode's test
 * runs unless OPENCODE_MEMORY_DEFAULTS=on (tests write them themselves).
 */
export async function ensure(env: NodeJS.ProcessEnv = process.env) {
  const wanted = env.OPENCODE_MEMORY_DEFAULTS ?? (env.OPENCODE_TEST_HOME ? "off" : "on")
  if (wanted !== "on") return false
  const settings = await OperatorLayout.readSettings()
  if (settings.memoryDefaults) return false
  await addTo(await OperatorLayout.globalConfigFile(), GLOBAL)
  const layout = await OperatorLayout.snapshot()
  for (const place of layout.places) await forNamespace(place.id).catch(() => false)
  await OperatorLayout.writeSettings({ ...(await OperatorLayout.readSettings()), memoryDefaults: true })
  return true
}
