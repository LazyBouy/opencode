export * as OperatorProfile from "./profile"

import path from "path"
import { parse } from "jsonc-parser"
import { Schema } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { configEntryNameFromPath } from "@/config/entry-name"
import { OperatorPromptText } from "./prompt-text"

// Prompt profiles: an agent's system prompt is built from a profile (an ordered list of prompt
// groups), each group an ordered list of layers (pieces of prompt text). The order follows the
// project/agent spec: Platform → Purpose → Role → Identity → Capabilities → custom groups → Output
// format, with Purpose, Role and Identity required and Purpose (org value and project goal) added for
// every agent, whatever its profile says. Tool groups set tool descriptions.
//
// This module is pure (no services), so the plugin that applies profiles to requests and the preview
// on the agent page call the same `assemble`. Files are read by profile-store.ts.

// The built-in project that holds OpenCode's own agents; its goal is the base prompt for the model.
export const OPENCODE = "opencode"
// Agents that get the Helper profile when no default is set: they make short side calls.
export const HELPER_AGENTS = ["title", "summary", "compaction"]

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
]).annotate({ identifier: "OperatorPromptLayerSection" })
export type Section = typeof Section.Type

export const GroupType = Schema.Literals([
  "platform",
  "purpose",
  "role",
  "identity",
  "capabilities",
  "custom",
  "output",
  "tool",
]).annotate({ identifier: "OperatorPromptGroupType" })
export type GroupType = typeof GroupType.Type

// The order groups take in a profile, and how many of each a profile may have.
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
const REQUIRED: readonly GroupType[] = ["purpose", "role", "identity"]
// Groups up to Identity form the first system message; the rest the second.
const FIRST_MESSAGE: readonly GroupType[] = ["platform", "purpose", "role", "identity"]

export const Projects = Schema.Union([Schema.Literal("*"), Schema.Array(Schema.String)]).annotate({
  identifier: "OperatorPromptProjects",
  description: '"*" for all projects, or project keys ("opencode", or a project folder)',
})
export type Projects = typeof Projects.Type

export const Origin = Schema.Literals(["builtin", "slot", "collection", "generated", "profile", "file"]).annotate({
  identifier: "OperatorPromptLayerOrigin",
  description:
    "builtin: OpenCode's own text; slot and collection: resolved per request; generated: written per request; profile: a layer in profile/layers; file: an existing prompts/ or identity/ file",
})
export type Origin = typeof Origin.Type

export const Layer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  section: Section,
  purpose: Schema.optional(Schema.Literals(["org", "goal"])).annotate({
    description: "Purpose layers: an org value, or a project's goal",
  }),
  overrides: Schema.optional(Schema.String).annotate({ description: "The built-in text this layer replaces" }),
  projects: Projects,
  agents: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Only these agents; all when unset" }),
  priority: Schema.Finite.annotate({ description: "Lower comes first among layers added together (default 50)" }),
  maxLength: Schema.optional(Schema.Finite).annotate({ description: "Characters kept; the rest is cut" }),
  enabled: Schema.Boolean,
  text: Schema.String,
  origin: Origin,
  path: Schema.optional(Schema.String).annotate({ description: "The file that holds the layer" }),
}).annotate({ identifier: "OperatorPromptLayer" })
export type Layer = typeof Layer.Type

export const PromptGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: GroupType,
  projects: Projects,
  layers: Schema.Array(Schema.String),
  builtin: Schema.Boolean,
}).annotate({ identifier: "OperatorPromptGroup" })
export type PromptGroup = typeof PromptGroup.Type

export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projects: Projects,
  groups: Schema.Array(Schema.String),
  builtin: Schema.Boolean,
}).annotate({ identifier: "OperatorPromptProfile" })
export type Profile = typeof Profile.Type

export const Defaults = Schema.Struct({
  global: Schema.optional(Schema.String),
  projects: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "OperatorPromptDefaults" })
export type Defaults = typeof Defaults.Type

export const Mode = Schema.Literals(["profile", "layers", "custom"]).annotate({ identifier: "OperatorPromptMode" })
export type Mode = typeof Mode.Type

export const GENERATED = ["environment", "references", "instructions", "mcp", "skills"] as const
export type Generated = (typeof GENERATED)[number]

// An agent's `promptProfile` setting.
export type Settings = {
  readonly mode?: Mode
  readonly profile?: string
  readonly layers?: ReadonlyArray<{ readonly layer: string; readonly group: string }>
  readonly generated?: ReadonlyArray<Generated>
}

export type Catalog = {
  readonly layers: ReadonlyArray<Layer>
  readonly groups: ReadonlyArray<PromptGroup>
  readonly profiles: ReadonlyArray<Profile>
  readonly defaults: Defaults
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

// Layers that are not files: OpenCode's texts, slots resolved per request, collections of layers,
// and generated sections.
export const BUILTIN_LAYERS: readonly Layer[] = [
  ...OperatorPromptText.BUILTINS.map((item) => builtin(item.id, item.id, sectionOf(item.id), item.text)),
  builtin("slot.base", "Base prompt (by model)", "base", "", "slot"),
  builtin("slot.agent", "Agent prompt", "identity", "", "slot"),
  builtin("purpose.org", "Org value", "purpose", "", "collection"),
  builtin("purpose.goal", "Project goal", "purpose", "", "collection"),
  builtin("identity.shared", "Identity layers", "identity", "", "collection"),
  builtin("generated.environment", "Environment", "generated", "", "generated"),
  builtin("generated.references", "References", "generated", "", "generated"),
  builtin("generated.instructions", "Instructions", "generated", "", "generated"),
  builtin("generated.mcp", "MCP instructions", "generated", "", "generated"),
  builtin("generated.skills", "Skills", "generated", "", "generated"),
]

export const BUILTIN_GROUPS: readonly PromptGroup[] = [
  group("builtin.platform", "Platform", "platform", []),
  group("builtin.purpose", "Purpose", "purpose", ["purpose.org", "purpose.goal"]),
  group("builtin.role", "Role", "role", []),
  group("builtin.identity", "Identity", "identity", ["identity.shared", "slot.agent"]),
  group("builtin.capabilities", "Capabilities", "capabilities", ["generated.mcp", "generated.skills"]),
  group("builtin.environment", "Environment", "custom", ["generated.environment", "generated.references"]),
  group("builtin.instructions", "Project instructions", "custom", ["generated.instructions"]),
  group("builtin.output", "Output format", "output", ["notice.structured-output"]),
  group("builtin.helper-identity", "Identity (agent prompt)", "identity", ["slot.agent"]),
]

// Groups Full custom mode builds its prompt from, after Purpose and the agent's prompt.
const CUSTOM_GROUPS: readonly PromptGroup[] = [
  group("custom.capabilities", "Capabilities", "capabilities", ["generated.mcp", "generated.skills"]),
  group("custom.environment", "Environment", "custom", ["generated.environment", "generated.references"]),
  group("custom.instructions", "Project instructions", "custom", ["generated.instructions"]),
]

export const BUILTIN_PROFILES: readonly Profile[] = [
  {
    id: "default",
    name: "Default",
    projects: "*",
    groups: [
      "builtin.platform",
      "builtin.purpose",
      "builtin.role",
      "builtin.identity",
      "builtin.capabilities",
      "builtin.environment",
      "builtin.instructions",
      "builtin.output",
    ],
    builtin: true,
  },
  {
    id: "helper",
    name: "Helper",
    projects: "*",
    groups: ["builtin.purpose", "builtin.role", "builtin.helper-identity"],
    builtin: true,
  },
]

// Purpose's mandatory layers, always first in a Purpose group.
export const MANDATORY = ["purpose.org", "purpose.goal"]

// The key a project is stored under: its worktree, or the folder itself outside git.
export function projectKey(ctx: { directory: string; worktree: string }) {
  return ctx.worktree === "/" ? ctx.directory : ctx.worktree
}

export function inScope(projects: Projects, project: string) {
  return projects === "*" || projects.includes(project)
}

export function applies(layer: Layer, ctx: { project: string; agent?: string }) {
  return (
    layer.enabled &&
    inScope(layer.projects, ctx.project) &&
    (!layer.agents?.length || (ctx.agent !== undefined && layer.agents.includes(ctx.agent)))
  )
}

// The layer that replaces a built-in text here: one scoped to the project beats one for all
// projects; among equals the lower priority wins.
export function override(layers: ReadonlyArray<Layer>, id: string, ctx: { project: string; agent?: string }) {
  const found = layers
    .filter((layer) => layer.overrides === id && applies(layer, ctx))
    .toSorted((a, b) => specificity(a) - specificity(b) || a.priority - b.priority)
  return found[0]
}

// The override of a built-in text for a call that does not say which agent it serves (tool
// descriptions, the step-limit notice, the agent generator): the folder's project's override, then
// OpenCode's (its built-in agents work in every folder), then one for all projects.
export function folderOverride(layers: ReadonlyArray<Layer>, id: string, project: string) {
  return override(layers, id, { project }) ?? override(layers, id, { project: OPENCODE })
}

// A built-in text with the override that applies here.
export function builtinText(layers: ReadonlyArray<Layer>, id: string, ctx: { project: string; agent?: string }) {
  const found = override(layers, id, ctx)
  return {
    text: found?.text ?? OperatorPromptText.BUILTINS.find((item) => item.id === id)?.text ?? "",
    layer: found?.id ?? id,
  }
}

// The base prompt for a model. Most specific first: the family's override for the project, then for
// all projects, then the all-models (`base`) override for the project, then for all, then OpenCode's
// text for the family.
export function baseText(
  layers: ReadonlyArray<Layer>,
  model: OperatorPromptText.ModelRef,
  ctx: { project: string; agent?: string },
) {
  const entry = OperatorPromptText.baseFor(model)
  const found = override(layers, entry.id, ctx) ?? override(layers, "base", ctx)
  const text = found?.text ?? OperatorPromptText.builtinBase(model)
  return {
    text: entry.id === "base.meta" ? OperatorPromptText.renderMeta(text, model) : text,
    layer: found?.id ?? entry.id,
    base: entry.id,
  }
}

// Which project an agent belongs to: OpenCode for built-in agents and agents defined globally; the
// project for agents defined in its `.opencode/agent/` folder or its config. When projects get their
// own entity, this may follow the session's project instead.
export async function agentProject(
  agent: { readonly name: string; readonly native?: boolean },
  ctx: { directory: string; worktree: string },
) {
  if (agent.native) return OPENCODE
  return (await definedInProject(agent.name, ctx)) ? projectKey(ctx) : OPENCODE
}

// The profile an agent uses: its own `promptProfile.profile`, then its project's default, then the
// global default, then the built-in profile (Helper for title, summary and compaction; else Default).
export function profileFor(catalog: Catalog, agent: string, settings: Settings | undefined, project: string) {
  const usable = (id: string | undefined) => {
    if (!id) return undefined
    const found = [...BUILTIN_PROFILES, ...catalog.profiles].find((item) => item.id === id)
    return found && inScope(found.projects, project) ? found : undefined
  }
  return (
    usable(settings?.profile) ??
    usable(catalog.defaults.projects[project]) ??
    usable(catalog.defaults.global) ??
    BUILTIN_PROFILES.find((item) => item.id === (HELPER_AGENTS.includes(agent) ? "helper" : "default"))!
  )
}

export const AssembledSection = Schema.Struct({
  group: Schema.String,
  groupName: Schema.String,
  groupType: GroupType,
  entry: Schema.String.annotate({ description: "The layer as the group lists it (a slot or collection, or a layer)" }),
  layer: Schema.String.annotate({ description: "The layer the text comes from" }),
  layerName: Schema.String,
  section: Section,
  overrides: Schema.optional(Schema.String).annotate({ description: "The built-in text the layer replaces" }),
  source: Schema.String.annotate({ description: "A file path, or what wrote the text" }),
  text: Schema.String,
  mandatory: Schema.Boolean,
  message: Schema.Finite.annotate({ description: "1 or 2: the system message the text is in" }),
}).annotate({ identifier: "OperatorPromptAssembledSection" })
export type AssembledSection = typeof AssembledSection.Type

export type AssembleInput = {
  readonly catalog: Catalog
  readonly project: string
  readonly agent: { readonly name: string; readonly prompt?: string; readonly settings?: Settings }
  readonly model: OperatorPromptText.ModelRef
  readonly parts: Parts
  // The legacy `prompts` config switches; a switched-off generated section is left out.
  readonly toggles: { readonly environment: boolean; readonly skills: boolean; readonly mcp: boolean }
}

// Builds the system messages for one request: at most two, so both get prompt-cache breakpoints.
// The first holds Platform through Identity, which has no generated text by default and so stays
// the same across folders and days; the second holds the rest, then the message's own system text.
export function assemble(input: AssembleInput) {
  const mode = input.agent.settings?.mode ?? "profile"
  const profile =
    mode === "custom"
      ? customProfile(input.agent.settings?.generated ?? GENERATED)
      : profileFor(input.catalog, input.agent.name, input.agent.settings, input.project)
  const groups = profileGroups(input.catalog, profile, input.project)
  const extra = mode === "layers" ? (input.agent.settings?.layers ?? []) : []
  const seen = new Set<string>()
  const sections = groups.flatMap((item) => {
    const listed = [...item.layers, ...extra.filter((add) => add.group === item.id).map((add) => add.layer)]
    const entries =
      item.type === "purpose" ? [...MANDATORY, ...listed.filter((entry) => !MANDATORY.includes(entry))] : listed
    return entries.flatMap((entry) =>
      resolve(input, entry)
        .filter((found) => {
          if (seen.has(found.key)) return false
          seen.add(found.key)
          return true
        })
        .map((found) => ({
          group: item.id,
          groupName: item.name,
          groupType: item.type,
          entry,
          layer: found.layer.id,
          layerName: found.layer.name,
          section: found.layer.section,
          ...(found.layer.overrides ? { overrides: found.layer.overrides } : {}),
          source: found.source,
          text: cut(found.text, found.layer.maxLength),
          mandatory: MANDATORY.includes(entry),
          message: FIRST_MESSAGE.includes(item.type) ? 1 : 2,
        }))
        .filter((section) => section.text.trim() !== ""),
    )
  })
  const join = (message: number) =>
    sections
      .filter((section) => section.message === message)
      .map((section) => section.text)
      .join("\n")
  const second = [join(2), ...(input.parts.extra ?? []), input.parts.user ?? ""].filter((text) => text).join("\n")
  return {
    profile: { id: profile.id, name: profile.name },
    mode,
    sections,
    system: [join(1), second].filter((text) => text),
  }
}

// What a profile's Tool group and the overrides in scope make of a tool's description.
export function toolDescription(
  catalog: Catalog,
  tool: string,
  description: string,
  ctx: { project: string; agent?: string; profile?: Profile },
) {
  const id = `tool.${tool}`
  const grouped = ctx.profile
    ? profileGroups(catalog, ctx.profile, ctx.project)
        .filter((item) => item.type === "tool")
        .flatMap((item) => item.layers)
        .map((entry) => catalog.layers.find((layer) => layer.id === entry))
        .find((layer) => layer?.overrides === id && applies(layer, ctx))
    : undefined
  return (grouped ?? override(catalog.layers, id, ctx))?.text ?? description
}

// Overrides of message texts (reminders, notices, the agent generator) that apply here, in the shape
// OperatorPromptText.rewriteReminder and text() take.
export function messageOverrides(catalog: Catalog, ctx: { project: string; agent?: string }) {
  return new Map(
    OperatorPromptText.BUILTINS.filter((item) => sectionOf(item.id) === "message" || sectionOf(item.id) === "output")
      .map((item) => [item.id, override(catalog.layers, item.id, ctx)] as const)
      .filter((pair): pair is readonly [string, Layer] => pair[1] !== undefined)
      .map((pair) => [pair[0], { scope: "global" as const, text: pair[1].text }] as const),
  )
}

// Save checks. Each returns the reason a save is refused, or undefined.

// Sections a stored layer can have: written layers, and overrides of built-in texts.
const WRITTEN: readonly Section[] = ["purpose", "role", "identity", "custom"]

export function checkLayer(catalog: Catalog, layer: Layer) {
  if (!layer.name.trim()) return "A layer needs a name"
  if (layer.maxLength !== undefined && layer.maxLength <= 0) return "The length limit must be above 0"
  if (layer.projects !== "*" && layer.projects.length === 0) return "Choose all projects or at least one project"
  if (layer.overrides) {
    if (!isBuiltinText(layer.overrides)) return `"${layer.overrides}" is not one of OpenCode's texts`
    if (sectionOf(layer.overrides) !== layer.section)
      return `An override of ${layer.overrides} belongs in the ${sectionOf(layer.overrides)} section`
    const clash =
      layer.projects === "*"
        ? undefined
        : catalog.layers.find(
            (other) =>
              other.id !== layer.id &&
              other.overrides === layer.overrides &&
              other.projects !== "*" &&
              other.projects.some((project) => (layer.projects as ReadonlyArray<string>).includes(project)),
          )
    if (clash) return `"${clash.name}" already replaces ${layer.overrides} in one of these projects`
    return undefined
  }
  if (!WRITTEN.includes(layer.section))
    return `Layers in the ${layer.section} section are OpenCode's; override one instead`
  if (layer.section === "purpose" && !layer.purpose) return "A Purpose layer is an org value or a project goal"
  if (layer.section !== "purpose" && layer.purpose) return "Only Purpose layers are org values or project goals"
  if (layer.purpose !== "goal") return undefined
  if (layer.projects === "*" || layer.projects.length !== 1) return "A project goal is for exactly one project"
  if (layer.projects[0] === OPENCODE)
    return "The OpenCode project's goal is the base prompt for the model; change it in the Base Model Group"
  const project = layer.projects[0]
  const other = catalog.layers.find(
    (item) =>
      item.id !== layer.id && item.purpose === "goal" && item.projects !== "*" && item.projects.includes(project),
  )
  if (other) return `"${other.name}" is already this project's goal`
  return undefined
}

export function checkGroup(catalog: Catalog, group: PromptGroup) {
  if (!group.name.trim()) return "A group needs a name"
  if (new Set(group.layers).size !== group.layers.length) return "A layer can be in a group only once"
  const missing = group.layers.find((id) => !findLayer(catalog, id))
  if (missing) return `No layer "${missing}"`
  const refused = group.layers.find((id) => !allowedIn(group.type, findLayer(catalog, id)!))
  if (refused) return `"${findLayer(catalog, refused)!.name}" cannot go in a ${group.type} group`
  return undefined
}

export function checkProfile(catalog: Catalog, profile: Profile) {
  if (!profile.name.trim()) return "A profile needs a name"
  const all = [...BUILTIN_GROUPS, ...catalog.groups]
  const groups = profile.groups.map((id) => all.find((item) => item.id === id))
  const missing = profile.groups.find((_, index) => !groups[index])
  if (missing) return `No group "${missing}"`
  const types = groups.map((item) => item!.type)
  const absent = REQUIRED.find((type) => !types.includes(type))
  if (absent) return `A profile needs a ${absent} group`
  const twice = GROUP_ORDER.find((type) => type !== "custom" && types.filter((item) => item === type).length > 1)
  if (twice) return `A profile can have only one ${twice} group`
  if (types.some((type, index) => index > 0 && GROUP_ORDER.indexOf(type) < GROUP_ORDER.indexOf(types[index - 1]!)))
    return `Groups go in this order: ${GROUP_ORDER.join(", ")}`
  const layers = groups.flatMap((item) => item!.layers)
  const repeated = layers.find((id, index) => layers.indexOf(id) !== index)
  if (repeated) return `"${findLayer(catalog, repeated)?.name ?? repeated}" is in more than one group of this profile`
  return undefined
}

export function checkDefaults(catalog: Catalog, defaults: Defaults) {
  const all = [...BUILTIN_PROFILES, ...catalog.profiles]
  const unknown = [defaults.global, ...Object.values(defaults.projects)].find(
    (id) => id !== undefined && !all.some((item) => item.id === id),
  )
  if (unknown) return `No profile "${unknown}"`
  const outside = Object.entries(defaults.projects).find(
    (pair) => !inScope(all.find((item) => item.id === pair[1])!.projects, pair[0]),
  )
  if (outside) return `"${outside[1]}" does not apply to ${outside[0]}`
  return undefined
}

export function findLayer(catalog: Catalog, id: string) {
  return (
    BUILTIN_LAYERS.find((layer) => layer.id === id) ??
    catalog.layers.find((layer) => layer.id === id) ??
    (id.startsWith("tool.") ? builtin(id, id, "tool", "") : undefined)
  )
}

// A built-in text id: one of OpenCode's prompt texts, or a tool's description.
export function isBuiltinText(id: string) {
  return id.startsWith("tool.") || OperatorPromptText.BUILTINS.some((item) => item.id === id)
}

// Which layers a group type takes.
function allowedIn(type: GroupType, layer: Layer) {
  if (layer.section === "message") return false
  if (type === "tool") return layer.section === "tool"
  if (layer.section === "tool") return false
  if (type === "capabilities" || type === "output") return layer.section === "generated" || layer.section === "output"
  if (type === "platform") return layer.section === "custom"
  if (MANDATORY.includes(layer.id)) return type === "purpose"
  return true
}

// The section a built-in text belongs to in Layer Definition.
export function sectionOf(id: string): Section {
  if (id === "base" || id.startsWith("base.")) return "base"
  if (id.startsWith("tool.")) return "tool"
  if (id === "notice.structured-output") return "output"
  return "message"
}

// The groups of a profile that apply in a project. Purpose is always there.
function profileGroups(catalog: Catalog, profile: Profile, project: string) {
  const all = [...BUILTIN_GROUPS, ...CUSTOM_GROUPS, ...catalog.groups]
  const groups = profile.groups
    .map((id) => all.find((item) => item.id === id))
    .filter((item): item is PromptGroup => item !== undefined && inScope(item.projects, project))
  if (groups.some((item) => item.type === "purpose")) return groups
  return [BUILTIN_GROUPS.find((item) => item.id === "builtin.purpose")!, ...groups]
}

// Full custom mode: Purpose, the agent's prompt as Identity, then the chosen generated sections in
// the Default profile's order.
function customProfile(generated: ReadonlyArray<Generated>): Profile {
  return {
    id: "custom",
    name: "Full custom",
    projects: "*",
    groups: [
      "builtin.purpose",
      "builtin.helper-identity",
      ...(generated.includes("mcp") || generated.includes("skills") ? ["custom.capabilities"] : []),
      ...(generated.includes("environment") || generated.includes("references") ? ["custom.environment"] : []),
      ...(generated.includes("instructions") ? ["custom.instructions"] : []),
    ],
    builtin: true,
  }
}

type Found = { key: string; layer: Layer; text: string; source: string }

// The text a group entry stands for. Slots and collections can stand for several layers.
function resolve(input: AssembleInput, entry: string): Found[] {
  const ctx = { project: input.project, agent: input.agent.name }
  const layers = input.catalog.layers
  const known = (id: string) => [...BUILTIN_LAYERS, ...layers].find((layer) => layer.id === id)
  const one = (key: string, layer: Layer | undefined, text: string | undefined, source: string): Found[] =>
    layer && text ? [{ key, layer, text, source }] : []
  const base = () => {
    const found = baseText(layers, input.model, ctx)
    return one("slot.base", known(found.layer), found.text, found.layer === found.base ? "OpenCode" : found.layer)
  }
  const generated = (name: Generated, text: string | undefined) =>
    one(`generated.${name}`, known(`generated.${name}`), text, "generated")

  if (entry === "purpose.org")
    return ordered(layers.filter((layer) => layer.purpose === "org" && applies(layer, ctx))).map((layer) => ({
      key: layer.id,
      layer,
      text: layer.text,
      source: layer.path ?? layer.id,
    }))
  if (entry === "purpose.goal") {
    const goal = layers.find(
      (layer) =>
        layer.purpose === "goal" &&
        layer.projects !== "*" &&
        layer.projects.includes(input.project) &&
        applies(layer, ctx),
    )
    return goal ? one(goal.id, goal, goal.text, goal.path ?? goal.id) : base()
  }
  if (entry === "identity.shared")
    return ordered(layers.filter((layer) => layer.section === "identity" && applies(layer, ctx))).map((layer) => ({
      key: layer.id,
      layer,
      text: layer.text,
      source: layer.path ?? layer.id,
    }))
  if (entry === "slot.base") return base()
  if (entry === "slot.agent") return one("slot.agent", known("slot.agent"), input.agent.prompt, input.agent.name)
  if (entry === "generated.environment")
    return input.toggles.environment ? generated("environment", input.parts.environment[0]) : []
  if (entry === "generated.references")
    return input.toggles.environment ? generated("references", input.parts.environment[1]) : []
  if (entry === "generated.mcp") return input.toggles.mcp ? generated("mcp", input.parts.mcp) : []
  if (entry === "generated.skills") return input.toggles.skills ? generated("skills", input.parts.skills) : []
  if (entry === "generated.instructions")
    return input.parts.instructions.flatMap((text, index) =>
      one(
        `generated.instructions.${index}`,
        known("generated.instructions"),
        text,
        text.match(/^Instructions from: ([^\n]*)/)?.[1] ?? "generated",
      ),
    )
  if (entry === "notice.structured-output") {
    if (!input.parts.output) return []
    const found = builtinText(layers, entry, ctx)
    return one(entry, known(found.layer), found.text, found.layer === entry ? "OpenCode" : found.layer)
  }
  if (sectionOf(entry) === "base" && known(entry)?.origin === "builtin") {
    const found = builtinText(layers, entry, ctx)
    const text = entry === "base.meta" ? OperatorPromptText.renderMeta(found.text, input.model) : found.text
    return one(entry, known(found.layer), text, found.layer === entry ? "OpenCode" : found.layer)
  }
  const layer = layers.find((item) => item.id === entry)
  if (!layer || layer.section === "tool" || layer.section === "message" || !applies(layer, ctx)) return []
  return one(layer.id, layer, layer.text, layer.path ?? layer.id)
}

// Layers added together: those for all projects first, then by priority, then by name.
function ordered(layers: ReadonlyArray<Layer>) {
  return layers.toSorted(
    (a, b) => specificity(b) - specificity(a) || a.priority - b.priority || a.name.localeCompare(b.name),
  )
}

// 0 for a layer scoped to projects, 1 for one scoped to all: lower is more specific.
function specificity(layer: Layer) {
  return layer.projects === "*" ? 1 : 0
}

function cut(text: string, max: number | undefined) {
  return max && text.length > max ? text.slice(0, max) : text
}

function builtin(id: string, name: string, section: Section, text: string, origin: Origin = "builtin"): Layer {
  return { id, name, section, projects: "*", priority: 50, enabled: true, text, origin }
}

function group(id: string, name: string, type: GroupType, layers: string[]): PromptGroup {
  return { id, name, type, projects: "*", layers, builtin: true }
}

// Whether the project's own config defines the agent: a markdown file in one of its `.opencode`
// folders (between the session folder and the project root, as config loading finds them), or an
// `agent`/`mode` entry in one of its config files.
async function definedInProject(name: string, ctx: { directory: string; worktree: string }) {
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return false
  const root = projectKey(ctx)
  const folders = upward(ctx.directory, root)
  const dirs = folders
    .map((dir) => path.join(dir, ".opencode"))
    .filter((dir) => dir !== Global.Path.config && dir !== path.join(Global.Path.home, ".opencode"))
  const files = await Promise.all(
    dirs.map(async (dir) =>
      [
        ...(
          await Glob.scan("{agent,agents}/**/*.md", { cwd: dir, absolute: true, dot: true, symlink: true }).catch(
            () => [] as string[],
          )
        ).map((file) => configEntryNameFromPath(path.relative(dir, file), ["agent/", "agents/"])),
        ...(
          await Glob.scan("{mode,modes}/*.md", { cwd: dir, absolute: true, dot: true, symlink: true }).catch(
            () => [] as string[],
          )
        ).map((file) => configEntryNameFromPath(path.relative(dir, file), ["mode/", "modes/"])),
      ].includes(name),
    ),
  )
  if (files.some(Boolean)) return true
  const configs = [
    ...folders.flatMap((dir) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]),
    ...dirs.flatMap((dir) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]),
  ]
  const defined = await Promise.all(
    configs.map(async (file) => {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      if (!text) return false
      const data = parse(text) as { agent?: Record<string, unknown>; mode?: Record<string, unknown> } | undefined
      return !!data?.agent?.[name] || !!data?.mode?.[name]
    }),
  )
  return defined.some(Boolean)
}

// The folders from `start` up to `stop`, inclusive.
function upward(start: string, stop: string): string[] {
  const parent = path.dirname(start)
  if (start === stop || parent === start || !start.startsWith(stop)) return [start]
  return [start, ...upward(parent, stop)]
}
