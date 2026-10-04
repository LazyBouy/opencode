import type {
  OperatorPromptGroup,
  OperatorPromptGroupType,
  OperatorPromptLayer,
  OperatorPromptLayerSection,
  OperatorPromptProfile,
  OperatorPromptProfileCatalog,
} from "@opencode-ai/sdk/v2/client"

// Pure rules for the Prompt Profile pages, mirroring the server's (operator/profile.ts) so the editors
// only offer what a save accepts.

export type Catalog = OperatorPromptProfileCatalog
export type Layer = OperatorPromptLayer
export type Group = OperatorPromptGroup
export type Profile = OperatorPromptProfile
export type Section = OperatorPromptLayerSection
export type GroupType = OperatorPromptGroupType
export type Projects = Layer["projects"]

export const OPENCODE = "opencode"

// Layer Definition's sections, in order.
export const SECTIONS: readonly Section[] = [
  "base",
  "purpose",
  "role",
  "identity",
  "tool",
  "generated",
  "output",
  "custom",
  "message",
]

// Group types in the order a profile holds them.
export const GROUP_ORDER: readonly GroupType[] = [
  "platform",
  "purpose",
  "role",
  "identity",
  "capabilities",
  "custom",
  "output",
  "tool",
]
export const REQUIRED: readonly GroupType[] = ["purpose", "role", "identity"]
export const MANDATORY = ["purpose.org", "purpose.goal"]

// Sections whose layers you write; the others hold OpenCode's texts, which you override.
export const WRITTEN: readonly Section[] = ["purpose", "role", "identity", "custom"]

export function isBuiltinText(layer: Layer) {
  return layer.origin === "builtin"
}

export function isReadOnly(layer: Layer) {
  return (
    layer.origin === "builtin" ||
    layer.origin === "slot" ||
    layer.origin === "collection" ||
    layer.origin === "generated"
  )
}

// The layers a group of this type can hold (the server refuses others).
export function allowedIn(type: GroupType, layer: Layer) {
  if (layer.section === "message") return false
  if (type === "tool") return layer.section === "tool"
  if (layer.section === "tool") return false
  if (type === "capabilities" || type === "output") return layer.section === "generated" || layer.section === "output"
  if (type === "platform") return layer.section === "custom"
  if (MANDATORY.includes(layer.id)) return type === "purpose"
  return true
}

export function inScope(projects: Projects, project: string) {
  return projects === "*" || projects.includes(project)
}

// Overrides of a built-in text, most specific first.
export function overridesOf(catalog: Catalog, id: string) {
  return catalog.layers
    .filter((layer) => layer.overrides === id)
    .toSorted((a, b) => (a.projects === "*" ? 1 : 0) - (b.projects === "*" ? 1 : 0) || a.priority - b.priority)
}

// A project's goal layer, if it has one.
export function goalOf(catalog: Catalog, project: string) {
  return catalog.layers.find(
    (layer) => layer.purpose === "goal" && layer.projects !== "*" && layer.projects.includes(project),
  )
}

// The groups that list a layer.
export function groupsUsing(catalog: Catalog, id: string) {
  return catalog.groups.filter((group) => group.layers.includes(id))
}

// Profiles that are the default somewhere: "global", or project keys.
export function defaultFor(catalog: Catalog, profile: string) {
  return [
    ...(catalog.defaults.global === profile ? ["global"] : []),
    ...Object.entries(catalog.defaults.projects)
      .filter((pair) => pair[1] === profile)
      .map((pair) => pair[0]),
  ]
}

// A profile's groups after a change to the group of one type; Custom groups keep their order.
export function profileGroups(catalog: Catalog, groups: ReadonlyArray<string>) {
  const types = new Map(catalog.groups.map((group) => [group.id, group.type]))
  return groups.toSorted(
    (a, b) => GROUP_ORDER.indexOf(types.get(a) ?? "custom") - GROUP_ORDER.indexOf(types.get(b) ?? "custom"),
  )
}

// Why a profile cannot be saved, or undefined.
export function profileProblem(catalog: Catalog, groups: ReadonlyArray<string>) {
  const found = groups.map((id) => catalog.groups.find((group) => group.id === id))
  const types = found.map((group) => group?.type)
  const absent = REQUIRED.find((type) => !types.includes(type))
  if (absent) return { kind: "required" as const, type: absent }
  const layers = found.flatMap((group) => group?.layers ?? [])
  const repeated = layers.find((id, index) => layers.indexOf(id) !== index)
  if (repeated) return { kind: "repeated" as const, layer: repeated }
  return undefined
}

// Moves the item at `index` by `by` places.
export function move<T>(items: ReadonlyArray<T>, index: number, by: number) {
  const target = index + by
  if (target < 0 || target >= items.length) return [...items]
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  return next
}

// An id for a copy, unique among `taken`.
export function copyName(name: string, taken: ReadonlyArray<string>) {
  const base = `${name} copy`
  const free = (index: number): string => {
    const candidate = index === 1 ? base : `${base} ${index}`
    return taken.includes(candidate) ? free(index + 1) : candidate
  }
  return free(1)
}
