export * as OperatorProfileStore from "./profile-store"

import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Glob } from "@opencode-ai/core/util/glob"
import { OperatorFolders } from "./folders"
import { OperatorLayout } from "./layout"
import { OperatorOnboarding } from "./onboarding"
import { OperatorProfile } from "./profile"
import { OperatorResolver } from "./resolver"
import { OperatorResolverBuiltins } from "./resolver-builtins"
import { OperatorTrashFiles } from "./trash-files"
import { OperatorHelperFiles } from "./helper-files"
import { OperatorProjectIds } from "./project-ids"

// Prompt profile data is server-wide, in the global config folder; nothing goes into a project:
//
//   namespaces/<ns>/namespace.json      { id, name, purpose, defaultProfile?, folder?, defaultProject?, inheritGlobal?, createdAt, updatedAt }
//   namespaces/<ns>/types/<id>.json     { id, name, description }
//   namespaces/<ns>/layers/<id>.md      frontmatter { id, name, type, section, replaces? }; body: the text
//   namespaces/<ns>/groups/<id>.json    { id, name, types }
//   namespaces/<ns>/profiles/<id>.json  { id, name, group, slots }
//   namespaces/projects.json            { <projectKey>: { namespace, purpose?, defaultProfile? } }
//   namespaces/agents.json              { <projectKey>: { <agentName>: { profile?, override? } } }
//                                       override: { group?, slots?, layers?: { <localId>: { type, text, basedOn? } } }
//
// A project missing from projects.json is in OpenCode, with no Project Purpose and no default.

export const Kind = Schema.Literals(["type", "layer", "group", "profile"]).annotate({
  identifier: "OperatorPromptItemKind",
})
export type Kind = typeof Kind.Type

export const Copied = Schema.Struct({ kind: Kind, id: Schema.String, name: Schema.String }).annotate({
  identifier: "OperatorPromptCopied",
})
export type Copied = typeof Copied.Type

export const ProjectInfo = Schema.Struct({
  key: Schema.String.annotate({ description: "The project's folder (its worktree, or the folder outside git)" }),
  id: Schema.String.annotate({
    description: "Its short unique id on this server (5 characters), kept through moves and renames",
  }),
  name: Schema.String,
  namespace: Schema.String,
  purpose: Schema.optional(Schema.String),
  defaultProfile: Schema.optional(Schema.String),
  registered: Schema.optional(Schema.Boolean).annotate({
    description: "A git project, or a folder outside git registered as a project",
  }),
  flag: Schema.optional(Schema.Literals(["outside-opencode", "not-in-place"])).annotate({
    description:
      "outside-opencode: an OpenCode project outside OpenCode's folder; not-in-place: assigned to a namespace whose folder it isn't in yet",
  }),
}).annotate({ identifier: "OperatorPromptProject" })
export type ProjectInfo = typeof ProjectInfo.Type

// The console recording a new project (setProject, copyProject; not the one-time adoption): helper triggers listen
// (helper-triggers.ts).
export type CreatedProject = Pick<ProjectInfo, "key" | "id" | "name" | "namespace">
export const projectCreated = new Set<(project: CreatedProject) => void>()
function announceCreated(project: CreatedProject) {
  for (const listener of projectCreated) {
    try {
      listener(project)
    } catch {
      // A listener's failure is its own.
    }
  }
}

export const AgentInfo = Schema.Struct({
  project: Schema.String,
  name: Schema.String,
  profile: Schema.optional(Schema.String),
  override: Schema.optional(OperatorProfile.Override),
}).annotate({ identifier: "OperatorPromptAgentSetting" })

export const AgentPrompt = Schema.Struct({
  setting: OperatorProfile.AgentSetting,
  namespace: Schema.Struct({ id: Schema.String, name: Schema.String }),
  profile: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    source: Schema.Literals(["agent", "helper", "project", "namespace"]),
  }),
  default: Schema.Struct({ id: Schema.String, name: Schema.String }).annotate({
    description: "The profile the agent uses without a setting of its own",
  }),
}).annotate({ identifier: "OperatorAgentPromptView" })
export type AgentPrompt = typeof AgentPrompt.Type

export const NamespaceSummary = Schema.Struct({
  namespace: OperatorProfile.Namespace.annotate({ description: "Its record; `folder` is the folder it uses now" }),
  target: Schema.String.annotate({ description: "Where its folder belongs: Global's folder, or <working dir>/<id>" }),
  inPlace: Schema.Boolean.annotate({ description: "Its folder is its target (else it moves there later)" }),
  global: Schema.Boolean.annotate({
    description: "Global (or, with a blank working directory, Global · OpenCode): its config is Global's own file",
  }),
  configFile: Schema.String.annotate({ description: "Its config file" }),
  projects: Schema.Array(Schema.String).annotate({ description: "Keys of the namespace's projects" }),
  defaultProject: Schema.optional(Schema.String).annotate({
    description:
      "The namespace's default project: the one chosen while it is still in the namespace, else its first project",
  }),
  firstProject: Schema.optional(Schema.String).annotate({
    description: "The namespace's first project (the earliest added), its default when none is chosen",
  }),
}).annotate({ identifier: "OperatorNamespaceSummary" })

export const CatalogInfo = Schema.Struct({
  namespace: OperatorProfile.Namespace,
  types: Schema.Array(OperatorProfile.GroupType),
  layers: Schema.Array(OperatorProfile.Layer),
  groups: Schema.Array(OperatorProfile.Group),
  profiles: Schema.Array(OperatorProfile.Profile),
  projects: Schema.Array(ProjectInfo).annotate({ description: "The namespace's projects" }),
  agents: Schema.Array(AgentInfo).annotate({ description: "Prompt settings of the agents of those projects" }),
  resolvers: Schema.Record(Schema.String, OperatorResolver.Resolver).annotate({
    description:
      "OpenCode's rules for its Dynamic layers, by layer id (read-only; a copy of a per-request layer follows them until it has its own)",
  }),
  editableRules: Schema.Array(Schema.String).annotate({
    description: "OpenCode's layers whose copies can have rules of their own",
  }),
  helperRules: OperatorResolver.Resolver.annotate({
    description: "The rules your Dynamic layers have by default: one helper source that writes from the layer's prompt",
  }),
}).annotate({ identifier: "OperatorPromptCatalog" })
export type CatalogInfo = typeof CatalogInfo.Type

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorProfileInvalid", {
  message: Schema.String,
}) {}
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorProfileNotFound", {
  message: Schema.String,
}) {}
type Failure = InvalidError | NotFoundError

export interface Interface {
  readonly namespaces: () => Effect.Effect<ReadonlyArray<typeof NamespaceSummary.Type>>
  /** A new namespace needs a folder inside the workspace roots; it is created if missing. */
  /**
   * A new namespace, at `<working directory>/<id>` (global_and_opencode_namespaces_spec.md §10.1). A folder
   * already there that isn't empty is used only with `adopt` (its `.opencode/` and `.memory/` as they are).
   */
  readonly createNamespace: (input: {
    name: string
    purpose?: string
    adopt?: boolean
    /** A folder of its own instead of the derived one (code and tests; the console never sends it). */
    folder?: string
    inheritGlobal?: boolean
  }) => Effect.Effect<OperatorProfile.Namespace, Failure>
  /** An empty `defaultProject` clears the choice, so the first project is the default. */
  readonly updateNamespace: (
    id: string,
    input: {
      name?: string
      purpose?: string
      defaultProfile?: string
      folder?: string
      defaultProject?: string
      inheritGlobal?: boolean
    },
  ) => Effect.Effect<OperatorProfile.Namespace, Failure>
  /** The namespace's default project (see NamespaceSummary), if it has any project. */
  readonly defaultProject: (ns: string) => Effect.Effect<string | undefined>
  readonly removeNamespace: (id: string) => Effect.Effect<void, Failure>
  readonly catalog: (ns: string) => Effect.Effect<CatalogInfo, Failure>
  readonly saveType: (
    ns: string,
    id: string | undefined,
    input: { name: string; description?: string },
  ) => Effect.Effect<OperatorProfile.GroupType, Failure>
  readonly saveLayer: (
    ns: string,
    id: string | undefined,
    input: {
      name: string
      type: string
      section?: OperatorProfile.Section
      text: string
      prompt?: string
      /** A Dynamic layer's own rules; null: back to the default (the helper's, OpenCode's). */
      resolver?: OperatorResolver.Resolver | null
      /** Your Dynamic layer's writer, a helper of the namespace with reading actions only; null: the default. */
      writer?: string | null
    },
  ) => Effect.Effect<OperatorProfile.Layer, Failure>
  /** Makes an editable copy of one of OpenCode's texts; `text` gives a tool description's text. */
  readonly copyBuiltin: (ns: string, id: string, text?: string) => Effect.Effect<OperatorProfile.Layer, Failure>
  /** A copy of one of OpenCode's texts takes OpenCode's current text. */
  readonly syncLayer: (ns: string, id: string) => Effect.Effect<OperatorProfile.Layer, Failure>
  readonly saveGroup: (
    ns: string,
    id: string | undefined,
    input: { name: string; types: ReadonlyArray<string> },
  ) => Effect.Effect<OperatorProfile.Group, Failure>
  readonly saveProfile: (
    ns: string,
    id: string | undefined,
    input: { name: string; group: string; slots: OperatorProfile.Slots },
  ) => Effect.Effect<OperatorProfile.Profile, Failure>
  readonly remove: (ns: string, kind: Kind, id: string) => Effect.Effect<void, Failure>
  /** Copies an item, and what it uses that the target lacks, to another namespace. */
  readonly copyTo: (ns: string, kind: Kind, id: string, target: string) => Effect.Effect<Copied[], Failure>
  readonly projects: () => Effect.Effect<ProjectInfo[]>
  /** Changes a project's links; a new namespace moves it, copying what it uses. */
  readonly setProject: (
    key: string,
    input: { namespace?: string; purpose?: string; defaultProfile?: string; dryRun?: boolean },
  ) => Effect.Effect<{ project: ProjectInfo; copied: Copied[] }, Failure>
  /** Gives a new project the prompt settings of another (and its agents' settings); the other is unchanged. */
  readonly copyProject: (
    source: string,
    target: string,
    input: { namespace?: string },
  ) => Effect.Effect<{ project: ProjectInfo; copied: Copied[] }, Failure>
  readonly agent: (project: string, name: string) => Effect.Effect<OperatorProfile.AgentSetting>
  /** An agent's setting, with the profile it uses and where that comes from. */
  readonly agentPrompt: (project: string, name: string) => Effect.Effect<AgentPrompt>
  readonly setAgent: (
    project: string,
    name: string,
    setting: OperatorProfile.AgentSetting,
  ) => Effect.Effect<OperatorProfile.AgentSetting, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorProfileStore") {}

export function root() {
  return path.join(Global.Path.config, "namespaces")
}

// Everything a request in a project needs: its namespace's items, its links, its agents' settings.
export async function forProject(key: string) {
  await ensure()
  const projects = await readProjects()
  const project = projects[key]
  // The namespace the project is in (layout.ts): by where its folder is.
  const member = OperatorLayout.membership(key, await OperatorLayout.snapshot(), project?.namespace)
  const catalog = (await readNamespace(member.namespace)) ??
    (await readNamespace(OperatorProfile.OPENCODE)) ??
      // The config folder cannot be written: OpenCode as it is.
      {
        namespace: { id: OperatorProfile.OPENCODE, name: "OpenCode", purpose: "", createdAt: 0, updatedAt: 0 },
        types: [],
        layers: [],
        groups: [],
        profiles: [],
      }
  return {
    catalog,
    // Its settings name items of the namespace they were made in: kept only there.
    project: project && catalog.namespace.id === (project.namespace ?? OperatorProfile.OPENCODE) ? project : undefined,
    agents: (await readAgents())[key] ?? {},
  }
}

export async function readNamespace(id: string): Promise<OperatorProfile.Catalog | undefined> {
  const dir = path.join(root(), id)
  if (!(await readNamespaceRecord(id))) return undefined
  // Read after its own copies of OpenCode's built-ins are made (and its settings pointed at them).
  await adopt(id)
  const namespace = await readNamespaceRecord(id)
  if (!namespace) return undefined
  const [types, layers, groups, profiles] = await Promise.all([
    readJsonDir(path.join(dir, "types"), (data) => ({
      id: String(data.id),
      name: String(data.name ?? data.id),
      description: String(data.description ?? ""),
      builtin: false,
    })),
    readLayers(path.join(dir, "layers")),
    readJsonDir(path.join(dir, "groups"), (data) => ({
      id: String(data.id),
      name: String(data.name ?? data.id),
      types: strings(data.types),
      builtin: false,
    })),
    readJsonDir(path.join(dir, "profiles"), (data) => ({
      id: String(data.id),
      name: String(data.name ?? data.id),
      group: String(data.group ?? OperatorProfile.BUILTIN_GROUPS[1]!.id),
      slots: slotsOf(data.slots),
      builtin: false,
    })),
  ])
  return OperatorProfile.migrate({ namespace, types, layers, groups, profiles })
}

export async function readProjects(): Promise<Record<string, OperatorProfile.ProjectSetting>> {
  const data = await Bun.file(path.join(root(), "projects.json"))
    .json()
    .catch(() => ({}))
  return Object.fromEntries(
    Object.entries(data as Record<string, Record<string, unknown>>)
      .filter((pair) => pair[1] && typeof pair[1].namespace === "string")
      .map((pair) => [
        pair[0],
        {
          namespace: String(pair[1].namespace),
          ...(OperatorProjectIds.valid(pair[1].id) ? { id: pair[1].id } : {}),
          ...(typeof pair[1].purpose === "string" ? { purpose: pair[1].purpose } : {}),
          ...(typeof pair[1].defaultProfile === "string" ? { defaultProfile: pair[1].defaultProfile } : {}),
        },
      ]),
  )
}

// The ids the console's projects use.
function takenIds(projects: Record<string, OperatorProfile.ProjectSetting>) {
  return new Set(Object.values(projects).flatMap((item) => (item.id ? [item.id] : [])))
}

export async function readAgents(): Promise<Record<string, Record<string, OperatorProfile.AgentSetting>>> {
  const data = await Bun.file(path.join(root(), "agents.json"))
    .json()
    .catch(() => ({}))
  return Object.fromEntries(
    Object.entries(data as Record<string, Record<string, Record<string, unknown>>>).map((project) => [
      project[0],
      Object.fromEntries(
        Object.entries(project[1] ?? {}).map((agent) => [
          agent[0],
          OperatorProfile.migrateSetting(agent[0], agentSetting(agent[1])),
        ]),
      ),
    ]),
  )
}

// OpenCode's built-ins belong to the OpenCode namespace; every other namespace gets its own copies of
// them, editable there: each built-in layer (but the org purpose, which comes from the namespace),
// group and profile, as "<id>" for "opencode:<id>". Its profiles, agents' settings, projects'
// defaults and its default profile are pointed at its copies. The built-ins a namespace took are
// listed in its builtins.json: one it deleted is not copied again, and new ones (a release) are.
const ADOPTED = "builtins.json"
const adopting = new Map<string, Promise<void>>()
async function adopt(ns: string): Promise<void> {
  if (ns === OperatorProfile.OPENCODE) return
  const running = adopting.get(ns)
  if (running) return running
  const work = (async () => {
    const file = path.join(root(), ns, ADOPTED)
    const taken: string[] = await Bun.file(file)
      .json()
      .catch(() => [])
    const layers = OperatorProfile.BUILTIN_LAYERS.filter(
      (item) => item.origin !== "automatic" && !taken.includes(item.id),
    )
    const groups = OperatorProfile.BUILTIN_GROUPS.filter((item) => !taken.includes(item.id))
    const profiles = OperatorProfile.BUILTIN_PROFILES.filter((item) => !taken.includes(item.id))
    if (!layers.length && !groups.length && !profiles.length) return
    const own = OperatorProfile.own
    const exists = (kind: Kind, id: string) => Bun.file(itemFile(ns, kind, id)).exists()
    for (const item of layers) {
      if (await exists("layer", own(item.id))) continue
      await writeItem(ns, "layer", {
        id: own(item.id),
        name: item.name,
        type: item.type,
        section: item.section,
        replaces: item.id,
        text: item.text,
        ...(item.text ? { basedOn: OperatorProfile.fingerprint(item.text) } : {}),
        origin: "user",
      })
    }
    for (const item of groups)
      if (!(await exists("group", own(item.id))))
        await writeItem(ns, "group", { id: own(item.id), name: item.name, types: [...item.types], builtin: false })
    // Instruction files apply only to OpenCode's and Global's projects (memory_spec.md §7): another
    // namespace's profiles leave the Instructions layer out (it would be empty).
    const instructions = OperatorLayout.isGlobal(ns, await OperatorLayout.snapshot())
      ? undefined
      : own(`${OperatorProfile.PREFIX}generated.instructions`)
    for (const item of profiles)
      if (!(await exists("profile", own(item.id)))) {
        const slots = ownSlots(item.slots)
        await writeItem(ns, "profile", {
          id: own(item.id),
          name: item.name,
          group: own(item.group),
          slots: Object.fromEntries(
            Object.entries(slots).map(([type, ids]) => [type, ids.filter((id) => id !== instructions)]),
          ),
          builtin: false,
        })
      }
    // The memory layers, when a namespace first takes them: its OpenCode and Spec profiles hold them, last in
    // Dynamic (OpenCode's own OpenCode profile stays upstream's; the user's choice of 2026-10-10).
    if (layers.some((item) => OperatorResolverBuiltins.MEMORY_LAYERS.includes(item.id))) await addMemoryLayers(ns)
    // What the namespace already had now points at its own copies.
    await pointAtOwn(ns)
    await writeJson(
      file,
      [...taken, ...layers, ...groups, ...profiles].map((item) => (typeof item === "string" ? item : item.id)),
    )
  })().finally(() => adopting.delete(ns))
  adopting.set(ns, work)
  return work
}

async function addMemoryLayers(ns: string) {
  const own = OperatorProfile.own
  const memory = OperatorResolverBuiltins.MEMORY_LAYERS.map(own)
  for (const id of [own(OperatorProfile.OPENCODE_PROFILE), own(`${OperatorProfile.PREFIX}profile.spec`)]) {
    const file = itemFile(ns, "profile", id)
    const found = (await Bun.file(file)
      .json()
      .catch(() => undefined)) as OperatorProfile.Profile | undefined
    if (!found?.slots) continue
    const dynamic = found.slots[OperatorProfile.DYNAMIC] ?? []
    if (memory.every((layer) => dynamic.includes(layer))) continue
    await writeItem(ns, "profile", {
      ...found,
      slots: {
        ...found.slots,
        [OperatorProfile.DYNAMIC]: [...dynamic.filter((layer) => !memory.includes(layer)), ...memory],
      },
      builtin: false,
    })
  }
}

// Slots with OpenCode's built-ins replaced by a namespace's own copies. Built-in tool descriptions do
// nothing in a slot on their own, so they are dropped.
function ownSlots(slots: OperatorProfile.Slots) {
  return Object.fromEntries(
    Object.entries(slots).map(([type, ids]) => [
      type,
      ids.filter((id) => !id.startsWith(`${OperatorProfile.PREFIX}tool.`)).map((id) => OperatorProfile.own(id)),
    ]),
  )
}

const ownOverride = (override: OperatorProfile.Override | undefined) =>
  override
    ? {
        ...(override.group ? { group: OperatorProfile.own(override.group) } : {}),
        ...(override.slots ? { slots: ownSlots(override.slots) } : {}),
        ...(override.layers ? { layers: remapLocal(override.layers, (id) => OperatorProfile.own(id)) } : {}),
      }
    : undefined

// An agent's own texts, with the layers they copy pointed elsewhere (a copy dropped where there is none).
function remapLocal(
  layers: Readonly<Record<string, OperatorProfile.LocalLayer>>,
  map: (id: string) => string | undefined,
): Record<string, OperatorProfile.LocalLayer> {
  return Object.fromEntries(
    Object.entries(layers).map(([id, item]) => {
      const basedOn = item.basedOn ? map(item.basedOn) : undefined
      return [id, { type: item.type, text: item.text, ...(basedOn ? { basedOn } : {}) }]
    }),
  )
}

// A namespace's profiles, default profile, and its projects' and agents' settings, pointed at its own
// copies of OpenCode's built-ins.
async function pointAtOwn(ns: string) {
  const dir = path.join(root(), ns, "profiles")
  for (const file of await Glob.scan("*.json", { cwd: dir, absolute: true }).catch(() => [] as string[])) {
    const data = (await Bun.file(file)
      .json()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!data) continue
    const group = typeof data.group === "string" ? OperatorProfile.own(data.group) : data.group
    await writeJson(file, { ...data, group, slots: ownSlots(slotsOf(data.slots)) })
  }
  const record = await readNamespaceRecord(ns)
  if (record?.defaultProfile && OperatorProfile.isBuiltin(record.defaultProfile))
    await writeNamespace({ ...record, defaultProfile: OperatorProfile.own(record.defaultProfile) })
  const projects = await readProjects()
  const members = Object.keys(projects).filter((key) => projects[key]!.namespace === ns)
  let changed = false
  for (const key of members) {
    const setting = projects[key]!
    if (setting.defaultProfile && OperatorProfile.isBuiltin(setting.defaultProfile)) {
      projects[key] = { ...setting, defaultProfile: OperatorProfile.own(setting.defaultProfile) }
      changed = true
    }
  }
  if (changed) await writeJson(path.join(root(), "projects.json"), projects)
  const agents = await readAgents()
  for (const key of members)
    for (const [name, setting] of Object.entries(agents[key] ?? {})) {
      const override = ownOverride(setting.override)
      agents[key]![name] = {
        ...(setting.profile ? { profile: OperatorProfile.own(setting.profile) } : {}),
        ...(override ? { override } : {}),
      }
    }
  if (members.some((key) => agents[key])) await writeJson(path.join(root(), "agents.json"), agents)
}

// A project in Trash loses its prompt settings and its agents' settings (kept with the Trash entry).
export async function forgetProject(key: string) {
  const projects = await readProjects()
  const agents = await readAgents()
  if (key in projects) {
    delete projects[key]
    await writeJson(path.join(root(), "projects.json"), projects)
  }
  if (key in agents) {
    delete agents[key]
    await writeJson(path.join(root(), "agents.json"), agents)
  }
}

// A project restored from Trash gets its settings back.
export async function restoreProject(key: string, settings: { project?: unknown; agents?: unknown }) {
  if (settings.project)
    await writeJson(path.join(root(), "projects.json"), { ...(await readProjects()), [key]: settings.project })
  if (settings.agents)
    await writeJson(path.join(root(), "agents.json"), { ...(await readAgents()), [key]: settings.agents })
}

// A namespace that stays where it is while the working directory changes (layout-move.ts): its record names
// its folder, so it is "Not in place" until it moves.
export async function pinFolder(id: string, folder: string) {
  const record = await readNamespaceRecord(id)
  if (!record || record.folder === folder) return
  await writeNamespace({ ...record, folder })
}

// A project's entry put back as it was (layout-move.ts, rolling a move back); undefined removes it.
export async function putProject(key: string, entry: OperatorProfile.ProjectSetting | undefined) {
  const projects = await readProjects()
  if (entry) projects[key] = entry
  else delete projects[key]
  await writeJson(path.join(root(), "projects.json"), projects)
}

// The OpenCode namespace exists from the first start, with its record only. At the first start after
// the layout came (global_and_opencode_namespaces_spec.md §9, §12.1) the working directory is set once:
// OPENCODE_OPERATOR_WORKING_DIR, else the parent of OpenCode's folder, else blank. When Global and
// OpenCode are separate, Global gets its own record (its items are copied lazily, as for any namespace)
// and OpenCode's MCP logins are copied to their own keys once (§12.4). OPENCODE_OPERATOR_DEFAULT_PROJECT
// sets OpenCode's default project once.
const settled = new Set<string>()
export async function ensure(env: NodeJS.ProcessEnv = process.env) {
  const file = path.join(root(), OperatorProfile.OPENCODE, "namespace.json")
  if (!(await Bun.file(file).exists())) {
    const now = Date.now()
    await writeJson(file, {
      id: OperatorProfile.OPENCODE,
      name: "OpenCode",
      purpose: "",
      createdAt: now,
      updatedAt: now,
    }).catch(() => undefined)
  }
  if (settled.has(file)) return
  settled.add(file)
  await firstStart(env)
  await settleLayout()
  const project = env.OPENCODE_OPERATOR_DEFAULT_PROJECT?.trim()
  // The record as settling left it (it may have written OpenCode's inheritance).
  const latest = await readNamespaceRecord(OperatorProfile.OPENCODE)
  if (latest && project && path.isAbsolute(project) && !latest.defaultProject)
    await writeNamespace({ ...latest, defaultProject: path.resolve(project) }).catch(() => undefined)
}

// The first start of an installation sets the working directory once: settings.json has no `workingDir` yet
// (another writer, such as the memory defaults, may have made the file first, so its presence doesn't say).
// Without one given, a new installation waits for onboarding (onboarding.ts).
export async function firstStart(env: NodeJS.ProcessEnv = process.env) {
  const settingsFile = path.join(root(), "settings.json")
  const raw = (await Bun.file(settingsFile)
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (raw && typeof raw === "object" && "workingDir" in raw) return
  const current = await readNamespaceRecord(OperatorProfile.OPENCODE)
  const derived = OperatorLayout.derivedWorkingDir(env, current?.folder)
  await writeJson(settingsFile, { ...raw, workingDir: derived ?? "" }).catch(() => undefined)
  if (!derived) await OperatorOnboarding.markPending().catch(() => undefined)
}

// With a working directory, Global is a namespace of its own: its record, OpenCode's MCP logins copied to
// their own keys once, and OpenCode's inheritance of Global's capabilities written into its record
// explicitly (§12.4: on, as it was; a namespace without the field inherits too). Run at the start and when
// the working directory is set.
export async function settleLayout() {
  const settings = await OperatorLayout.readSettings()
  if (settings.workingDir) {
    const opencode = path.join(root(), OperatorProfile.OPENCODE, "namespace.json")
    const record = (await Bun.file(opencode)
      .json()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (record && typeof record.inheritGlobal !== "boolean")
      await writeJson(opencode, { ...record, inheritGlobal: true }).catch(() => undefined)
    if (!(await readNamespaceRecord(OperatorLayout.GLOBAL))) {
      const now = Date.now()
      await writeJson(path.join(root(), OperatorLayout.GLOBAL, "namespace.json"), {
        id: OperatorLayout.GLOBAL,
        name: "Global",
        purpose: "",
        createdAt: now,
        updatedAt: now,
      }).catch(() => undefined)
    }
    if (!settings.mcpLoginsCopied) {
      await copyMcpLogins().catch(() => undefined)
      await OperatorLayout.writeSettings({ ...(await OperatorLayout.readSettings()), mcpLoginsCopied: true }).catch(
        () => undefined,
      )
    }
  }
}

// MCP logins kept under a bare server name are Global's; OpenCode, once separate, uses
// `opencode/<server>` (mcp-auth-scope.ts). They are copied, not moved: Global and the CLI keep theirs.
async function copyMcpLogins() {
  const file = path.join(Global.Path.data, "mcp-auth.json")
  const logins = (await Bun.file(file)
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (!logins) return
  const next = { ...logins }
  for (const [name, value] of Object.entries(logins))
    if (!name.includes("/") && !(`${OperatorProfile.OPENCODE}/${name}` in next))
      next[`${OperatorProfile.OPENCODE}/${name}`] = value
  if (Object.keys(next).length === Object.keys(logins).length) return
  await fs.writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 })
}

// The namespace's default project among its projects (in the order they were added): the chosen
// one while it is still there, else the first.
export function defaultProjectOf(namespace: OperatorProfile.Namespace, projects: ReadonlyArray<string>) {
  if (namespace.defaultProject && projects.includes(namespace.defaultProject)) return namespace.defaultProject
  return projects[0]
}

// A namespace's folder: absolute, inside the workspace roots, created if missing.
/**
 * Where a new namespace called `name` goes (§10.1): its id, `<working directory>/<id>`, and whether a
 * folder is there already (and why it can't be used, if it can't).
 */
export async function namespacePreview(name: string) {
  const settings = await OperatorLayout.readSettings()
  if (!settings.workingDir) return { error: "Set a working directory first: namespaces live in it." }
  const id = await freeId(root(), name, "", [OperatorLayout.GLOBAL, OperatorProfile.OPENCODE])
  const folder = path.join(settings.workingDir, id)
  const entries = await fs.readdir(folder).catch(() => undefined)
  const problem =
    entries !== undefined && (await OperatorLayout.insideGit(folder))
      ? `${folder} is in a git repository: a namespace folder can't be a project`
      : undefined
  return { id, folder, exists: entries !== undefined, empty: !entries?.length, ...(problem ? { problem } : {}) }
}

async function namespaceFolder(folder: string) {
  const given = folder.trim()
  if (!given) return { error: "A namespace needs a folder" }
  if (!path.isAbsolute(given)) return { error: `The namespace folder must be an absolute path: ${given}` }
  const found = await OperatorFolders.locate(given)
  if (!found.root) return { error: `${found.resolved} is outside the workspace (${found.roots.join(", ")})` }
  const made = await fs
    .mkdir(found.resolved, { recursive: true })
    .then(() => undefined)
    .catch((cause: NodeJS.ErrnoException) => `${found.resolved} cannot be created: ${cause.code ?? String(cause)}`)
  if (made) return { error: made }
  const stat = await fs.stat(found.resolved).catch(() => undefined)
  if (!stat?.isDirectory()) return { error: `${found.resolved} is not a folder` }
  return { folder: found.resolved }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* Effect.promise(() => ensure())

    const refuse = (message: string | undefined) => (message ? Effect.fail(new InvalidError({ message })) : Effect.void)

    const load = Effect.fnUntraced(function* (ns: string) {
      yield* Effect.promise(() => ensure())
      const found = yield* Effect.promise(() => readNamespace(ns))
      if (!found) return yield* new NotFoundError({ message: `No namespace "${ns}"` })
      return found
    })

    // Every project the server knows (git projects), and every project with project or agent settings.
    const known = Effect.fnUntraced(function* () {
      return (yield* inventory()).projects
    })

    // The projects, and the order they were added in: git projects by when OpenCode first saw them,
    // then folders outside git in the order they were registered.
    // The console's projects are its records in projects.json (specs/docs/issues/002): a folder OpenCode only knows
    // from its database (a repository a client opened, the server's own folder) is not a project. Each record has
    // its id; one without gets one here.
    const records = Effect.fnUntraced(function* () {
      return yield* Effect.promise(async () => {
        const all = await readProjects()
        const missing = Object.keys(all).filter((key) => !all[key]!.id)
        if (!missing.length) return all
        const taken = takenIds(all)
        for (const key of missing) {
          const id = OperatorProjectIds.make(taken)
          taken.add(id)
          all[key] = { ...all[key]!, id }
        }
        await writeJson(path.join(root(), "projects.json"), { ...(await readProjects()), ...all })
        return all
      })
    })

    // Once, at the first start with records: the projects the console listed until then (the git projects in its
    // database that aren't in Trash, and every project with settings) become records, so none is lost.
    const adopt = Effect.fnUntraced(function* () {
      const file = path.join(root(), "settings.json")
      const raw = (yield* Effect.promise(() =>
        Bun.file(file)
          .json()
          .catch(() => ({})),
      )) as Record<string, unknown>
      if (raw.projectRecords === true) return
      const rows = yield* db.select({ worktree: ProjectTable.worktree }).from(ProjectTable).all().pipe(Effect.orDie)
      const trashed = yield* Effect.promise(OperatorTrashFiles.trashedProjects)
      const agents = yield* Effect.promise(readAgents)
      const all = yield* Effect.promise(readProjects)
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const candidates = [...rows.map((row) => String(row.worktree)), ...Object.keys(agents)].filter(
        (key, index, list) => key !== "/" && list.indexOf(key) === index && !(key in all) && !trashed.has(key),
      )
      const taken = takenIds(all)
      for (const key of candidates) {
        if (
          !(yield* Effect.promise(() =>
            fs.stat(key).then(
              (stat) => stat.isDirectory(),
              () => false,
            ),
          ))
        )
          continue
        const id = OperatorProjectIds.make(taken)
        taken.add(id)
        all[key] = { namespace: OperatorLayout.membership(key, layout).namespace, id }
      }
      yield* Effect.promise(async () => {
        await writeJson(path.join(root(), "projects.json"), all)
        await writeJson(file, { ...raw, projectRecords: true })
      })
    })
    yield* adopt().pipe(Effect.ignore)

    const inventory = Effect.fnUntraced(function* () {
      const rows = yield* db
        .select({ worktree: ProjectTable.worktree, name: ProjectTable.name, created: ProjectTable.time_created })
        .from(ProjectTable)
        .all()
        .pipe(Effect.orDie)
      const settings = yield* records()
      const agents = yield* Effect.promise(readAgents)
      const names = new Map<string, string>(
        rows
          .filter((row) => row.worktree !== "/")
          .map((row) => [String(row.worktree), row.name || path.basename(row.worktree)]),
      )
      // Projects in Trash are not listed.
      const trashed = yield* Effect.promise(OperatorTrashFiles.trashedProjects)
      const keys = Object.keys(settings).filter((key) => !trashed.has(key))
      // Each project is in the namespace whose folder holds it (layout.ts).
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const projects: ProjectInfo[] = keys
        .map((key) => {
          const member = OperatorLayout.membership(key, layout, settings[key]?.namespace)
          return {
            key,
            name: names.get(key) ?? path.basename(key),
            ...settings[key],
            id: settings[key]!.id!,
            namespace: member.namespace,
            ...(member.flag ? { flag: member.flag } : {}),
            registered: true,
          }
        })
        .toSorted((a, b) => a.name.localeCompare(b.name))
      const created = new Map(rows.map((row) => [String(row.worktree), Number(row.created)]))
      const registeredAt = [...Object.keys(settings), ...Object.keys(agents)]
      const added = keys.toSorted(
        (a, b) =>
          (created.get(a) ?? Infinity) - (created.get(b) ?? Infinity) ||
          registeredAt.indexOf(a) - registeredAt.indexOf(b) ||
          a.localeCompare(b),
      )
      return { projects, added }
    })

    // What uses an item, in words, or undefined when nothing does.
    const usedBy = Effect.fnUntraced(function* (catalog: OperatorProfile.Catalog, kind: Kind, id: string) {
      const projects = (yield* known()).filter((item) => item.namespace === catalog.namespace.id)
      const agents = yield* Effect.promise(readAgents)
      const settings = projects.flatMap((project) =>
        Object.entries(agents[project.key] ?? {}).map((agent) => ({ project, name: agent[0], setting: agent[1] })),
      )
      const users: string[] = []
      if (kind === "type") {
        users.push(...catalog.layers.filter((item) => item.type === id).map((item) => `layer "${item.name}"`))
        users.push(...catalog.groups.filter((item) => item.types.includes(id)).map((item) => `group "${item.name}"`))
      }
      if (kind === "layer") {
        users.push(
          ...catalog.profiles
            .filter((item) => Object.values(item.slots).flat().includes(id))
            .map((item) => `profile "${item.name}"`),
        )
        users.push(
          ...settings
            .filter((item) =>
              Object.values(item.setting.override?.slots ?? {})
                .flat()
                .includes(id),
            )
            .map((item) => `the override of ${item.name} in ${item.project.name}`),
        )
        users.push(...projects.filter((item) => item.purpose === id).map((item) => `project ${item.name}`))
      }
      if (kind === "group") {
        users.push(...catalog.profiles.filter((item) => item.group === id).map((item) => `profile "${item.name}"`))
        users.push(
          ...settings
            .filter((item) => item.setting.override?.group === id)
            .map((item) => `the override of ${item.name} in ${item.project.name}`),
        )
      }
      if (kind === "profile") {
        users.push(
          ...settings
            .filter((item) => item.setting.profile === id)
            .map((item) => `${item.name} in ${item.project.name}`),
        )
        users.push(...projects.filter((item) => item.defaultProfile === id).map((item) => `project ${item.name}`))
        if (catalog.namespace.defaultProfile === id) users.push("the namespace default")
        // A helper's text (helpers.ts): deleted with the helper.
        const helpers = yield* Effect.promise(() => OperatorHelperFiles.read(catalog.namespace.id))
        users.push(...helpers.filter((item) => item.profile === id).map((item) => `helper "${item.name}"`))
      }
      return users.length ? users.join(", ") : undefined
    })

    const rank = (id: string) => (id === OperatorLayout.GLOBAL ? 0 : id === OperatorProfile.OPENCODE ? 1 : 2)
    const namespaces = Effect.fn("OperatorProfileStore.namespaces")(function* () {
      yield* Effect.promise(() => ensure())
      const ids = yield* Effect.promise(() => fs.readdir(root()).catch(() => [] as string[]))
      const records = yield* Effect.promise(() => Promise.all(ids.map(readNamespaceRecord)))
      const { projects, added } = yield* inventory()
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const globalFile = yield* Effect.promise(() => OperatorLayout.globalConfigFile())
      return (
        records
          .filter((item): item is OperatorProfile.Namespace => item !== undefined)
          // With a blank working directory, Global is OpenCode: no record of its own is listed.
          .filter((item) => OperatorLayout.resolveId(item.id, layout) === item.id)
          .toSorted(
            (a, b) =>
              // Global first, then OpenCode, then the others by name.
              rank(a.id) - rank(b.id) || a.name.localeCompare(b.name),
          )
          .map((namespace) => {
            const own = new Set(projects.filter((item) => item.namespace === namespace.id).map((item) => item.key))
            const order = added.filter((key) => own.has(key))
            const chosen = defaultProjectOf(namespace, order)
            const place = OperatorLayout.placeOf(namespace.id, layout)
            return {
              namespace: { ...namespace, ...(place ? { folder: place.folder } : {}) },
              target: place?.target ?? namespace.folder ?? "",
              inPlace: place?.inPlace ?? true,
              global: place?.global ?? false,
              configFile: place?.global ? globalFile : path.join(place?.configDir ?? "", "opencode.jsonc"),
              projects: projects.filter((item) => own.has(item.key)).map((item) => item.key),
              ...(chosen ? { defaultProject: chosen } : {}),
              ...(order[0] ? { firstProject: order[0] } : {}),
            }
          })
      )
    })

    const defaultProject = Effect.fn("OperatorProfileStore.defaultProject")(function* (ns: string) {
      return (yield* namespaces()).find((item) => item.namespace.id === ns)?.defaultProject
    })

    // A new namespace is a copy of OpenCode: its own items are copied, built-ins stay shared.
    const createNamespace = Effect.fn("OperatorProfileStore.createNamespace")(function* (input: {
      name: string
      purpose?: string
      adopt?: boolean
      folder?: string
      inheritGlobal?: boolean
    }) {
      yield* refuse(input.name.trim() ? undefined : "A namespace needs a name")
      const given = input.folder === undefined ? undefined : yield* Effect.promise(() => namespaceFolder(input.folder!))
      yield* refuse(given?.error)
      const where = given?.folder
        ? {
            id: yield* Effect.promise(() => freeId(root(), input.name, "")),
            folder: given.folder,
            exists: false,
            empty: true,
          }
        : yield* Effect.promise(() => namespacePreview(input.name))
      if ("error" in where) return yield* new InvalidError({ message: where.error ?? "No working directory" })
      if (where.exists && !where.empty) {
        yield* refuse(
          input.adopt
            ? undefined
            : `A folder ${where.folder} already exists. Use it for this namespace, or choose another name.`,
        )
        yield* refuse("problem" in where ? where.problem : undefined)
      }
      yield* Effect.tryPromise({
        try: () => fs.mkdir(where.folder, { recursive: true }),
        catch: (cause) => new InvalidError({ message: `${where.folder} cannot be created: ${String(cause)}` }),
      })
      const source = yield* load(OperatorProfile.OPENCODE)
      const id = where.id
      const now = Date.now()
      // The folder is derived (<working directory>/<id>): the record names none, unless one was given.
      const namespace: OperatorProfile.Namespace = {
        id,
        name: input.name.trim(),
        purpose: input.purpose ?? "",
        ...(source.namespace.defaultProfile ? { defaultProfile: source.namespace.defaultProfile } : {}),
        ...(given?.folder ? { folder: given.folder } : {}),
        ...(input.inheritGlobal === false ? { inheritGlobal: false } : {}),
        createdAt: now,
        updatedAt: now,
      }
      yield* Effect.promise(() => writeNamespace(namespace))
      const target = yield* load(id)
      yield* Effect.promise(() =>
        copyItems(source, target, [
          ...source.types.map((item) => ({ kind: "type" as const, id: item.id })),
          ...source.layers.map((item) => ({ kind: "layer" as const, id: item.id })),
          ...source.groups.map((item) => ({ kind: "group" as const, id: item.id })),
          ...source.profiles.map((item) => ({ kind: "profile" as const, id: item.id })),
        ]),
      )
      return namespace
    })

    const updateNamespace = Effect.fn("OperatorProfileStore.updateNamespace")(function* (
      id: string,
      input: {
        name?: string
        purpose?: string
        defaultProfile?: string
        folder?: string
        defaultProject?: string
        inheritGlobal?: boolean
      },
    ) {
      const catalog = yield* load(id)
      if (input.name !== undefined) yield* refuse(input.name.trim() ? undefined : "A namespace needs a name")
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      yield* refuse(
        input.inheritGlobal === false && OperatorLayout.isGlobal(id, layout)
          ? "Global can't leave out its own capabilities"
          : undefined,
      )
      yield* refuse(
        input.folder !== undefined && OperatorLayout.isGlobal(id, layout)
          ? `Global's folder is always ${Global.Path.config}`
          : undefined,
      )
      const folder =
        input.folder === undefined ? undefined : yield* Effect.promise(() => namespaceFolder(input.folder!))
      yield* refuse(folder?.error)
      if (input.defaultProject) {
        const own = (yield* known()).filter((item) => item.namespace === id).map((item) => item.key)
        yield* refuse(
          own.includes(input.defaultProject)
            ? undefined
            : `${input.defaultProject} is not a project of ${catalog.namespace.name}`,
        )
      }
      if (input.defaultProfile && !OperatorProfile.profiles(catalog).some((item) => item.id === input.defaultProfile))
        yield* refuse(`No profile "${input.defaultProfile}" in ${catalog.namespace.name}`)
      yield* refuse(helperDefault(catalog, input.defaultProfile))
      const next = {
        ...catalog.namespace,
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.defaultProfile !== undefined ? { defaultProfile: input.defaultProfile || undefined } : {}),
        ...(folder?.folder ? { folder: folder.folder } : {}),
        ...(input.defaultProject !== undefined ? { defaultProject: input.defaultProject || undefined } : {}),
        // Absent means on; the switch writes what it is set to.
        ...(input.inheritGlobal !== undefined ? { inheritGlobal: input.inheritGlobal } : {}),
        updatedAt: Date.now(),
      }
      // A cleared choice leaves no key behind (the response would carry it as null).
      const record = Object.fromEntries(
        Object.entries(next).filter((pair) => pair[1] !== undefined),
      ) as OperatorProfile.Namespace
      yield* Effect.promise(() => writeNamespace(record))
      return record
    })

    const removeNamespace = Effect.fn("OperatorProfileStore.removeNamespace")(function* (id: string) {
      yield* refuse(
        id === OperatorProfile.OPENCODE
          ? "OpenCode can't be deleted: it holds every project that isn't in another namespace"
          : id === OperatorLayout.GLOBAL
            ? "Global can't be deleted"
            : undefined,
      )
      const catalog = yield* load(id)
      const projects = (yield* known()).filter((item) => item.namespace === id)
      yield* refuse(
        projects.length
          ? `${catalog.namespace.name} still has projects: ${projects.map((item) => item.name).join(", ")}`
          : undefined,
      )
      // To Trash: the namespace's folder, its items with it.
      yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: "namespace",
          name: catalog.namespace.name,
          namespace: id,
          paths: [path.join(root(), id)],
        }).finally(() => revision++),
      )
    })

    const catalog = Effect.fn("OperatorProfileStore.catalog")(function* (ns: string) {
      const found = yield* load(ns)
      const projects = (yield* known()).filter((item) => item.namespace === ns)
      const agents = yield* Effect.promise(readAgents)
      return {
        namespace: found.namespace,
        types: OperatorProfile.types(found),
        layers: OperatorProfile.isOpenCode(found) ? [...OperatorProfile.BUILTIN_LAYERS, ...found.layers] : found.layers,
        groups: OperatorProfile.groups(found),
        profiles: OperatorProfile.profiles(found),
        projects,
        agents: projects.flatMap((project) =>
          Object.entries(agents[project.key] ?? {}).map((agent) => ({
            project: project.key,
            name: agent[0],
            ...agent[1],
          })),
        ),
        resolvers: OperatorResolverBuiltins.RESOLVERS,
        editableRules: OperatorResolverBuiltins.EDITABLE,
        helperRules: OperatorResolverBuiltins.HELPER_RESOLVER,
      }
    })

    const existing = <T extends { id: string }>(items: ReadonlyArray<T>, kind: Kind, id: string | undefined) =>
      Effect.gen(function* () {
        if (!id) return undefined
        if (OperatorProfile.isBuiltin(id))
          return yield* new InvalidError({ message: "OpenCode's own items cannot be changed" })
        const found = items.find((item) => item.id === id)
        if (!found) return yield* new NotFoundError({ message: `No ${kind} "${id}"` })
        return found
      })

    const saveType = Effect.fn("OperatorProfileStore.saveType")(function* (
      ns: string,
      id: string | undefined,
      input: { name: string; description?: string },
    ) {
      const found = yield* load(ns)
      yield* existing(found.types, "type", id)
      yield* refuse(input.name.trim() ? undefined : "A group type needs a name")
      const next = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(root(), ns, "types"), input.name, ".json"))),
        name: input.name.trim(),
        description: input.description ?? "",
        builtin: false,
      }
      yield* Effect.promise(() => writeItem(ns, "type", next))
      return next
    })

    const saveLayer = Effect.fn("OperatorProfileStore.saveLayer")(function* (
      ns: string,
      id: string | undefined,
      input: {
        name: string
        type: string
        section?: OperatorProfile.Section
        text: string
        prompt?: string
        resolver?: OperatorResolver.Resolver | null
        writer?: string | null
      },
    ) {
      const found = yield* load(ns)
      const before = yield* existing(found.layers, "layer", id)
      // Your Dynamic layer's writer: a helper of the namespace that only reads (agent_types_spec.md §4.6).
      const writer = input.writer === undefined ? before?.writer : (input.writer ?? undefined)
      if (writer && input.writer !== undefined) {
        const helper = yield* Effect.promise(() => OperatorHelperFiles.readOne(ns, writer))
        yield* refuse(!helper ? `No helper "${writer}" in this namespace` : undefined)
        const other = helper?.actions?.find((item) => !OperatorHelperFiles.LAYER_ACTIONS.includes(item))
        yield* refuse(other ? `${writer} declares ${other}: a helper that writes a layer may only read` : undefined)
      }
      // Your Dynamic layers hold a prompt; the dynamic generator writes their text for each session.
      // (A namespace's copy of one of OpenCode's per-request layers holds nothing.)
      const written = (before?.type ?? input.type) === OperatorProfile.DYNAMIC && !before?.replaces
      // Rules of its own (spec §6): kept unless given; the default ones are not kept (the layer follows them).
      const shape = { type: before?.type ?? input.type, replaces: before?.replaces }
      const given = input.resolver === undefined ? before?.resolver : (input.resolver ?? undefined)
      if (input.resolver) yield* refuse(OperatorProfile.checkResolver(shape, input.resolver))
      // Its judge: a helper of the namespace that only reads, as a writer is (dynamic_layer_resolution_spec.md §2.3).
      const judge = input.resolver?.judge?.helper
      if (judge) {
        const helper = yield* Effect.promise(() => OperatorHelperFiles.readOne(ns, judge))
        yield* refuse(!helper ? `No helper "${judge}" in this namespace to judge` : undefined)
        const other = helper?.actions?.find((item) => !OperatorHelperFiles.LAYER_ACTIONS.includes(item))
        yield* refuse(other ? `${judge} declares ${other}: a helper that judges a layer may only read` : undefined)
      }
      const rules =
        given && !OperatorProfile.sameRules(given, OperatorProfile.defaultResolver(shape)) ? given : undefined
      // The prompt is what a helper source writes from.
      const helper =
        written && (rules ?? OperatorResolverBuiltins.HELPER_RESOLVER).sources.some((s) => s.kind === "helper")
      yield* refuse(helper && !input.prompt?.trim() ? "A Dynamic layer needs a prompt" : undefined)
      // A copy keeps its type and section; a layer's type changes only in Custom.
      const type = before?.replaces ? before.type : input.type
      // Helper and Dynamic layers have sections of their own.
      const own = type === OperatorProfile.HELPER || type === OperatorProfile.DYNAMIC ? sectionFor(type) : undefined
      const section = own ?? before?.section ?? input.section ?? sectionFor(type)
      yield* refuse(
        before && !before.replaces && before.type !== type && before.section !== "custom"
          ? "Only Custom layers can change type"
          : undefined,
      )
      yield* refuse(
        before && before.section !== section
          ? "A layer cannot change to or from the Helper or Dynamic type"
          : undefined,
      )
      yield* refuse(OperatorProfile.checkLayer(found, { name: input.name, type, replaces: before?.replaces }))
      yield* refuse(type === "purpose" && section !== "purpose" ? "Purpose layers are Project Purposes" : undefined)
      if (before && before.type !== type) yield* refuse(yield* usedBy(found, "layer", before.id))
      const next: OperatorProfile.Layer = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(root(), ns, "layers"), input.name, ".md"))),
        name: input.name.trim(),
        type,
        section,
        ...(before?.replaces ? { replaces: before.replaces } : {}),
        ...(before?.basedOn ? { basedOn: before.basedOn } : {}),
        text: written ? "" : input.text,
        ...(written ? { prompt: input.prompt?.trim() ?? "" } : {}),
        ...(written && writer ? { writer } : {}),
        ...(rules ? { resolver: rules } : written ? { resolver: OperatorResolverBuiltins.HELPER_RESOLVER } : {}),
        origin: "user",
      }
      yield* Effect.promise(() => writeItem(ns, "layer", next))
      return next
    })

    const copyBuiltin = Effect.fn("OperatorProfileStore.copyBuiltin")(function* (
      ns: string,
      id: string,
      text?: string,
    ) {
      yield* load(ns)
      const original = OperatorProfile.builtinLayerById(id)
      if (!original || original.origin !== "builtin")
        return yield* new InvalidError({ message: `"${id}" is not one of OpenCode's texts` })
      const name = `${original.name} – copy`
      const next: OperatorProfile.Layer = {
        id: yield* Effect.promise(() => freeId(path.join(root(), ns, "layers"), name, ".md")),
        name,
        type: original.type,
        section: original.section,
        replaces: original.id,
        text: text ?? original.text,
        ...(original.text ? { basedOn: OperatorProfile.fingerprint(original.text) } : {}),
        origin: "user",
      }
      yield* Effect.promise(() => writeItem(ns, "layer", next))
      return next
    })

    // A copy of one of OpenCode's texts takes OpenCode's current text (after a release changed it).
    const syncLayer = Effect.fn("OperatorProfileStore.syncLayer")(function* (ns: string, id: string) {
      const found = yield* load(ns)
      const layer = found.layers.find((item) => item.id === id)
      if (!layer) return yield* new NotFoundError({ message: `No layer "${id}" in ${found.namespace.name}` })
      const original = layer.replaces ? OperatorProfile.builtinLayerById(layer.replaces) : undefined
      if (!original?.text)
        return yield* new InvalidError({ message: `${layer.name} is not a copy of one of OpenCode's texts` })
      const { outdated: _, ...rest } = layer
      const next = { ...rest, text: original.text, basedOn: OperatorProfile.fingerprint(original.text) }
      yield* Effect.promise(() => writeItem(ns, "layer", next))
      return next
    })

    const saveGroup = Effect.fn("OperatorProfileStore.saveGroup")(function* (
      ns: string,
      id: string | undefined,
      input: { name: string; types: ReadonlyArray<string> },
    ) {
      const found = yield* load(ns)
      yield* existing(found.groups, "group", id)
      yield* refuse(OperatorProfile.checkGroup(found, input))
      const next = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(root(), ns, "groups"), input.name, ".json"))),
        name: input.name.trim(),
        types: [...input.types],
        builtin: false,
      }
      // Profiles on this group must still be valid.
      const after = { ...found, groups: [...found.groups.filter((item) => item.id !== next.id), next] }
      const broken = found.profiles.find(
        (item) => item.group === next.id && OperatorProfile.checkSlots(after, { group: item.group, slots: item.slots }),
      )
      if (broken)
        yield* refuse(
          `The profile "${broken.name}" uses this group: ${OperatorProfile.checkSlots(after, { group: broken.group, slots: broken.slots })}`,
        )
      yield* Effect.promise(() => writeItem(ns, "group", next))
      return next
    })

    const saveProfile = Effect.fn("OperatorProfileStore.saveProfile")(function* (
      ns: string,
      id: string | undefined,
      input: { name: string; group: string; slots: OperatorProfile.Slots },
    ) {
      const found = yield* load(ns)
      yield* existing(found.profiles, "profile", id)
      yield* refuse(input.name.trim() ? undefined : "A profile needs a name")
      // Slots shaped as before the Dynamic type are read as they are now.
      const order = OperatorProfile.groups(found).find((item) => item.id === input.group)?.types ?? []
      const slots = OperatorProfile.migrateSlots(input.slots, order)
      yield* refuse(OperatorProfile.checkSlots(found, { group: input.group, slots }))
      const group = OperatorProfile.groups(found).find((item) => item.id === input.group)!
      const next = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(root(), ns, "profiles"), input.name, ".json"))),
        name: input.name.trim(),
        group: input.group,
        // Only the group's types are kept, in its order.
        slots: Object.fromEntries(
          group.types.filter((type) => type !== "purpose").map((type) => [type, [...(slots[type] ?? [])]]),
        ),
        builtin: false,
      }
      yield* Effect.promise(() => writeItem(ns, "profile", next))
      return next
    })

    const remove = Effect.fn("OperatorProfileStore.remove")(function* (ns: string, kind: Kind, id: string) {
      const found = yield* load(ns)
      const items = { type: found.types, layer: found.layers, group: found.groups, profile: found.profiles }[kind]
      yield* existing(items as ReadonlyArray<{ id: string }>, kind, id)
      const users = yield* usedBy(found, kind, id)
      yield* refuse(users ? `Still used by ${users}` : undefined)
      const name = (items as ReadonlyArray<{ id: string; name: string }>).find((item) => item.id === id)?.name ?? id
      // To Trash, from where it can be restored.
      yield* Effect.promise(() =>
        OperatorTrashFiles.put({ kind, name, namespace: ns, paths: [itemFile(ns, kind, id)] }).finally(
          () => revision++,
        ),
      )
    })

    const copyTo = Effect.fn("OperatorProfileStore.copyTo")(function* (
      ns: string,
      kind: Kind,
      id: string,
      target: string,
    ) {
      yield* refuse(ns === target ? "Choose another namespace" : undefined)
      const source = yield* load(ns)
      const destination = yield* load(target)
      yield* refuse(
        OperatorProfile.isBuiltin(id) ? "Every namespace has its own copies of OpenCode's items already" : undefined,
      )
      return (yield* Effect.promise(() => copyItems(source, destination, [{ kind, id }], { kind, id }))).copied
    })

    const projects = Effect.fn("OperatorProfileStore.projects")(function* () {
      return yield* known()
    })

    const setProject = Effect.fn("OperatorProfileStore.setProject")(function* (
      key: string,
      input: { namespace?: string; purpose?: string; defaultProfile?: string; dryRun?: boolean },
    ) {
      // Not a project yet: recorded here (its id is made below).
      const current: ProjectInfo = (yield* known()).find((item) => item.key === key) ?? {
        key,
        id: "",
        name: path.basename(key),
        namespace: OperatorProfile.OPENCODE,
      }
      const target = input.namespace ?? current.namespace
      const destination = yield* load(target)
      const moving = target !== current.namespace
      const agents = yield* Effect.promise(readAgents)
      // Moving copies what the project uses into the new namespace, so it behaves as before.
      const moved = moving
        ? yield* Effect.promise(async () => {
            const source = (await readNamespace(current.namespace))!
            return copyItems(source, destination, rootsOf(current, agents[key] ?? {}), undefined, input.dryRun)
          })
        : { copied: [] as Copied[], ids: new Map<string, string>() }
      const map = (kind: Kind, id: string | undefined) => (id ? (moved.ids.get(`${kind}:${id}`) ?? id) : undefined)
      // An empty string clears a link; a missing one keeps it (pointed at its copy after a move).
      const purpose = input.purpose === undefined ? map("layer", current.purpose) : input.purpose || undefined
      const defaultProfile =
        input.defaultProfile === undefined ? map("profile", current.defaultProfile) : input.defaultProfile || undefined
      const all = yield* Effect.promise(readProjects)
      const next: OperatorProfile.ProjectSetting = {
        namespace: target,
        // Its id stays; a project the console records now gets one.
        id: all[key]?.id ?? OperatorProjectIds.make(takenIds(all)),
        ...(purpose ? { purpose } : {}),
        ...(defaultProfile ? { defaultProfile } : {}),
      }
      if (input.dryRun) return { project: { ...current, ...next, id: next.id! }, copied: moved.copied }
      const after = (yield* Effect.promise(() => readNamespace(target)))!
      if (next.purpose) {
        const linked = after.layers.find((item) => item.id === next.purpose)
        yield* refuse(
          !linked || linked.type !== "purpose"
            ? `No Project Purpose "${next.purpose}" in ${after.namespace.name}`
            : undefined,
        )
      }
      if (next.defaultProfile && !OperatorProfile.profiles(after).some((item) => item.id === next.defaultProfile))
        yield* refuse(`No profile "${next.defaultProfile}" in ${after.namespace.name}`)
      yield* refuse(helperDefault(after, next.defaultProfile))
      const created = !all[key]
      yield* Effect.promise(async () => {
        await writeJson(path.join(root(), "projects.json"), { ...(await readProjects()), [key]: next })
        if (created) announceCreated({ key, id: next.id!, name: current.name, namespace: target })
        if (!moving || !agents[key]) return
        const remapped = remapAgents(agents[key]!, map)
        await writeJson(path.join(root(), "agents.json"), { ...agents, [key]: remapped })
      })
      return { project: { ...current, ...next, id: next.id! }, copied: moved.copied }
    })

    const agent = Effect.fn("OperatorProfileStore.agent")(function* (project: string, name: string) {
      return (yield* Effect.promise(readAgents))[project]?.[name] ?? {}
    })

    const agentPrompt = Effect.fn("OperatorProfileStore.agentPrompt")(function* (project: string, name: string) {
      const loaded = yield* Effect.promise(() => forProject(project))
      const setting = loaded.agents[name] ?? {}
      const chosen = OperatorProfile.profileFor(loaded.catalog, { agent: name, setting, project: loaded.project })
      const fallback = OperatorProfile.profileFor(loaded.catalog, { agent: name, project: loaded.project })
      return {
        setting,
        namespace: { id: loaded.catalog.namespace.id, name: loaded.catalog.namespace.name },
        profile: { id: chosen.profile.id, name: chosen.profile.name, source: chosen.source },
        default: { id: fallback.profile.id, name: fallback.profile.name },
      }
    })

    const setAgent = Effect.fn("OperatorProfileStore.setAgent")(function* (
      project: string,
      name: string,
      given: OperatorProfile.AgentSetting,
    ) {
      const setting = OperatorProfile.migrateSetting(name, given)
      const context = yield* Effect.promise(() => forProject(project))
      const found = context.catalog
      if (setting.profile && !OperatorProfile.profiles(found).some((item) => item.id === setting.profile))
        yield* refuse(`No profile "${setting.profile}" in ${found.namespace.name}`)
      if (setting.override) {
        const chosen = OperatorProfile.profileFor(found, { agent: name, setting, project: context.project })
        if (OperatorProfile.isHelper(found, chosen.profile))
          yield* refuse(`${name} uses the helper profile ${chosen.profile.name}: a helper agent has no override`)
        const shape = OperatorProfile.effective(found, chosen.profile, setting.override)
        yield* refuse(
          OperatorProfile.checkSlots(
            found,
            { group: shape.group.id, slots: shape.slots },
            setting.override.layers ?? {},
          ),
        )
        if (
          setting.override.group &&
          !OperatorProfile.groups(found).some((item) => item.id === setting.override!.group)
        )
          yield* refuse(`No group "${setting.override.group}"`)
      }
      // The agent's own texts are kept while its slots name them.
      const override = setting.override ? OperatorProfile.tidyOverride(setting.override) : undefined
      const next = {
        ...(setting.profile ? { profile: setting.profile } : {}),
        ...(override ? { override } : {}),
      }
      yield* Effect.promise(async () => {
        const all = await readAgents()
        const agents = { ...(all[project] ?? {}) }
        if (Object.keys(next).length) agents[name] = next
        else delete agents[name]
        await writeJson(path.join(root(), "agents.json"), { ...all, [project]: agents })
      })
      return next
    })

    const copyProject = Effect.fn("OperatorProfileStore.copyProject")(function* (
      source: string,
      target: string,
      input: { namespace?: string },
    ) {
      const from: ProjectInfo = (yield* known()).find((item) => item.key === source) ?? {
        key: source,
        id: "",
        name: path.basename(source),
        namespace: OperatorProfile.OPENCODE,
      }
      const namespace = input.namespace ?? from.namespace
      const destination = yield* load(namespace)
      const agents = yield* Effect.promise(readAgents)
      const own = agents[source] ?? {}
      // In the same namespace the prompt profiles are shared; in another, what the project uses is copied.
      const moved =
        namespace === from.namespace
          ? { copied: [] as Copied[], ids: new Map<string, string>() }
          : yield* Effect.promise(async () =>
              copyItems((await readNamespace(from.namespace))!, destination, rootsOf(from, own)),
            )
      const map = (kind: Kind, id: string | undefined) => (id ? (moved.ids.get(`${kind}:${id}`) ?? id) : undefined)
      const purpose = map("layer", from.purpose)
      const defaultProfile = map("profile", from.defaultProfile)
      const records = yield* Effect.promise(readProjects)
      const next: OperatorProfile.ProjectSetting = {
        namespace,
        // A copy is a project of its own: its own id.
        id: OperatorProjectIds.make(takenIds(records)),
        ...(purpose ? { purpose } : {}),
        ...(defaultProfile ? { defaultProfile } : {}),
      }
      yield* Effect.promise(async () => {
        await writeJson(path.join(root(), "projects.json"), { ...(await readProjects()), [target]: next })
        announceCreated({ key: target, id: next.id!, name: path.basename(target), namespace })
        if (Object.keys(own).length)
          await writeJson(path.join(root(), "agents.json"), { ...agents, [target]: remapAgents(own, map) })
      })
      return {
        project: { key: target, name: path.basename(target), ...next, id: next.id!, registered: true },
        copied: moved.copied,
      }
    })

    return Service.of({
      copyProject,
      namespaces,
      defaultProject,
      createNamespace,
      updateNamespace,
      removeNamespace,
      catalog,
      saveType,
      saveLayer,
      copyBuiltin,
      syncLayer,
      saveGroup,
      saveProfile,
      remove,
      copyTo,
      projects,
      setProject,
      agent,
      agentPrompt,
      setAgent,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

// A default profile is for every agent of a project or namespace; a helper profile would make them all
// helper agents.
function helperDefault(catalog: OperatorProfile.Catalog, id: string | undefined) {
  const found = id ? OperatorProfile.profiles(catalog).find((item) => item.id === id) : undefined
  return found && OperatorProfile.isHelper(catalog, found)
    ? `${found.name} is a helper profile: only an agent can use it`
    : undefined
}

// The section a new layer of a type shows in.
function sectionFor(type: string): OperatorProfile.Section {
  if (type === "purpose") return "purpose"
  if (type === "role") return "role"
  if (type === "identity") return "identity"
  if (type === OperatorProfile.HELPER) return "helper"
  if (type === OperatorProfile.DYNAMIC) return "dynamic"
  return "custom"
}

type Ref = { kind: Kind; id: string }

// Copies items from one namespace to another, with what they use that the target lacks. An item the
// target already has (same id, same content) is reused; one it has under the same id but with other
// content, and `fresh` (the item asked for), get a new id. A name the target already uses gets
// " (copy)". Returns what was copied and how ids changed.
async function copyItems(
  from: OperatorProfile.Catalog,
  to: OperatorProfile.Catalog,
  roots: ReadonlyArray<Ref>,
  fresh?: Ref,
  dryRun?: boolean,
) {
  const ns = to.namespace.id
  const ids = new Map<string, string>()
  const copied: Copied[] = []
  const lists = {
    type: [...to.types] as Array<{ id: string; name: string }>,
    layer: [...to.layers] as Array<{ id: string; name: string }>,
    group: [...to.groups] as Array<{ id: string; name: string }>,
    profile: [...to.profiles] as Array<{ id: string; name: string }>,
  }
  const sources = { type: from.types, layer: from.layers, group: from.groups, profile: from.profiles }
  const visit = async (ref: Ref): Promise<string> => {
    // OpenCode's item, or a namespace's own copy of it: the target's own version (the built-in itself
    // in OpenCode), copied there first if the target has none.
    const builtin = ref.kind === "type" ? undefined : OperatorProfile.builtinOf(ref.kind, ref.id)
    if (builtin && (OperatorProfile.isBuiltin(ref.id) || OperatorProfile.own(builtin) === ref.id)) {
      const target = ns === OperatorProfile.OPENCODE ? builtin : OperatorProfile.own(builtin)
      ids.set(`${ref.kind}:${ref.id}`, target)
      if (ns === OperatorProfile.OPENCODE || lists[ref.kind].some((entry) => entry.id === target)) return target
      const source =
        (sources[ref.kind] as ReadonlyArray<{ id: string; name: string }>).find((entry) => entry.id === ref.id) ??
        (ref.kind === "layer" ? OperatorProfile.builtinLayerById(builtin) : undefined)
      if (!source) return target
      const content =
        ref.kind === "layer" && source.id === builtin
          ? { ...(source as OperatorProfile.Layer), origin: "user" as const, replaces: builtin }
          : await remap(ref.kind, source)
      const next = { ...content, id: target, name: source.name }
      lists[ref.kind].push(next)
      if (!dryRun) await writeItem(ns, ref.kind, next as never)
      return target
    }
    const known = ids.get(`${ref.kind}:${ref.id}`)
    if (known) return known
    const item = (sources[ref.kind] as ReadonlyArray<{ id: string; name: string }>).find((entry) => entry.id === ref.id)
    if (!item) return ref.id
    const content = await remap(ref.kind, item)
    const there = lists[ref.kind].find((entry) => entry.id === ref.id)
    const isFresh = fresh?.kind === ref.kind && fresh.id === ref.id
    if (there && !isFresh && same(ref.kind, there, content)) {
      ids.set(`${ref.kind}:${ref.id}`, ref.id)
      return ref.id
    }
    const id = there
      ? await freeId(
          path.join(root(), ns, folders[ref.kind]),
          item.name,
          extensions[ref.kind],
          lists[ref.kind].map((entry) => entry.id),
        )
      : ref.id
    const name = lists[ref.kind].some((entry) => entry.name === item.name) ? `${item.name} (copy)` : item.name
    const next = { ...content, id, name }
    lists[ref.kind].push(next)
    ids.set(`${ref.kind}:${ref.id}`, id)
    copied.push({ kind: ref.kind, id, name })
    if (!dryRun) await writeItem(ns, ref.kind, next as never)
    return id
  }
  // An item with what it uses copied first and its references pointed at the copies.
  const remap = async (kind: Kind, item: { id: string; name: string }) => {
    if (kind === "layer") {
      const value = item as OperatorProfile.Layer
      return { ...value, type: OperatorProfile.isBuiltin(value.type) ? value.type : await visitType(value.type) }
    }
    if (kind === "group") {
      const value = item as OperatorProfile.Group
      return { ...value, types: await Promise.all(value.types.map(visitType)) }
    }
    if (kind === "profile") {
      const value = item as OperatorProfile.Profile
      const slots: Record<string, string[]> = {}
      for (const [type, layers] of Object.entries(value.slots)) {
        const ids = []
        for (const id of layers) ids.push(await visit({ kind: "layer", id }))
        slots[await visitType(type)] = ids
      }
      return { ...value, group: await visit({ kind: "group", id: value.group }), slots }
    }
    return item
  }
  const visitType = (type: string) =>
    OperatorProfile.builtinTypes.some((item) => item.id === type)
      ? Promise.resolve(type)
      : visit({ kind: "type", id: type })
  for (const ref of roots) await visit(ref)
  // New ids by "<kind>:<old id>".
  return { copied, ids }
}

// What a project's prompt settings use in its namespace: its purpose, its default profile, and the
// profiles, groups and layers its agents' settings name.
function rootsOf(project: ProjectInfo, agents: Record<string, OperatorProfile.AgentSetting>) {
  return [
    ...(project.purpose ? [{ kind: "layer" as const, id: project.purpose }] : []),
    ...(project.defaultProfile ? [{ kind: "profile" as const, id: project.defaultProfile }] : []),
    ...Object.values(agents).flatMap((setting) => [
      ...(setting.profile ? [{ kind: "profile" as const, id: setting.profile }] : []),
      ...(setting.override?.group ? [{ kind: "group" as const, id: setting.override.group }] : []),
      ...Object.values(setting.override?.slots ?? {})
        .flat()
        .filter((layer) => !OperatorProfile.isLocal(layer))
        .map((layer) => ({ kind: "layer" as const, id: layer })),
      // The layers the agent's own texts copy, for Reset.
      ...Object.values(setting.override?.layers ?? {}).flatMap((item) =>
        item.basedOn ? [{ kind: "layer" as const, id: item.basedOn }] : [],
      ),
    ]),
  ]
}

// Agents' settings with their profiles, groups and layers pointed at their copies.
function remapAgents(
  agents: Record<string, OperatorProfile.AgentSetting>,
  map: (kind: Kind, id: string | undefined) => string | undefined,
) {
  return Object.fromEntries(
    Object.entries(agents).map((agent) => [
      agent[0],
      {
        ...(agent[1].profile ? { profile: map("profile", agent[1].profile) } : {}),
        ...(agent[1].override
          ? {
              override: {
                ...(agent[1].override.group ? { group: map("group", agent[1].override.group) } : {}),
                ...(agent[1].override.slots
                  ? {
                      slots: Object.fromEntries(
                        Object.entries(agent[1].override.slots).map((slot) => [
                          slot[0],
                          slot[1].map((id) => (OperatorProfile.isLocal(id) ? id : map("layer", id)!)),
                        ]),
                      ),
                    }
                  : {}),
                ...(agent[1].override.layers
                  ? { layers: remapLocal(agent[1].override.layers, (id) => map("layer", id)) }
                  : {}),
              },
            }
          : {}),
      },
    ]),
  )
}

function same(kind: Kind, a: object, b: object) {
  const strip = (value: object) => JSON.stringify({ ...value, id: undefined, name: undefined })
  return kind === "type" ? true : strip(a) === strip(b)
}

const folders: Record<Kind, string> = { type: "types", layer: "layers", group: "groups", profile: "profiles" }
const extensions: Record<Kind, string> = { type: ".json", layer: ".md", group: ".json", profile: ".json" }

// Where a namespace's item and record are kept (the agent page names them, to trace a prompt's text).
export function itemFile(ns: string, kind: Kind, id: string) {
  return path.join(root(), ns, folders[kind], `${id}${extensions[kind]}`)
}
export function namespaceFile(ns: string) {
  return path.join(root(), ns, "namespace.json")
}

// Where the agents' prompt settings are, their own texts included.
export function agentsFile() {
  return path.join(root(), "agents.json")
}

async function writeItem(
  ns: string,
  kind: Kind,
  item: OperatorProfile.GroupType | OperatorProfile.Layer | OperatorProfile.Group | OperatorProfile.Profile,
) {
  const file = itemFile(ns, kind, item.id)
  if (kind === "layer") {
    const value = item as OperatorProfile.Layer
    const data = {
      id: value.id,
      name: value.name,
      type: value.type,
      section: value.section,
      ...(value.replaces ? { replaces: value.replaces } : {}),
      ...(value.basedOn ? { basedOn: value.basedOn } : {}),
      ...(value.writer ? { writer: value.writer } : {}),
      // A Dynamic layer's own rules (the default ones, the helper's or OpenCode's, are not written).
      ...(value.resolver && !OperatorProfile.sameRules(value.resolver, OperatorProfile.defaultResolver(value))
        ? { resolver: value.resolver }
        : {}),
    }
    // A Dynamic layer's file holds its prompt.
    // One newline is added here and taken off when read, so texts keep their own last newline (a
    // copy of OpenCode's text must stay byte for byte the same).
    const body = value.prompt ?? value.text
    return write(file, matter.stringify(`${body}\n`, data))
  }
  return writeJson(file, Object.fromEntries(Object.entries(item).filter((pair) => pair[0] !== "builtin")))
}

async function writeNamespace(namespace: OperatorProfile.Namespace) {
  return writeJson(path.join(root(), namespace.id, "namespace.json"), namespace)
}

async function readNamespaceRecord(id: string): Promise<OperatorProfile.Namespace | undefined> {
  const data = (await Bun.file(path.join(root(), id, "namespace.json"))
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (!data) return undefined
  return {
    id,
    name: typeof data.name === "string" ? data.name : id,
    purpose: typeof data.purpose === "string" ? data.purpose : "",
    ...(typeof data.defaultProfile === "string" ? { defaultProfile: data.defaultProfile } : {}),
    ...(typeof data.folder === "string" && data.folder ? { folder: data.folder } : {}),
    ...(typeof data.defaultProject === "string" && data.defaultProject ? { defaultProject: data.defaultProject } : {}),
    ...(typeof data.inheritGlobal === "boolean" ? { inheritGlobal: data.inheritGlobal } : {}),
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  }
}

async function readLayers(dir: string): Promise<OperatorProfile.Layer[]> {
  const files = await Glob.scan("*.md", { cwd: dir, absolute: true, symlink: true }).catch(() => [] as string[])
  const layers = await Promise.all(
    files.map(async (file): Promise<OperatorProfile.Layer | undefined> => {
      const parsed = await Bun.file(file)
        .text()
        .then((text) => matter(text))
        .catch(() => undefined)
      if (!parsed) return undefined
      const data = parsed.data as Record<string, unknown>
      const section = Schema.decodeUnknownOption(OperatorProfile.Section)(data.section)
      const type = typeof data.type === "string" ? data.type : "identity"
      const body = parsed.content.replace(/\n$/, "")
      const listed = typeof data.replaces === "string" ? data.replaces : undefined
      const original = listed ? OperatorProfile.builtinLayerById(listed) : undefined
      // A built-in OpenCode no longer has: the namespace's own copy of it (made automatically) is not
      // read; a copy made with Edit a copy is an ordinary layer of the namespace.
      if (listed && !original && path.basename(file, ".md") === OperatorProfile.own(listed)) return undefined
      const replaces = original ? listed : undefined
      const basedOn = typeof data.basedOn === "string" ? data.basedOn : undefined
      // Your Dynamic layers hold a prompt; copies of OpenCode's per-request layers hold nothing.
      const written = type === OperatorProfile.DYNAMIC && !replaces
      // Rules of its own (your Dynamic layers; copies of OpenCode's per-request ones); yours without
      // any are written by a helper from their prompt.
      const decoded = Schema.decodeUnknownOption(OperatorResolver.Resolver)(data.resolver)
      const rules =
        decoded._tag === "Some" && !OperatorProfile.checkResolver({ type, replaces }, decoded.value)
          ? decoded.value
          : written
            ? OperatorResolverBuiltins.HELPER_RESOLVER
            : undefined
      return {
        id: path.basename(file, ".md"),
        name: typeof data.name === "string" ? data.name : path.basename(file, ".md"),
        type,
        section: section._tag === "Some" ? section.value : "custom",
        ...(replaces ? { replaces } : {}),
        ...(written ? { text: "", prompt: body } : { text: body }),
        ...(rules ? { resolver: rules } : {}),
        ...(original?.delivery ? { delivery: original.delivery } : {}),
        ...(basedOn ? { basedOn } : {}),
        ...(written && typeof data.writer === "string" && data.writer ? { writer: data.writer } : {}),
        // OpenCode changed its text since this copy was made (a release).
        ...(basedOn && original?.text && OperatorProfile.fingerprint(original.text) !== basedOn
          ? { outdated: true }
          : {}),
        origin: "user",
      }
    }),
  )
  return layers.filter((item) => item !== undefined)
}

async function readJsonDir<T>(dir: string, decode: (data: Record<string, unknown>) => T): Promise<T[]> {
  const files = await Glob.scan("*.json", { cwd: dir, absolute: true, symlink: true }).catch(() => [] as string[])
  const items = await Promise.all(
    files.map(
      (file): Promise<T | undefined> =>
        Bun.file(file)
          .json()
          .then((data: unknown) =>
            data && typeof data === "object"
              ? decode({ id: path.basename(file, ".json"), ...(data as Record<string, unknown>) })
              : undefined,
          )
          .catch(() => undefined),
    ),
  )
  return items.filter((item) => item !== undefined)
}

async function writeJson(file: string, data: unknown) {
  return write(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
  revision++
}

// Bumped on every write and removal, so readers that cache a read (the prompt plugin) see a change at
// once.
let revision = 0
export function storeRevision() {
  return revision
}

// An id made from the name that no file in `dir` (and none of `taken`) uses yet.
async function freeId(dir: string, name: string, ext: string, taken: ReadonlyArray<string> = []) {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item"
  const next = async (index: number): Promise<string> => {
    const id = index === 1 ? slug : `${slug}-${index}`
    const used =
      taken.includes(id) ||
      (await fs.stat(path.join(dir, `${id}${ext}`)).then(
        () => true,
        () => false,
      ))
    return used ? next(index + 1) : id
  }
  return next(1)
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function slotsOf(value: unknown): OperatorProfile.Slots {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map((pair) => [pair[0], strings(pair[1])]))
}

function localOf(value: unknown): Record<string, OperatorProfile.LocalLayer> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, Record<string, unknown> | undefined>).flatMap(([id, item]) =>
      typeof item?.type === "string" && typeof item.text === "string"
        ? [
            [
              id,
              {
                type: item.type,
                text: item.text,
                ...(typeof item.basedOn === "string" ? { basedOn: item.basedOn } : {}),
              },
            ] as const,
          ]
        : [],
    ),
  )
}

function agentSetting(value: Record<string, unknown> | undefined): OperatorProfile.AgentSetting {
  const override = value?.override as Record<string, unknown> | undefined
  return {
    ...(typeof value?.profile === "string" ? { profile: value.profile } : {}),
    ...(override
      ? {
          override: {
            ...(typeof override.group === "string" ? { group: override.group } : {}),
            ...(override.slots ? { slots: slotsOf(override.slots) } : {}),
            ...(override.layers ? { layers: localOf(override.layers) } : {}),
          },
        }
      : {}),
  }
}
