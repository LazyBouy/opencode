export * as OperatorProfile from "./profile"

import { Schema } from "effect"
import { OperatorPromptText } from "./prompt-text"

// Prompt profiles (spec: specs/docs/feedbacks/after iteration 4/prompt_profile_redesign_v2.md).
//
// A namespace (an organization) holds group types, layers, groups and profiles. A group type is a
// category of layer; a layer is one piece of text of one type; a group is an ordering of types; a
// profile is a group plus, for each type, an ordered slot of layers of that type. An agent (a project
// and an agent name) uses a profile, optionally with an override of some slots. Purpose is automatic:
// the namespace's purpose, then the project's Project Purpose.
//
// This module is pure (no services, no files), so the plugin that builds every request's system
// prompt and the agent page's preview call the same `assemble`. profile-store.ts reads and writes.

// The built-in namespace; every project is in it unless moved.
export const OPENCODE = "opencode"
// Built-in ids start with this, so they never clash with ids people make.
export const PREFIX = "opencode:"
// Agents that use the OpenCode helper profile unless they name a profile of their own.
export const HELPER_AGENTS = ["title", "summary", "compaction"]

export const BUILTIN_TYPES = [
  { id: "platform", name: "Platform/system constraints" },
  { id: "purpose", name: "Purpose" },
  { id: "role", name: "Agent role" },
  { id: "identity", name: "Agent identity" },
  { id: "capabilities", name: "Stable capability boundaries" },
  { id: "additional", name: "Optional additional blocks" },
  { id: "output", name: "Output format" },
] as const
export const REQUIRED_TYPES = ["purpose", "role", "identity"]

export const Section = Schema.Literals([
  "base",
  "purpose",
  "role",
  "identity",
  "tool",
  "generated",
  "output",
  "custom",
  "message",
]).annotate({ identifier: "OperatorPromptSection" })
export type Section = typeof Section.Type

export const Origin = Schema.Literals(["builtin", "slot", "generated", "automatic", "user"]).annotate({
  identifier: "OperatorPromptOrigin",
  description:
    "builtin: OpenCode's own text; slot: resolved per request (base prompt, agent prompt); generated: written per request; automatic: the org purpose; user: made in this namespace",
})
export type Origin = typeof Origin.Type

export const GroupType = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  builtin: Schema.Boolean,
}).annotate({ identifier: "OperatorPromptGroupType" })
export type GroupType = typeof GroupType.Type

export const Layer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String.annotate({ description: "The group type id" }),
  section: Section,
  replaces: Schema.optional(Schema.String).annotate({
    description: "For an editable copy: the built-in text it stands in for",
  }),
  text: Schema.String,
  origin: Origin,
  delivery: Schema.optional(Schema.Literals(["tool", "conversation"])).annotate({
    description: "Texts not sent in the system prompt: with the tool, or in the conversation",
  }),
}).annotate({ identifier: "OperatorPromptLayer" })
export type Layer = typeof Layer.Type

export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  types: Schema.Array(Schema.String),
  builtin: Schema.Boolean,
}).annotate({ identifier: "OperatorPromptGroup" })
export type Group = typeof Group.Type

export const Slots = Schema.Record(Schema.String, Schema.Array(Schema.String)).annotate({
  identifier: "OperatorPromptSlots",
  description: "For each group type, the ordered layers of that type",
})
export type Slots = typeof Slots.Type

export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  group: Schema.String,
  slots: Slots,
  builtin: Schema.Boolean,
}).annotate({ identifier: "OperatorPromptProfile" })
export type Profile = typeof Profile.Type

export const Namespace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  purpose: Schema.String.annotate({ description: "The org purpose, sent first in every agent's prompt" }),
  defaultProfile: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "OperatorNamespace" })
export type Namespace = typeof Namespace.Type

export const ProjectSetting = Schema.Struct({
  namespace: Schema.String,
  purpose: Schema.optional(Schema.String).annotate({ description: "The linked Project Purpose layer" }),
  defaultProfile: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorProjectSetting" })
export type ProjectSetting = typeof ProjectSetting.Type

export const Override = Schema.Struct({
  group: Schema.optional(Schema.String),
  slots: Schema.optional(Slots),
}).annotate({ identifier: "OperatorPromptOverride" })
export type Override = typeof Override.Type

export const AgentSetting = Schema.Struct({
  profile: Schema.optional(Schema.String),
  override: Schema.optional(Override),
}).annotate({ identifier: "OperatorAgentPrompt" })
export type AgentSetting = typeof AgentSetting.Type

// A namespace's own items. Built-in items are added where needed.
export type Catalog = {
  readonly namespace: Namespace
  readonly types: ReadonlyArray<GroupType>
  readonly layers: ReadonlyArray<Layer>
  readonly groups: ReadonlyArray<Group>
  readonly profiles: ReadonlyArray<Profile>
}

// The system prompt's parts as OpenCode writes them for a request, before they are joined.
export type Parts = {
  readonly environment: ReadonlyArray<string>
  readonly instructions: ReadonlyArray<string>
  readonly mcp?: string
  readonly skills?: string
  readonly output?: string
  readonly user?: string
  readonly extra?: ReadonlyArray<string>
}

export const builtinTypes: GroupType[] = BUILTIN_TYPES.map((item) => ({
  id: item.id,
  name: item.name,
  description: "",
  builtin: true,
}))

const base = (id: string) => `${PREFIX}${id}`
const MESSAGE_TEXTS = [
  "reminder.plan",
  "reminder.plan-mode",
  "reminder.build-switch",
  "notice.max-steps",
  "generator.agent",
]

export const BUILTIN_LAYERS: readonly Layer[] = [
  ...OperatorPromptText.BUILTINS.filter((item) => item.kind === "base" && item.id !== "base").map((item) =>
    layer(base(item.id), item.id, "identity", "base", "builtin", item.text),
  ),
  layer(base("slot.base"), "Base prompt (by model)", "identity", "base", "slot"),
  layer(base("slot.agent-or-base"), "Agent prompt, else base prompt", "identity", "base", "slot"),
  layer(base("slot.agent"), "Agent prompt", "identity", "identity", "slot"),
  layer(base("generated.mcp"), "MCP instructions", "capabilities", "generated", "generated"),
  layer(base("generated.skills"), "Skills", "capabilities", "generated", "generated"),
  layer(base("generated.environment"), "Environment", "additional", "generated", "generated"),
  layer(base("generated.references"), "References", "additional", "generated", "generated"),
  layer(base("generated.instructions"), "Instructions", "additional", "generated", "generated"),
  layer(
    base("notice.structured-output"),
    "notice.structured-output",
    "output",
    "output",
    "builtin",
    text("notice.structured-output"),
  ),
  ...MESSAGE_TEXTS.map((id) => ({
    ...layer(base(id), id, "platform", "message", "builtin", text(id)),
    delivery: "conversation" as const,
  })),
  layer(base("purpose.org"), "Org purpose", "purpose", "purpose", "automatic"),
]

export const BUILTIN_GROUPS: readonly Group[] = [
  {
    id: base("group.spec"),
    name: "Default",
    types: ["platform", "purpose", "role", "identity", "capabilities", "additional", "output"],
    builtin: true,
  },
  {
    id: base("group.opencode"),
    name: "OpenCode",
    types: ["purpose", "role", "identity", "additional", "capabilities", "output"],
    builtin: true,
  },
]

const ENVIRONMENT = [base("generated.environment"), base("generated.references"), base("generated.instructions")]
const CAPABILITIES = [base("generated.mcp"), base("generated.skills")]
export const BUILTIN_PROFILES: readonly Profile[] = [
  {
    id: base("profile.opencode"),
    name: "OpenCode",
    group: base("group.opencode"),
    slots: {
      role: [],
      identity: [base("slot.agent-or-base")],
      additional: ENVIRONMENT,
      capabilities: CAPABILITIES,
      output: [base("notice.structured-output")],
    },
    builtin: true,
  },
  {
    id: base("profile.helper"),
    name: "OpenCode helper",
    group: base("group.opencode"),
    slots: { identity: [base("slot.agent-or-base")] },
    builtin: true,
  },
  {
    id: base("profile.spec"),
    name: "Spec",
    group: base("group.spec"),
    slots: {
      platform: [],
      role: [],
      identity: [base("slot.base"), base("slot.agent")],
      capabilities: CAPABILITIES,
      additional: ENVIRONMENT,
      output: [base("notice.structured-output")],
    },
    builtin: true,
  },
]
export const OPENCODE_PROFILE = base("profile.opencode")
export const HELPER_PROFILE = base("profile.helper")

// The key a project is stored under: its worktree, or the folder itself outside git.
export function projectKey(ctx: { directory: string; worktree: string }) {
  return ctx.worktree === "/" ? ctx.directory : ctx.worktree
}

export function isBuiltin(id: string) {
  return id.startsWith(PREFIX)
}

// Every type, layer, group and profile visible in a namespace: its own and the built-ins.
export function types(catalog: Catalog) {
  return [...builtinTypes, ...catalog.types]
}
export function groups(catalog: Catalog) {
  return [...BUILTIN_GROUPS, ...catalog.groups]
}
export function profiles(catalog: Catalog) {
  return [...BUILTIN_PROFILES, ...catalog.profiles]
}
// Tool descriptions are built in for every tool id (`opencode:tool.<id>`); their text comes from the
// tool registry, so here it is empty.
export function findLayer(catalog: Catalog, id: string) {
  const known = BUILTIN_LAYERS.find((item) => item.id === id) ?? catalog.layers.find((item) => item.id === id)
  if (known) return known
  if (!id.startsWith(base("tool."))) return undefined
  return { ...layer(id, id.slice(PREFIX.length), "capabilities", "tool", "builtin"), delivery: "tool" as const }
}

export type Source = "agent" | "helper" | "project" | "namespace"

// The profile an agent uses (spec §4): its own setting; for title, summary and compaction the
// OpenCode helper profile; the project's default; the namespace's default; else OpenCode.
export function profileFor(
  catalog: Catalog,
  input: { agent: string; setting?: AgentSetting; project?: ProjectSetting },
): { profile: Profile; source: Source } {
  const find = (id: string | undefined) => (id ? profiles(catalog).find((item) => item.id === id) : undefined)
  const own = find(input.setting?.profile)
  if (own) return { profile: own, source: "agent" }
  if (HELPER_AGENTS.includes(input.agent)) return { profile: find(HELPER_PROFILE)!, source: "helper" }
  const project = find(input.project?.defaultProfile)
  if (project) return { profile: project, source: "project" }
  return { profile: find(catalog.namespace.defaultProfile) ?? find(OPENCODE_PROFILE)!, source: "namespace" }
}

// A profile with an agent's override applied: the override's group if it has one, and its slots for
// the types it changed. A type the group drops is not sent; one it adds starts empty.
export function effective(catalog: Catalog, profile: Profile, override?: Override) {
  const group =
    groups(catalog).find((item) => item.id === (override?.group ?? profile.group)) ??
    BUILTIN_GROUPS.find((item) => item.id === base("group.opencode"))!
  const slots = Object.fromEntries(
    group.types.map((type) => [type, override?.slots?.[type] ?? profile.slots[type] ?? []] as const),
  )
  return { group, slots, changed: Object.keys(override?.slots ?? {}).filter((type) => group.types.includes(type)) }
}

export const AssembledSection = Schema.Struct({
  type: Schema.String,
  typeName: Schema.String,
  layer: Schema.String.annotate({ description: "The layer the text comes from" }),
  layerName: Schema.String,
  entry: Schema.String.annotate({
    description: "The layer as the slot lists it (a slot such as Base prompt, or a layer)",
  }),
  automatic: Schema.Boolean.annotate({ description: "Purpose, which every agent gets" }),
  changed: Schema.Boolean.annotate({ description: "From a slot the agent's override changed" }),
  source: Schema.String.annotate({ description: "A file path, or what wrote the text" }),
  text: Schema.String,
}).annotate({ identifier: "OperatorPromptAssembledSection" })
export type AssembledSection = typeof AssembledSection.Type

export type AssembleInput = {
  readonly catalog: Catalog
  readonly project?: ProjectSetting
  readonly agent: { readonly name: string; readonly prompt?: string }
  readonly setting?: AgentSetting
  // Preview another profile than the agent's own (the agent's override is then not applied).
  readonly profile?: string
  readonly model: OperatorPromptText.ModelRef
  readonly parts: Parts
}

// Builds a request's system prompt (spec §5): the profile's group in order, each type's slot in
// order, every non-empty text joined with "\n" into one system message, as upstream does, then the
// message's own system text. With the OpenCode profile and no purposes it is upstream's prompt,
// byte for byte.
export function assemble(input: AssembleInput) {
  const chosen = input.profile
    ? { profile: profiles(input.catalog).find((item) => item.id === input.profile), source: "agent" as const }
    : profileFor(input.catalog, { agent: input.agent.name, setting: input.setting, project: input.project })
  const profile = chosen.profile ?? profiles(input.catalog).find((item) => item.id === OPENCODE_PROFILE)!
  const shape = effective(input.catalog, profile, input.profile ? undefined : input.setting?.override)
  const names = new Map(types(input.catalog).map((item) => [item.id, item.name]))
  const copies = copiesIn(input.catalog, shape.slots)
  const sections = shape.group.types.flatMap((type) => {
    const found =
      type === "purpose"
        ? purpose(input).map((item) => ({ ...item, entry: item.layer.id }))
        : (shape.slots[type] ?? []).flatMap((entry) =>
            resolve(input, copies, entry).map((item) => ({ ...item, entry })),
          )
    return found
      .filter((item) => item.text !== "")
      .map((item) => ({
        type,
        typeName: names.get(type) ?? type,
        layer: item.layer.id,
        layerName: item.layer.name,
        entry: item.entry,
        automatic: type === "purpose",
        changed: shape.changed.includes(type),
        source: item.source,
        text: item.text,
      }))
  })
  const system = [...sections.map((item) => item.text), ...(input.parts.extra ?? []), input.parts.user ?? ""]
    .filter((text) => text)
    .join("\n")
  return {
    profile: { id: profile.id, name: profile.name, source: chosen.source },
    group: { id: shape.group.id, name: shape.group.name },
    changed: shape.changed,
    sections,
    system: system ? [system] : [],
  }
}

// The version of a text an agent uses: the copy of it in the profile's slot of the text's type, else
// OpenCode's. Tool descriptions are copies in Stable capability boundaries; reminders, notices and
// the agent generator are copies in Platform/system constraints.
export function versionOf(input: { catalog: Catalog; slots: Slots; builtin: string }) {
  return copiesIn(input.catalog, input.slots).get(input.builtin)?.text
}

// What a profile-or-agent combination looks like once resolved, for texts that are not in the
// system prompt.
export function slotsFor(
  catalog: Catalog,
  input: { agent?: string; setting?: AgentSetting; project?: ProjectSetting },
) {
  if (!input.agent) {
    const find = (id: string | undefined) => (id ? profiles(catalog).find((item) => item.id === id) : undefined)
    const profile =
      find(input.project?.defaultProfile) ?? find(catalog.namespace.defaultProfile) ?? find(OPENCODE_PROFILE)!
    return effective(catalog, profile).slots
  }
  const chosen = profileFor(catalog, { agent: input.agent, setting: input.setting, project: input.project })
  return effective(catalog, chosen.profile, input.setting?.override).slots
}

// Copies of built-in texts placed in the given slots, by the built-in they stand in for.
function copiesIn(catalog: Catalog, slots: Slots) {
  return new Map(
    Object.values(slots)
      .flat()
      .map((id) => catalog.layers.find((item) => item.id === id))
      .filter((item): item is Layer => item?.replaces !== undefined)
      .map((item) => [item.replaces!, item] as const),
  )
}

type Found = { layer: Layer; text: string; source: string }

// Purpose: the namespace's purpose, then the project's Project Purpose layer.
function purpose(input: AssembleInput): Found[] {
  const org = BUILTIN_LAYERS.find((item) => item.id === base("purpose.org"))!
  const linked = input.project?.purpose
    ? input.catalog.layers.find((item) => item.id === input.project!.purpose)
    : undefined
  return [
    { layer: org, text: input.catalog.namespace.purpose, source: input.catalog.namespace.name },
    ...(linked ? [{ layer: linked, text: linked.text, source: linked.name }] : []),
  ]
}

// The text a slot entry stands for in this request.
function resolve(input: AssembleInput, copies: Map<string, Layer>, entry: string): Found[] {
  const found = findLayer(input.catalog, entry)
  if (!found) return []
  const one = (text: string | undefined, source: string, layer: Layer = found): Found[] =>
    text ? [{ layer, text, source }] : []
  // A family's base prompt, or the copy of it the profile holds.
  const family = (id: string) => {
    const copy = copies.get(id)
    const text = copy?.text ?? findLayer(input.catalog, id)?.text ?? ""
    return { text: id === base("base.meta") ? OperatorPromptText.renderMeta(text, input.model) : text, layer: copy }
  }
  const model = () => {
    const id = base(OperatorPromptText.baseFor(input.model).id)
    const chosen = family(id)
    return one(chosen.text, chosen.layer?.name ?? id.slice(PREFIX.length), chosen.layer ?? found)
  }
  // Copies stand in for their built-in where it is used; on their own they add nothing.
  if (found.replaces) {
    if (found.replaces !== base("notice.structured-output") || !input.parts.output) return []
    return one(found.text, found.name)
  }
  if (found.section === "base" && found.origin === "builtin") {
    const chosen = family(found.id)
    return one(chosen.text, chosen.layer?.name ?? "OpenCode", chosen.layer ?? found)
  }
  if (found.id === base("slot.base")) return model()
  if (found.id === base("slot.agent")) return one(input.agent.prompt, input.agent.name)
  if (found.id === base("slot.agent-or-base"))
    return input.agent.prompt ? one(input.agent.prompt, input.agent.name) : model()
  if (found.id === base("generated.environment")) return one(input.parts.environment[0], "generated")
  if (found.id === base("generated.references")) return one(input.parts.environment[1], "generated")
  if (found.id === base("generated.mcp")) return one(input.parts.mcp, "generated")
  if (found.id === base("generated.skills")) return one(input.parts.skills, "generated")
  if (found.id === base("generated.instructions"))
    return input.parts.instructions.flatMap((text) =>
      one(text, text.match(/^Instructions from: ([^\n]*)/)?.[1] ?? "generated"),
    )
  if (found.id === base("notice.structured-output"))
    return input.parts.output && !copies.has(found.id) ? one(input.parts.output, "OpenCode") : []
  // Tool descriptions and message texts are sent elsewhere; the org purpose only in Purpose.
  if (found.delivery || found.origin === "automatic") return []
  return one(found.text, found.name)
}

// Save checks (spec §10). Each returns the reason a save is refused, or undefined.

export function checkGroup(catalog: Catalog, group: { name: string; types: ReadonlyArray<string> }) {
  if (!group.name.trim()) return "A group needs a name"
  const known = types(catalog).map((item) => item.id)
  const unknown = group.types.find((type) => !known.includes(type))
  if (unknown) return `No group type "${unknown}"`
  if (new Set(group.types).size !== group.types.length) return "A type can be in a group only once"
  const absent = REQUIRED_TYPES.find((type) => !group.types.includes(type))
  if (absent) return `A group needs ${typeName(catalog, absent)}`
  return undefined
}

// A profile, or a profile with an override applied: its group and slots.
export function checkSlots(catalog: Catalog, shape: { group: string; slots: Slots }) {
  const group = groups(catalog).find((item) => item.id === shape.group)
  if (!group) return `No group "${shape.group}"`
  if ((shape.slots.purpose ?? []).length) return "Purpose is automatic: it cannot hold layers"
  const extra = Object.keys(shape.slots).find((type) => !group.types.includes(type) && shape.slots[type]!.length)
  if (extra) return `${typeName(catalog, extra)} is not in the group "${group.name}"`
  const all = Object.values(shape.slots).flat()
  const repeated = all.find((id, index) => all.indexOf(id) !== index)
  if (repeated) return `"${findLayer(catalog, repeated)?.name ?? repeated}" is in the profile more than once`
  for (const [type, ids] of Object.entries(shape.slots)) {
    for (const id of ids) {
      const found = findLayer(catalog, id)
      if (!found) return `No layer "${id}"`
      if (found.type !== type)
        return `"${found.name}" is ${typeName(catalog, found.type)}, not ${typeName(catalog, type)}`
      if (found.origin === "automatic") return "Purpose is automatic: it cannot hold layers"
    }
  }
  const replaced = all.map((id) => findLayer(catalog, id)?.replaces).filter((id): id is string => id !== undefined)
  const twice = replaced.find((id, index) => replaced.indexOf(id) !== index)
  if (twice) return `A profile can hold one copy of ${twice.slice(PREFIX.length)}`
  return undefined
}

export function checkLayer(catalog: Catalog, input: { name: string; type: string; replaces?: string }) {
  if (!input.name.trim()) return "A layer needs a name"
  if (!types(catalog).some((item) => item.id === input.type)) return `No group type "${input.type}"`
  if (!input.replaces) return undefined
  const original = findLayer(catalog, input.replaces)
  if (!original || original.origin !== "builtin") return `"${input.replaces}" is not one of OpenCode's texts`
  if (original.type !== input.type) return `A copy of ${original.name} keeps its type`
  return undefined
}

function typeName(catalog: Catalog, id: string) {
  return types(catalog).find((item) => item.id === id)?.name ?? id
}

function text(id: string) {
  return OperatorPromptText.BUILTINS.find((item) => item.id === id)?.text ?? ""
}

function layer(id: string, name: string, type: string, section: Section, origin: Origin, value = ""): Layer {
  return { id, name, type, section, text: value, origin }
}
