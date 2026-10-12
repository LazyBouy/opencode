// An agent's Type and a subagent's Flavor (agent_types_spec.md §2, §3). The Type is OpenCode's mode under the
// fork's names: Usual (`primary`), Subagent (`subagent`), Usual + subagent (`all`). The Flavor is the fork's
// `subagentMemory`: incognito (the default: no agent memory, stores nothing) or retentive (like a usual agent).

export type Mode = "primary" | "subagent" | "all"
export type Flavor = "incognito" | "retentive"
/** What the Agents page's Type column shows and filters by (a helper is a namespace resource: helper.tsx). */
export type TypeKey = "usual" | "subagent-incognito" | "subagent-retentive" | "both" | "helper"

export const TYPE_KEYS: ReadonlyArray<TypeKey> = ["usual", "subagent-incognito", "subagent-retentive", "both", "helper"]

export const modeOf = (mode: unknown): Mode => (mode === "primary" || mode === "subagent" ? mode : "all")

export const flavorOf = (settings: Record<string, unknown> | undefined): Flavor =>
  settings?.subagentMemory === "retentive" ? "retentive" : "incognito"

export function typeOf(agent: { mode?: unknown; settings?: Record<string, unknown> }): TypeKey {
  const mode = modeOf(agent.mode)
  if (mode === "primary") return "usual"
  if (mode === "all") return "both"
  return flavorOf(agent.settings) === "retentive" ? "subagent-retentive" : "subagent-incognito"
}
