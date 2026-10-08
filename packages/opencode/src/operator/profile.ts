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
export const BUILTIN_TYPES = [
  { id: "platform", name: "Platform/system constraints" },
  { id: "purpose", name: "Purpose" },
  { id: "role", name: "Agent role" },
  { id: "identity", name: "Agent identity" },
  { id: "dynamic", name: "Dynamic" },
  { id: "capabilities", name: "Stable capability boundaries" },
  { id: "additional", name: "Optional additional blocks" },
  { id: "output", name: "Output format" },
  { id: "helper", name: "Helper" },
] as const
export const REQUIRED_TYPES = ["purpose", "role", "identity"]
// Texts filled in per request (the agent's prompt, the base prompt for the model, the environment,
// skills, ...) are of this type.
export const DYNAMIC = "dynamic"
// A helper agent's whole prompt is one layer of this type: a group with it holds no other type, and a
// profile of such a group (a helper profile) one layer. An agent that uses a helper profile is a helper
// agent; it has no override.
export const HELPER = "helper"

export const Section = Schema.Literals([
  "base",
  "purpose",
  "role",
  "identity",
  "tool",
  "dynamic",
  "helper",
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
  basedOn: Schema.optional(Schema.String).annotate({
    description: "A copy of OpenCode's text: a fingerprint of the text it was made from",
  }),
  outdated: Schema.optional(Schema.Boolean).annotate({
    description: "A copy of OpenCode's text that OpenCode has changed since (a release); it can take the new text",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "Your Dynamic layers: what the dynamic generator writes for each session",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "OpenCode's built-ins: the file in OpenCode's code the text comes from (repo path)",
  }),
}).annotate({ identifier: "OperatorPromptLayer" })

// One step of how a section of a prompt was resolved, for the agent page to trace it to its source:
// what was decided (the agent has its own prompt or none; the model's base prompt rule), the layer the
// text is in (OpenCode's, a copy, a namespace's own version, yours), and the file it is in. The store's
// files and the agents' definitions are added by the caller (prompts.ts), which can read them.
export const TraceStep = Schema.Struct({
  kind: Schema.Literals([
    "agent-own",
    "agent-none",
    "agent-file",
    "agent-config",
    "agent-builtin",
    "model-rule",
    "builtin-layer",
    "copy-layer",
    "own-layer",
    "layer",
    "file",
    "org-purpose",
    "dynamic-written",
    "written",
    "references",
    "config",
    "instruction-file",
    "instruction-url",
    "mcp",
    "skill",
  ]).annotate({
    description:
      "agent-own / agent-none: the agent has its own prompt, or none; agent-file / agent-config / agent-builtin: where it is defined (its agent file, a config file, OpenCode's own definition); model-rule: the base prompt's model and the rule that chose it; builtin-layer / copy-layer / own-layer / layer: the layer the text is in; file: the file it is in; org-purpose: the namespace's purpose; dynamic-written: written for each session by the dynamic generator; written: written by OpenCode for each request; references / config: the references in config files; instruction-file / instruction-url, mcp, skill: what a per-request text was made from",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "An agent, layer, model, namespace or server" }),
  path: Schema.optional(Schema.String).annotate({ description: "A file or URL" }),
  detail: Schema.optional(Schema.String).annotate({ description: "A layer's id, or the model rule" }),
}).annotate({ identifier: "OperatorPromptTraceStep" })
export type TraceStep = typeof TraceStep.Type
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
  folder: Schema.optional(Schema.String).annotate({
    description: "The namespace's folder: its projects are created in it, and it holds the namespace's memory",
  }),
  defaultProject: Schema.optional(Schema.String).annotate({
    description: "The project chosen as the namespace's default; without one, its first project is the default",
  }),
  inheritGlobal: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether the namespace's projects get the global config's capabilities (commands, skills, tools, MCP servers, agents, plugins, instructions, permissions, references); on unless set to false, and always on for OpenCode",
  }),
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
const MESSAGE_TEXTS = ["reminder.plan", "reminder.plan-mode", "reminder.build-switch", "notice.max-steps"]
const HELPERS = OperatorPromptText.BUILTINS.filter((item) => item.kind === "helper")
const FILES = new Map(OperatorPromptText.BUILTINS.flatMap((item) => (item.file ? [[base(item.id), item.file]] : [])))

export const BUILTIN_LAYERS: readonly Layer[] = [
  ...OperatorPromptText.BUILTINS.filter((item) => item.kind === "base" && item.id !== "base").map((item) =>
    layer(base(item.id), item.id, "identity", "base", "builtin", item.text),
  ),
  layer(base("slot.base"), "Base prompt (by model)", DYNAMIC, "dynamic", "slot"),
  layer(base("slot.agent-or-base"), "Agent prompt, else base prompt", DYNAMIC, "dynamic", "slot"),
  layer(base("slot.agent"), "Agent prompt", DYNAMIC, "dynamic", "slot"),
  layer(base("generated.mcp"), "MCP instructions", DYNAMIC, "dynamic", "generated"),
  layer(base("generated.skills"), "Skills", DYNAMIC, "dynamic", "generated"),
  layer(base("generated.environment"), "Environment", DYNAMIC, "dynamic", "generated"),
  layer(base("generated.references"), "References", DYNAMIC, "dynamic", "generated"),
  layer(base("generated.instructions"), "Instructions", DYNAMIC, "dynamic", "generated"),
  ...HELPERS.map((item) =>
    layer(base(item.id), item.id.slice("helper.".length), HELPER, "helper", "builtin", item.text),
  ),
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
].map((item) => (FILES.has(item.id) ? { ...item, file: FILES.get(item.id) } : item))

export const BUILTIN_GROUPS: readonly Group[] = [
  {
    id: base("group.spec"),
    name: "Default",
    types: ["platform", "purpose", "role", "identity", DYNAMIC, "capabilities", "additional", "output"],
    builtin: true,
  },
  {
    id: base("group.opencode"),
    name: "OpenCode",
    types: ["purpose", "role", "identity", DYNAMIC, "additional", "capabilities", "output"],
    builtin: true,
  },
  { id: base("group.helper"), name: "Helper", types: [HELPER], builtin: true },
]

const ENVIRONMENT = [base("generated.environment"), base("generated.references"), base("generated.instructions")]
const CAPABILITIES = [base("generated.mcp"), base("generated.skills")]
// One helper profile per helper text, named after it ("agent-generator" is "Agent generator").
const helperName = (id: string) => {
  const words = id.slice("helper.".length).replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
export const BUILTIN_PROFILES: readonly Profile[] = [
  {
    id: base("profile.opencode"),
    name: "OpenCode",
    group: base("group.opencode"),
    slots: {
      role: [],
      identity: [],
      [DYNAMIC]: [base("slot.agent-or-base"), ...ENVIRONMENT, ...CAPABILITIES],
      output: [base("notice.structured-output")],
    },
    builtin: true,
  },
  {
    id: base("profile.spec"),
    name: "Spec",
    group: base("group.spec"),
    slots: {
      platform: [],
      role: [],
      identity: [],
      [DYNAMIC]: [base("slot.base"), base("slot.agent"), ...CAPABILITIES, ...ENVIRONMENT],
      output: [base("notice.structured-output")],
    },
    builtin: true,
  },
  ...HELPERS.map((item) => ({
    id: base(`profile.${item.id}`),
    name: helperName(item.id),
    group: base("group.helper"),
    slots: { [HELPER]: [base(item.id)] },
    builtin: true,
  })),
]
export const OPENCODE_PROFILE = base("profile.opencode")
// The helper profile each of OpenCode's helper agents uses unless it names a profile of its own. The
// agent generator is not an agent; its one call goes by this name.
export const AGENT_GENERATOR = "agent-generator"
// The fork's own helper agents: they draft purposes and write your Dynamic layers.
export const PURPOSE_GENERATOR = "purpose-generator"
export const DYNAMIC_GENERATOR = "dynamic-generator"
export const HELPER_DEFAULTS: ReadonlyMap<string, string> = new Map(
  ["title", "summary", "compaction", AGENT_GENERATOR, PURPOSE_GENERATOR, DYNAMIC_GENERATOR].map((name) => [
    name,
    base(`profile.helper.${name}`),
  ]),
)
// The helper profile that replaced "OpenCode helper", which every helper agent used.
const LEGACY_HELPER = base("profile.helper")

// The key a project is stored under: its worktree, or the folder itself outside git.
export function projectKey(ctx: { directory: string; worktree: string }) {
  return ctx.worktree === "/" ? ctx.directory : ctx.worktree
}

export function isBuiltin(id: string) {
  return id.startsWith(PREFIX)
}

// OpenCode's built-in layers, groups and profiles belong to the OpenCode namespace. Every other
// namespace has its own copies of them (made when it is created; see the store), editable there: its
// own version of the built-in "opencode:<x>" has the id "<x>" (an id names can never make, since
// names are slugged without dots or colons), and keeps `replaces` (layers) as its link to OpenCode's.
export function isOpenCode(catalog: Catalog) {
  return catalog.namespace.id === OPENCODE
}
export function own(id: string) {
  return isBuiltin(id) ? id.slice(PREFIX.length) : id
}
// The id a namespace uses for a built-in: the built-in itself in OpenCode, its own version elsewhere.
export function versionId(catalog: Catalog, builtin: string) {
  return isOpenCode(catalog) ? builtin : own(builtin)
}
// The built-in an item is, or is a namespace's own version of; undefined for anything else.
export function builtinOf(kind: "layer" | "group" | "profile", id: string) {
  const full = isBuiltin(id) ? id : `${PREFIX}${id}`
  if (kind === "layer")
    return BUILTIN_LAYERS.some((item) => item.id === full) || full.startsWith(base("tool.")) ? full : undefined
  if (kind === "group") return BUILTIN_GROUPS.some((item) => item.id === full) ? full : undefined
  return BUILTIN_PROFILES.some((item) => item.id === full) ? full : undefined
}

// Every type, layer, group and profile visible in a namespace: its own, and in OpenCode the built-ins.
// The built-in types are shared: they are the structure the code relies on.
export function types(catalog: Catalog) {
  return [...builtinTypes, ...catalog.types]
}
export function groups(catalog: Catalog) {
  return isOpenCode(catalog) ? [...BUILTIN_GROUPS, ...catalog.groups] : [...catalog.groups]
}
export function profiles(catalog: Catalog) {
  return isOpenCode(catalog) ? [...BUILTIN_PROFILES, ...catalog.profiles] : [...catalog.profiles]
}
// The built-in a layer is, or stands in for: itself, or the one its copy replaces.
export function builtinLayer(layer: Layer) {
  const id = layer.origin === "user" ? layer.replaces : layer.id
  return id ? BUILTIN_LAYERS.find((item) => item.id === id) : undefined
}
// A layer filled in per request (the agent's prompt, the environment, ...): OpenCode's, or a copy.
export function isPerRequest(layer: Layer | undefined) {
  const builtin = layer ? builtinLayer(layer) : undefined
  return builtin?.origin === "slot" || builtin?.origin === "generated"
}
// A Dynamic layer of yours: the dynamic generator writes its text for each session from its prompt.
export function isWrittenDynamic(layer: Layer | undefined): boolean {
  return layer?.type === DYNAMIC && layer.origin === "user" && !layer.replaces
}

// A helper profile: its group holds the Helper type.
export function isHelper(catalog: Catalog, profile: { group: string }) {
  return groups(catalog).some((item) => item.id === profile.group && item.types.includes(HELPER))
}
// Tool descriptions are built in for every tool id (`opencode:tool.<id>`); their text comes from the
// tool registry, so here it is empty.
export function findLayer(catalog: Catalog, id: string) {
  const mine = catalog.layers.find((item) => item.id === id)
  if (mine || !isOpenCode(catalog)) return mine
  return builtinLayerById(id)
}

// One of OpenCode's built-in layers, whichever namespace asks (to copy it, or to check a copy).
export function builtinLayerById(id: string): Layer | undefined {
  const known = BUILTIN_LAYERS.find((item) => item.id === id)
  if (known) return known
  if (!id.startsWith(base("tool."))) return undefined
  return { ...layer(id, id.slice(PREFIX.length), "capabilities", "tool", "builtin"), delivery: "tool" as const }
}

export type Source = "agent" | "helper" | "project" | "namespace"

// The profile an agent uses (spec §4): its own setting; for OpenCode's helper agents their helper
// profile; the project's default; the namespace's default; else OpenCode.
export function profileFor(
  catalog: Catalog,
  input: { agent: string; setting?: AgentSetting; project?: ProjectSetting },
): { profile: Profile; source: Source } {
  const find = (id: string | undefined) => (id ? profiles(catalog).find((item) => item.id === id) : undefined)
  const own = find(input.setting?.profile)
  if (own) return { profile: own, source: "agent" }
  const helperDefault = HELPER_DEFAULTS.get(input.agent)
  const helper = find(helperDefault && versionId(catalog, helperDefault))
  if (helper) return { profile: helper, source: "helper" }
  const project = find(input.project?.defaultProfile)
  if (project) return { profile: project, source: "project" }
  return { profile: find(catalog.namespace.defaultProfile) ?? fallbackProfile(catalog), source: "namespace" }
}

// The OpenCode profile (a namespace's own version of it), else OpenCode's built-in.
function fallbackProfile(catalog: Catalog) {
  return profiles(catalog).find((item) => item.id === versionId(catalog, OPENCODE_PROFILE)) ?? BUILTIN_PROFILES[0]!
}

// A profile with an agent's override applied: the override's group if it has one, and its slots for
// the types it changed. A type the group drops is not sent; one it adds starts empty. A helper agent
// has no override.
export function effective(catalog: Catalog, profile: Profile, given?: Override) {
  const override = isHelper(catalog, profile) ? undefined : given
  const group =
    groups(catalog).find((item) => item.id === (override?.group ?? profile.group)) ??
    groups(catalog).find((item) => item.id === versionId(catalog, base("group.opencode"))) ??
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
  trace: Schema.Array(TraceStep).annotate({ description: "How the section was resolved, down to its file" }),
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
  // The texts of your Dynamic layers for this request (written per session); a layer without one adds
  // nothing.
  readonly dynamic?: ReadonlyMap<string, string>
}

// Builds a request's system prompt (spec §5): the profile's group in order, each type's slot in
// order, every non-empty text joined with "\n" into one system message, as upstream does, then the
// message's own system text. With the OpenCode profile and no purposes it is upstream's prompt,
// byte for byte.
export function assemble(input: AssembleInput) {
  const chosen = input.profile
    ? { profile: profiles(input.catalog).find((item) => item.id === input.profile), source: "agent" as const }
    : profileFor(input.catalog, { agent: input.agent.name, setting: input.setting, project: input.project })
  const profile = chosen.profile ?? fallbackProfile(input.catalog)
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
        trace: item.trace,
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

// What one layer fills in for a request: a Dynamic layer's sample (the agent's prompt, the base prompt
// for the model, the environment, ...), or a fixed layer's text.
export function sample(input: AssembleInput, id: string) {
  const found = findLayer(input.catalog, id)
  if (!found) return undefined
  if (found.origin === "automatic")
    return {
      text: input.catalog.namespace.purpose,
      source: input.catalog.namespace.name,
      trace: [{ kind: "org-purpose" as const, name: input.catalog.namespace.name }],
    }
  if ((found.replaces && !isPerRequest(found)) || found.type === HELPER)
    return { text: found.text, source: found.name, trace: layerTrace(input.catalog, found) }
  if (isWrittenDynamic(found))
    return {
      text: input.dynamic?.get(found.id) ?? "",
      source: found.name,
      trace: [{ kind: "dynamic-written" as const, name: found.name }, ...layerTrace(input.catalog, found)],
    }
  const items = resolve(input, new Map(), id)
  // The agent's prompt slot adds nothing for an agent without one; say so.
  const none: TraceStep[] =
    !items.length && (builtinLayer(found)?.id ?? found.id) === base("slot.agent")
      ? [{ kind: "agent-none", name: input.agent.name }]
      : []
  return {
    text: items.map((item) => item.text).join("\n"),
    source: items[0]?.source ?? "",
    trace: [...none, ...items.flatMap((item) => item.trace)],
  }
}

// The version of a text an agent uses: the copy of it in the profile's slot of the text's type, else
// OpenCode's. Tool descriptions are copies in Stable capability boundaries; reminders, notices and
// the agent generator are copies in Platform/system constraints.
export function versionOf(input: { catalog: Catalog; slots: Slots; builtin: string }) {
  return (
    copiesIn(input.catalog, input.slots).get(input.builtin)?.text ??
    (isOpenCode(input.catalog) ? undefined : input.catalog.layers.find((item) => item.id === own(input.builtin))?.text)
  )
}

// Which version of a tool's description (or another delivered text) an agent uses, and where it
// comes from: a copy in its effective profile (from the profile's slot, or the agent's override of
// it), the namespace's own version, or OpenCode's text. The same order as versionOf.
export type TextVersion =
  | { kind: "copy"; layer: Layer; profile: Profile; override: boolean }
  | { kind: "namespace"; layer: Layer }
  | { kind: "opencode" }
export function textVersion(input: {
  catalog: Catalog
  agent: string
  setting?: AgentSetting
  project?: ProjectSetting
  builtin: string
}): TextVersion {
  const chosen = profileFor(input.catalog, { agent: input.agent, setting: input.setting, project: input.project })
  const shape = effective(input.catalog, chosen.profile, input.setting?.override)
  const copy = copiesIn(input.catalog, shape.slots).get(input.builtin)
  if (copy) {
    const type = Object.entries(shape.slots).find(([, ids]) => ids.includes(copy.id))?.[0]
    return { kind: "copy", layer: copy, profile: chosen.profile, override: !!type && shape.changed.includes(type) }
  }
  const mine = isOpenCode(input.catalog)
    ? undefined
    : input.catalog.layers.find((item) => item.id === own(input.builtin))
  return mine ? { kind: "namespace", layer: mine } : { kind: "opencode" }
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
      find(input.project?.defaultProfile) ?? find(catalog.namespace.defaultProfile) ?? fallbackProfile(catalog)
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

type Found = { layer: Layer; text: string; source: string; trace: TraceStep[] }

// The layer a text is in: OpenCode's (with its file), a namespace's own version of one, a copy made
// with Edit a copy, or a layer of yours. The store's file of a namespace's layer is added by the caller.
function layerTrace(catalog: Catalog, item: Layer): TraceStep[] {
  if (item.origin !== "user")
    return [
      { kind: "builtin-layer", name: own(item.id), detail: item.id },
      ...(item.file ? [{ kind: "file" as const, path: item.file }] : []),
    ]
  const standard = !isOpenCode(catalog) && item.replaces !== undefined && item.id === own(item.replaces)
  return [{ kind: standard ? "own-layer" : item.replaces ? "copy-layer" : "layer", name: item.name, detail: item.id }]
}

// What a per-request text was made from, read from the text itself.
function partTrace(kind: "mcp" | "skill", text: string | undefined): TraceStep[] {
  if (!text) return []
  if (kind === "mcp") return [...text.matchAll(/<server name="([^"]+)">/g)].map((match) => ({ kind, name: match[1]! }))
  return [...text.matchAll(/<location>([^<]+)<\/location>/g)].map((match) => ({ kind, path: unescapeHtml(match[1]!) }))
}

function unescapeHtml(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
}

// Purpose: the namespace's purpose, then the project's Project Purpose layer.
function purpose(input: AssembleInput): Found[] {
  const org = BUILTIN_LAYERS.find((item) => item.id === base("purpose.org"))!
  const linked = input.project?.purpose
    ? input.catalog.layers.find((item) => item.id === input.project!.purpose)
    : undefined
  return [
    {
      layer: org,
      text: input.catalog.namespace.purpose,
      source: input.catalog.namespace.name,
      trace: [{ kind: "org-purpose", name: input.catalog.namespace.name }],
    },
    ...(linked
      ? [{ layer: linked, text: linked.text, source: linked.name, trace: layerTrace(input.catalog, linked) }]
      : []),
  ]
}

// The text a slot entry stands for in this request, with how it was resolved.
function resolve(input: AssembleInput, copies: Map<string, Layer>, entry: string): Found[] {
  const listed = findLayer(input.catalog, entry)
  if (!listed) return []
  // A namespace's own version of a built-in (outside OpenCode) works as the built-in, with its text.
  const standard = !isOpenCode(input.catalog) && listed.replaces !== undefined && listed.id === own(listed.replaces)
  const builtin = standard || isPerRequest(listed) ? builtinLayer(listed) : undefined
  const found: Layer = builtin ? { ...builtin, name: listed.name, text: listed.text } : listed
  const one = (text: string | undefined, source: string, trace: TraceStep[], layer: Layer = listed): Found[] =>
    text ? [{ layer, text, source, trace }] : []
  const traced = (item: Layer) => layerTrace(input.catalog, item)
  // A built-in text (a family's base prompt, a built-in agent's prompt): the copy of it the profile
  // holds, else the namespace's own version, else OpenCode's.
  const family = (id: string) => {
    const copy =
      copies.get(id) ??
      (isOpenCode(input.catalog) ? undefined : input.catalog.layers.find((item) => item.id === own(id)))
    const original = BUILTIN_LAYERS.find((item) => item.id === id)
    const text = copy?.text ?? original?.text ?? ""
    return {
      text: id === base("base.meta") ? OperatorPromptText.renderMeta(text, input.model) : text,
      layer: copy,
      trace: copy ? traced(copy) : original ? traced(original) : [],
    }
  }
  const model = () => {
    const id = base(OperatorPromptText.baseFor(input.model).id)
    const chosen = family(id)
    const rule: TraceStep = {
      kind: "model-rule",
      name: `${input.model.providerID}/${input.model.api.id}`,
      detail: OperatorPromptText.baseRule(input.model),
    }
    return one(
      chosen.text,
      chosen.layer?.name ?? id.slice(PREFIX.length),
      [rule, ...chosen.trace],
      chosen.layer ?? listed,
    )
  }
  // The agent's own prompt; where it is defined (its agent file, a config file, OpenCode's own
  // definition) is named by the caller, which can read them.
  const agentPrompt = () => one(input.agent.prompt, input.agent.name, [{ kind: "agent-own", name: input.agent.name }])
  // Copies stand in for their built-in where it is used; on their own they add nothing.
  // A helper agent's prompt is its helper layer, a copy or OpenCode's.
  if (found.type === HELPER)
    return one(listed.text, listed.origin === "builtin" ? "OpenCode" : listed.name, traced(listed))
  if (isWrittenDynamic(found))
    return one(input.dynamic?.get(found.id), found.name, [
      { kind: "dynamic-written", name: found.name },
      ...traced(listed),
    ])
  if (found.replaces) {
    if (found.replaces !== base("notice.structured-output") || !input.parts.output) return []
    return one(found.text, found.name, traced(listed))
  }
  if (found.section === "base" && found.origin === "builtin") {
    const chosen = family(found.id)
    return one(chosen.text, chosen.layer?.name ?? "OpenCode", chosen.trace, chosen.layer ?? listed)
  }
  if (found.id === base("slot.base")) return model()
  if (found.id === base("slot.agent")) return agentPrompt()
  if (found.id === base("slot.agent-or-base"))
    return input.agent.prompt
      ? agentPrompt()
      : model().map((item) => ({
          ...item,
          trace: [{ kind: "agent-none" as const, name: input.agent.name }, ...item.trace],
        }))
  const written: TraceStep[] = [{ kind: "written" }]
  if (found.id === base("generated.environment")) return one(input.parts.environment[0], "generated", written)
  if (found.id === base("generated.references"))
    return one(input.parts.environment[1], "generated", [{ kind: "references" }])
  if (found.id === base("generated.mcp")) return one(input.parts.mcp, "generated", partTrace("mcp", input.parts.mcp))
  if (found.id === base("generated.skills"))
    return one(input.parts.skills, "generated", partTrace("skill", input.parts.skills))
  if (found.id === base("generated.instructions"))
    return input.parts.instructions.flatMap((text) => {
      const from = text.match(/^Instructions from: ([^\n]*)/)?.[1]
      const trace: TraceStep[] = from
        ? [{ kind: /^https?:\/\//.test(from) ? "instruction-url" : "instruction-file", path: from }]
        : []
      return one(text, from ?? "generated", trace)
    })
  if (found.id === base("notice.structured-output")) {
    if (!input.parts.output || (copies.has(found.id) && copies.get(found.id) !== listed)) return []
    return standard ? one(listed.text, listed.name, traced(listed)) : one(input.parts.output, "OpenCode", traced(found))
  }
  // Tool descriptions and message texts are sent elsewhere; the org purpose only in Purpose.
  if (found.delivery || found.origin === "automatic") return []
  return one(found.text, found.name, traced(listed))
}

// Save checks (spec §10). Each returns the reason a save is refused, or undefined.

export function checkGroup(catalog: Catalog, group: { name: string; types: ReadonlyArray<string> }) {
  if (!group.name.trim()) return "A group needs a name"
  const known = types(catalog).map((item) => item.id)
  const unknown = group.types.find((type) => !known.includes(type))
  if (unknown) return `No group type "${unknown}"`
  if (new Set(group.types).size !== group.types.length) return "A type can be in a group only once"
  if (group.types.includes(HELPER))
    return group.types.length === 1 ? undefined : "A group with the Helper type holds no other type"
  const absent = REQUIRED_TYPES.find((type) => !group.types.includes(type))
  if (absent) return `A group needs ${typeName(catalog, absent)}`
  return undefined
}

// A profile, or a profile with an override applied: its group and slots.
export function checkSlots(catalog: Catalog, shape: { group: string; slots: Slots }) {
  const group = groups(catalog).find((item) => item.id === shape.group)
  if (!group) return `No group "${shape.group}"`
  if (group.types.includes(HELPER) && (shape.slots[HELPER] ?? []).length !== 1)
    return "A helper profile holds one helper layer"
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
  const original = builtinLayerById(input.replaces)
  if (!original || original.origin === "automatic" || original.origin === "user")
    return `"${input.replaces}" is not one of OpenCode's texts`
  if (original.type !== input.type) return `A copy of ${original.name} keeps its type`
  return undefined
}

// Before the Dynamic type, texts filled in per request were typed by where they went (Agent identity,
// Stable capability boundaries, Optional additional blocks), and "OpenCode helper" was every helper
// agent's profile. Items saved then are read as they are now: those texts move to the Dynamic slot,
// in the order the group sent them, and the groups of profiles that hold them get Dynamic after Agent
// identity.
const DYNAMIC_LAYERS = new Set(BUILTIN_LAYERS.filter((item) => item.type === DYNAMIC).map((item) => item.id))

export function migrateSlots(slots: Slots, order: ReadonlyArray<string>): Slots {
  const rank = (type: string) => (order.includes(type) ? order.indexOf(type) : order.length)
  const moved = Object.keys(slots)
    .filter((type) => type !== DYNAMIC)
    .toSorted((a, b) => rank(a) - rank(b))
    .flatMap((type) => slots[type]!.filter((id) => DYNAMIC_LAYERS.has(id) && !slots[DYNAMIC]?.includes(id)))
  if (!Object.entries(slots).some(([type, ids]) => type !== DYNAMIC && ids.some((id) => DYNAMIC_LAYERS.has(id))))
    return slots
  return {
    ...Object.fromEntries(
      Object.entries(slots).map(([type, ids]) => [type, ids.filter((id) => !DYNAMIC_LAYERS.has(id))] as const),
    ),
    [DYNAMIC]: [...(slots[DYNAMIC] ?? []), ...moved],
  }
}

export function migrateGroup(group: Group): Group {
  if (group.types.includes(DYNAMIC) || group.types.includes(HELPER)) return group
  const at = group.types.indexOf("identity") + 1 || group.types.length
  return { ...group, types: [...group.types.slice(0, at), DYNAMIC, ...group.types.slice(at)] }
}

export function migrate(catalog: Catalog): Catalog {
  // Only groups whose profiles hold those texts need Dynamic; a group can be without it.
  const needs = new Set(
    catalog.profiles
      .filter((profile) => Object.values(profile.slots).some((ids) => ids.some((id) => DYNAMIC_LAYERS.has(id))))
      .map((profile) => profile.group),
  )
  const own = catalog.groups.map((group) => (needs.has(group.id) ? migrateGroup(group) : group))
  const order = (id: string) =>
    [...BUILTIN_GROUPS, ...own].find((item) => item.id === id)?.types ?? BUILTIN_TYPES.map((item) => item.id)
  return {
    ...catalog,
    groups: own,
    profiles: catalog.profiles.map((profile) => ({
      ...profile,
      slots: migrateSlots(profile.slots, order(profile.group)),
    })),
  }
}

export function migrateSetting(agent: string, setting: AgentSetting): AgentSetting {
  const profile = setting.profile === LEGACY_HELPER ? HELPER_DEFAULTS.get(agent) : setting.profile
  const slots = setting.override?.slots
  return {
    ...(profile ? { profile } : {}),
    ...(setting.override
      ? {
          override: {
            ...setting.override,
            ...(slots
              ? {
                  slots: migrateSlots(
                    slots,
                    BUILTIN_TYPES.map((item) => item.id),
                  ),
                }
              : {}),
          },
        }
      : {}),
  }
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

// A fingerprint of a text, to tell when OpenCode's text changed since a copy was made of it.
export function fingerprint(text: string) {
  return Bun.hash(text).toString(36)
}
