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
import { OperatorProfile } from "./profile"

// Prompt profile data is server-wide, in the global config folder; nothing goes into a project:
//
//   namespaces/<ns>/namespace.json      { id, name, purpose, defaultProfile?, createdAt, updatedAt }
//   namespaces/<ns>/types/<id>.json     { id, name, description }
//   namespaces/<ns>/layers/<id>.md      frontmatter { id, name, type, section, replaces? }; body: the text
//   namespaces/<ns>/groups/<id>.json    { id, name, types }
//   namespaces/<ns>/profiles/<id>.json  { id, name, group, slots }
//   namespaces/projects.json            { <projectKey>: { namespace, purpose?, defaultProfile? } }
//   namespaces/agents.json              { <projectKey>: { <agentName>: { profile?, override? } } }
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
  name: Schema.String,
  namespace: Schema.String,
  purpose: Schema.optional(Schema.String),
  defaultProfile: Schema.optional(Schema.String),
  registered: Schema.optional(Schema.Boolean).annotate({
    description: "A git project, or a folder outside git registered as a project",
  }),
}).annotate({ identifier: "OperatorPromptProject" })
export type ProjectInfo = typeof ProjectInfo.Type

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
  namespace: OperatorProfile.Namespace,
  projects: Schema.Array(Schema.String).annotate({ description: "Keys of the namespace's projects" }),
}).annotate({ identifier: "OperatorNamespaceSummary" })

export const CatalogInfo = Schema.Struct({
  namespace: OperatorProfile.Namespace,
  types: Schema.Array(OperatorProfile.GroupType),
  layers: Schema.Array(OperatorProfile.Layer),
  groups: Schema.Array(OperatorProfile.Group),
  profiles: Schema.Array(OperatorProfile.Profile),
  projects: Schema.Array(ProjectInfo).annotate({ description: "The namespace's projects" }),
  agents: Schema.Array(AgentInfo).annotate({ description: "Prompt settings of the agents of those projects" }),
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
  readonly createNamespace: (input: {
    name: string
    purpose?: string
  }) => Effect.Effect<OperatorProfile.Namespace, Failure>
  readonly updateNamespace: (
    id: string,
    input: { name?: string; purpose?: string; defaultProfile?: string },
  ) => Effect.Effect<OperatorProfile.Namespace, Failure>
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
    input: { name: string; type: string; section?: OperatorProfile.Section; text: string },
  ) => Effect.Effect<OperatorProfile.Layer, Failure>
  /** Makes an editable copy of one of OpenCode's texts; `text` gives a tool description's text. */
  readonly copyBuiltin: (ns: string, id: string, text?: string) => Effect.Effect<OperatorProfile.Layer, Failure>
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
  const catalog = (await readNamespace(project?.namespace ?? OperatorProfile.OPENCODE)) ??
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
    project: project && catalog.namespace.id === project.namespace ? project : undefined,
    agents: (await readAgents())[key] ?? {},
  }
}

export async function readNamespace(id: string): Promise<OperatorProfile.Catalog | undefined> {
  const dir = path.join(root(), id)
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
  return { namespace, types, layers, groups, profiles }
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
          ...(typeof pair[1].purpose === "string" ? { purpose: pair[1].purpose } : {}),
          ...(typeof pair[1].defaultProfile === "string" ? { defaultProfile: pair[1].defaultProfile } : {}),
        },
      ]),
  )
}

export async function readAgents(): Promise<Record<string, Record<string, OperatorProfile.AgentSetting>>> {
  const data = await Bun.file(path.join(root(), "agents.json"))
    .json()
    .catch(() => ({}))
  return Object.fromEntries(
    Object.entries(data as Record<string, Record<string, Record<string, unknown>>>).map((project) => [
      project[0],
      Object.fromEntries(Object.entries(project[1] ?? {}).map((agent) => [agent[0], agentSetting(agent[1])])),
    ]),
  )
}

// The OpenCode namespace exists from the first start, with its record only.
export async function ensure() {
  const file = path.join(root(), OperatorProfile.OPENCODE, "namespace.json")
  if (await Bun.file(file).exists()) return
  const now = Date.now()
  await writeJson(file, {
    id: OperatorProfile.OPENCODE,
    name: "OpenCode",
    purpose: "",
    createdAt: now,
    updatedAt: now,
  }).catch(() => undefined)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* Effect.promise(ensure)

    const refuse = (message: string | undefined) => (message ? Effect.fail(new InvalidError({ message })) : Effect.void)

    const load = Effect.fnUntraced(function* (ns: string) {
      yield* Effect.promise(ensure)
      const found = yield* Effect.promise(() => readNamespace(ns))
      if (!found) return yield* new NotFoundError({ message: `No namespace "${ns}"` })
      return found
    })

    // Every project the server knows (git projects), and every project with project or agent settings.
    const known = Effect.fnUntraced(function* () {
      const rows = yield* db
        .select({ worktree: ProjectTable.worktree, name: ProjectTable.name })
        .from(ProjectTable)
        .all()
        .pipe(Effect.orDie)
      const settings = yield* Effect.promise(readProjects)
      const agents = yield* Effect.promise(readAgents)
      const names = new Map<string, string>(
        rows
          .filter((row) => row.worktree !== "/")
          .map((row) => [String(row.worktree), row.name || path.basename(row.worktree)]),
      )
      const keys = [...new Set([...names.keys(), ...Object.keys(settings), ...Object.keys(agents)])]
      return keys
        .map((key) => ({
          key,
          name: names.get(key) ?? path.basename(key),
          ...(settings[key] ?? { namespace: OperatorProfile.OPENCODE }),
          registered: names.has(key) || key in settings,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
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
      }
      return users.length ? users.join(", ") : undefined
    })

    const namespaces = Effect.fn("OperatorProfileStore.namespaces")(function* () {
      yield* Effect.promise(ensure)
      const ids = yield* Effect.promise(() => fs.readdir(root()).catch(() => [] as string[]))
      const records = yield* Effect.promise(() => Promise.all(ids.map(readNamespaceRecord)))
      const projects = yield* known()
      return records
        .filter((item): item is OperatorProfile.Namespace => item !== undefined)
        .toSorted((a, b) =>
          a.id === OperatorProfile.OPENCODE ? -1 : b.id === OperatorProfile.OPENCODE ? 1 : a.name.localeCompare(b.name),
        )
        .map((namespace) => ({
          namespace,
          projects: projects.filter((item) => item.namespace === namespace.id).map((item) => item.key),
        }))
    })

    // A new namespace is a copy of OpenCode: its own items are copied, built-ins stay shared.
    const createNamespace = Effect.fn("OperatorProfileStore.createNamespace")(function* (input: {
      name: string
      purpose?: string
    }) {
      yield* refuse(input.name.trim() ? undefined : "A namespace needs a name")
      const source = yield* load(OperatorProfile.OPENCODE)
      const id = yield* Effect.promise(() => freeId(root(), input.name, ""))
      const now = Date.now()
      const namespace: OperatorProfile.Namespace = {
        id,
        name: input.name.trim(),
        purpose: input.purpose ?? "",
        ...(source.namespace.defaultProfile ? { defaultProfile: source.namespace.defaultProfile } : {}),
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
      input: { name?: string; purpose?: string; defaultProfile?: string },
    ) {
      const catalog = yield* load(id)
      if (input.name !== undefined) yield* refuse(input.name.trim() ? undefined : "A namespace needs a name")
      if (input.defaultProfile && !OperatorProfile.profiles(catalog).some((item) => item.id === input.defaultProfile))
        yield* refuse(`No profile "${input.defaultProfile}" in ${catalog.namespace.name}`)
      const next = {
        ...catalog.namespace,
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.defaultProfile !== undefined ? { defaultProfile: input.defaultProfile || undefined } : {}),
        updatedAt: Date.now(),
      }
      yield* Effect.promise(() => writeNamespace(next))
      return next
    })

    const removeNamespace = Effect.fn("OperatorProfileStore.removeNamespace")(function* (id: string) {
      yield* refuse(id === OperatorProfile.OPENCODE ? "OpenCode is built in and cannot be deleted" : undefined)
      const catalog = yield* load(id)
      const projects = (yield* known()).filter((item) => item.namespace === id)
      yield* refuse(
        projects.length
          ? `${catalog.namespace.name} still has projects: ${projects.map((item) => item.name).join(", ")}`
          : undefined,
      )
      yield* Effect.promise(() => fs.rm(path.join(root(), id), { recursive: true, force: true }))
    })

    const catalog = Effect.fn("OperatorProfileStore.catalog")(function* (ns: string) {
      const found = yield* load(ns)
      const projects = (yield* known()).filter((item) => item.namespace === ns)
      const agents = yield* Effect.promise(readAgents)
      return {
        namespace: found.namespace,
        types: OperatorProfile.types(found),
        layers: [...OperatorProfile.BUILTIN_LAYERS, ...found.layers],
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
      input: { name: string; type: string; section?: OperatorProfile.Section; text: string },
    ) {
      const found = yield* load(ns)
      const before = yield* existing(found.layers, "layer", id)
      // A copy keeps its type and section; a layer's type changes only in Custom.
      const type = before?.replaces ? before.type : input.type
      const section = before?.section ?? input.section ?? sectionFor(type)
      yield* refuse(
        before && !before.replaces && before.type !== type && before.section !== "custom"
          ? "Only Custom layers can change type"
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
        text: input.text,
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
      const found = yield* load(ns)
      const original = OperatorProfile.findLayer(found, id)
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
        origin: "user",
      }
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
      yield* refuse(OperatorProfile.checkSlots(found, input))
      const group = OperatorProfile.groups(found).find((item) => item.id === input.group)!
      const next = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(root(), ns, "profiles"), input.name, ".json"))),
        name: input.name.trim(),
        group: input.group,
        // Only the group's types are kept, in its order.
        slots: Object.fromEntries(
          group.types.filter((type) => type !== "purpose").map((type) => [type, [...(input.slots[type] ?? [])]]),
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
      yield* Effect.promise(() => fs.rm(itemFile(ns, kind, id), { force: true }))
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
      yield* refuse(OperatorProfile.isBuiltin(id) ? "OpenCode's own items are in every namespace already" : undefined)
      return (yield* Effect.promise(() => copyItems(source, destination, [{ kind, id }], { kind, id }))).copied
    })

    const projects = Effect.fn("OperatorProfileStore.projects")(function* () {
      return yield* known()
    })

    const setProject = Effect.fn("OperatorProfileStore.setProject")(function* (
      key: string,
      input: { namespace?: string; purpose?: string; defaultProfile?: string; dryRun?: boolean },
    ) {
      const current: ProjectInfo = (yield* known()).find((item) => item.key === key) ?? {
        key,
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
      const next: OperatorProfile.ProjectSetting = {
        namespace: target,
        ...(purpose ? { purpose } : {}),
        ...(defaultProfile ? { defaultProfile } : {}),
      }
      if (input.dryRun) return { project: { ...current, ...next }, copied: moved.copied }
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
      yield* Effect.promise(async () => {
        const all = await readProjects()
        await writeJson(path.join(root(), "projects.json"), { ...all, [key]: next })
        if (!moving || !agents[key]) return
        const remapped = remapAgents(agents[key]!, map)
        await writeJson(path.join(root(), "agents.json"), { ...agents, [key]: remapped })
      })
      return { project: { ...current, ...next }, copied: moved.copied }
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
      setting: OperatorProfile.AgentSetting,
    ) {
      const context = yield* Effect.promise(() => forProject(project))
      const found = context.catalog
      if (setting.profile && !OperatorProfile.profiles(found).some((item) => item.id === setting.profile))
        yield* refuse(`No profile "${setting.profile}" in ${found.namespace.name}`)
      if (setting.override) {
        const chosen = OperatorProfile.profileFor(found, { agent: name, setting, project: context.project })
        const shape = OperatorProfile.effective(found, chosen.profile, setting.override)
        yield* refuse(OperatorProfile.checkSlots(found, { group: shape.group.id, slots: shape.slots }))
        if (
          setting.override.group &&
          !OperatorProfile.groups(found).some((item) => item.id === setting.override!.group)
        )
          yield* refuse(`No group "${setting.override.group}"`)
      }
      const next = {
        ...(setting.profile ? { profile: setting.profile } : {}),
        ...(setting.override && (setting.override.group || Object.keys(setting.override.slots ?? {}).length)
          ? { override: setting.override }
          : {}),
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
      const next: OperatorProfile.ProjectSetting = {
        namespace,
        ...(purpose ? { purpose } : {}),
        ...(defaultProfile ? { defaultProfile } : {}),
      }
      yield* Effect.promise(async () => {
        await writeJson(path.join(root(), "projects.json"), { ...(await readProjects()), [target]: next })
        if (Object.keys(own).length)
          await writeJson(path.join(root(), "agents.json"), { ...agents, [target]: remapAgents(own, map) })
      })
      return {
        project: { key: target, name: path.basename(target), ...next, registered: true },
        copied: moved.copied,
      }
    })

    return Service.of({
      copyProject,
      namespaces,
      createNamespace,
      updateNamespace,
      removeNamespace,
      catalog,
      saveType,
      saveLayer,
      copyBuiltin,
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

// The section a new layer of a type shows in.
function sectionFor(type: string): OperatorProfile.Section {
  if (type === "purpose") return "purpose"
  if (type === "role") return "role"
  if (type === "identity") return "identity"
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
    if (OperatorProfile.isBuiltin(ref.id)) return ref.id
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
        .map((layer) => ({ kind: "layer" as const, id: layer })),
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
                          slot[1].map((id) => map("layer", id)!),
                        ]),
                      ),
                    }
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

function itemFile(ns: string, kind: Kind, id: string) {
  return path.join(root(), ns, folders[kind], `${id}${extensions[kind]}`)
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
    }
    return write(file, matter.stringify(value.text.endsWith("\n") ? value.text : `${value.text}\n`, data))
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
      return {
        id: path.basename(file, ".md"),
        name: typeof data.name === "string" ? data.name : path.basename(file, ".md"),
        type: typeof data.type === "string" ? data.type : "identity",
        section: section._tag === "Some" ? section.value : "custom",
        ...(typeof data.replaces === "string" ? { replaces: data.replaces } : {}),
        text: parsed.content.replace(/\n$/, ""),
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

function agentSetting(value: Record<string, unknown> | undefined): OperatorProfile.AgentSetting {
  const override = value?.override as Record<string, unknown> | undefined
  return {
    ...(typeof value?.profile === "string" ? { profile: value.profile } : {}),
    ...(override
      ? {
          override: {
            ...(typeof override.group === "string" ? { group: override.group } : {}),
            ...(override.slots ? { slots: slotsOf(override.slots) } : {}),
          },
        }
      : {}),
  }
}
