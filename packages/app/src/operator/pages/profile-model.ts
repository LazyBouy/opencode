import type {
  OperatorPromptCatalog,
  OperatorPromptGroup,
  OperatorPromptGroupType,
  OperatorPromptLayer,
  OperatorPromptProfile,
  OperatorPromptSection,
} from "@opencode-ai/sdk/v2/client"

// Pure rules for the Prompt Profile pages, mirroring the server's (operator/profile.ts), so the
// editors only offer what a save accepts.

export type Catalog = OperatorPromptCatalog
export type Layer = OperatorPromptLayer
export type Group = OperatorPromptGroup
export type GroupType = OperatorPromptGroupType
export type Profile = OperatorPromptProfile
export type Section = OperatorPromptSection
export type Slots = Record<string, string[]>

export const OPENCODE = "opencode"
// "All namespaces" in a namespace scope.
export const ALL = "*"
export const PREFIX = "opencode:"
export const HELPER_AGENTS = ["title", "summary", "compaction"]
export const REQUIRED = ["purpose", "role", "identity"]
export const BUILTIN_TYPES = ["platform", "purpose", "role", "identity", "capabilities", "additional", "output"]

// Layer Definition's sections, in order, with the type a new layer in each gets.
export const SECTIONS: ReadonlyArray<{ id: Section; type?: string }> = [
  { id: "base", type: "identity" },
  { id: "purpose", type: "purpose" },
  { id: "role", type: "role" },
  { id: "identity", type: "identity" },
  { id: "tool", type: "capabilities" },
  { id: "generated" },
  { id: "output", type: "output" },
  { id: "custom", type: "identity" },
  { id: "message", type: "platform" },
]
// Sections people write layers in.
export const WRITTEN: readonly Section[] = ["purpose", "role", "identity", "custom"]

export function isBuiltin(id: string) {
  return id.startsWith(PREFIX)
}

// Where a layer comes from: OpenCode, a copy of one of OpenCode's texts, or this namespace.
export function origin(layer: Layer): "opencode" | "copy" | "yours" {
  if (layer.origin !== "user") return "opencode"
  return layer.replaces ? "copy" : "yours"
}

// Layers a slot of this type can hold: this namespace's and the built-ins of that type. Purpose holds
// none (it is automatic).
export function layersOfType(layers: ReadonlyArray<Layer>, type: string) {
  if (type === "purpose") return []
  return layers.filter((layer) => layer.type === type && layer.origin !== "automatic")
}

// The profiles whose slots hold a layer.
export function profilesUsing(catalog: Catalog, layer: string) {
  return catalog.profiles.filter((profile) => Object.values(profile.slots).flat().includes(layer))
}

// The namespace's default profile: the one it names, else OpenCode's.
export function namespaceDefault(catalog: Catalog) {
  return catalog.namespace.defaultProfile ?? `${PREFIX}profile.opencode`
}

// What uses a profile: agents that name it, projects whose default it is, the namespace default.
export function profileUsers(catalog: Catalog, profile: string) {
  return {
    agents: catalog.agents.filter((agent) => agent.profile === profile),
    projects: catalog.projects.filter((project) => project.defaultProfile === profile),
    namespace: namespaceDefault(catalog) === profile,
  }
}

// The profile an agent of `project` uses, and where that comes from: its own setting, the helper rule
// (title, summary, compaction), the project's default, else the namespace's (the server's profileFor).
export function profileFor(catalog: Catalog, project: string, agent: string) {
  const find = (id: string | undefined) => (id ? catalog.profiles.find((profile) => profile.id === id) : undefined)
  const own = find(catalog.agents.find((item) => item.project === project && item.name === agent)?.profile)
  if (own) return { profile: own, source: "agent" as const }
  const helper = find(`${PREFIX}profile.helper`)
  if (HELPER_AGENTS.includes(agent) && helper) return { profile: helper, source: "helper" as const }
  const fallback = find(catalog.projects.find((item) => item.key === project)?.defaultProfile)
  if (fallback) return { profile: fallback, source: "project" as const }
  const named = find(namespaceDefault(catalog)) ?? find(`${PREFIX}profile.opencode`)
  return named ? { profile: named, source: "namespace" as const } : undefined
}

// A profile's slots for another group: slots of types the group keeps stay, the others are dropped.
export function regroup(slots: Slots, types: ReadonlyArray<string>) {
  return {
    slots: Object.fromEntries(types.filter((type) => type !== "purpose").map((type) => [type, slots[type] ?? []])),
    dropped: Object.keys(slots).filter((type) => !types.includes(type) && (slots[type] ?? []).length > 0),
  }
}

// A plain copy of slots (the catalog's are read-only store values).
export function copySlots(slots: Slots): Slots {
  return Object.fromEntries(Object.entries(slots).map(([type, ids]) => [type, [...ids]]))
}

// Why a profile's slots cannot be saved, or undefined.
export function slotProblem(catalog: Catalog, slots: Slots) {
  const all = Object.values(slots).flat()
  const repeated = all.find((id, index) => all.indexOf(id) !== index)
  if (repeated) return { kind: "repeated" as const, layer: repeated }
  const replaced = all
    .map((id) => catalog.layers.find((layer) => layer.id === id)?.replaces)
    .filter((id): id is string => id !== undefined)
  const twice = replaced.find((id, index) => replaced.indexOf(id) !== index)
  if (twice) return { kind: "copies" as const, layer: twice }
  return undefined
}

// Why a group cannot be saved, or undefined.
export function groupProblem(types: ReadonlyArray<string>) {
  const absent = REQUIRED.find((type) => !types.includes(type))
  if (absent) return { kind: "required" as const, type: absent }
  if (new Set(types).size !== types.length) return { kind: "repeated" as const }
  return undefined
}

// Moves the item at `index` by `by` places.
export function move<T>(items: ReadonlyArray<T>, index: number, by: number) {
  const target = index + by
  if (target < 0 || target >= items.length) return [...items]
  return moveTo(items, index, target)
}

// Moves the item at `from` to `to` (drag and drop).
export function moveTo<T>(items: ReadonlyArray<T>, from: number, to: number) {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// A name for a copy, unique among `taken`.
export function copyName(name: string, taken: ReadonlyArray<string>) {
  const base = `${name} copy`
  const free = (index: number): string => {
    const candidate = index === 1 ? base : `${base} ${index}`
    return taken.includes(candidate) ? free(index + 1) : candidate
  }
  return free(1)
}
