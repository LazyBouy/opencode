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

// Prompt profile resources are server-wide files in the global config folder:
//
//   profile/layers/<id>.md      frontmatter: the layer's fields; body: its text
//   profile/groups/<id>.json    { name, type, projects, layers }
//   profile/profiles/<id>.json  { name, projects, groups }
//   profile/defaults.json       { global?, projects: { <project>: profileId } }
//
// Files from before profiles are read in place and written back to the same file; they are never
// moved or deleted: prompts/<id>.md overrides (global: all projects; <project>/.opencode/prompts:
// that project) and identity/*.md layers (likewise).

export const ProjectInfo = Schema.Struct({
  key: Schema.String.annotate({ description: '"opencode", or the project folder' }),
  name: Schema.String,
}).annotate({ identifier: "OperatorPromptProject" })

export const CatalogInfo = Schema.Struct({
  layers: Schema.Array(OperatorProfile.Layer),
  groups: Schema.Array(OperatorProfile.PromptGroup),
  profiles: Schema.Array(OperatorProfile.Profile),
  defaults: OperatorProfile.Defaults,
  projects: Schema.Array(ProjectInfo).annotate({ description: "OpenCode first, then every project the server knows" }),
}).annotate({ identifier: "OperatorPromptProfileCatalog" })
export type CatalogInfo = typeof CatalogInfo.Type

// What a layer save may set. Not named in the API document, so the client takes flat parameters.
export const LayerInput = Schema.Struct({
  name: Schema.String,
  section: OperatorProfile.Section,
  purpose: Schema.optional(Schema.Literals(["org", "goal"])),
  overrides: Schema.optional(Schema.String),
  projects: OperatorProfile.Projects,
  agents: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Finite),
  maxLength: Schema.optional(Schema.Finite),
  enabled: Schema.optional(Schema.Boolean),
  text: Schema.String,
})
export type LayerInput = typeof LayerInput.Type

export const GroupInput = Schema.Struct({
  name: Schema.String,
  type: OperatorProfile.GroupType,
  projects: OperatorProfile.Projects,
  layers: Schema.Array(Schema.String),
})
export type GroupInput = typeof GroupInput.Type

export const ProfileInput = Schema.Struct({
  name: Schema.String,
  projects: OperatorProfile.Projects,
  groups: Schema.Array(Schema.String),
})
export type ProfileInput = typeof ProfileInput.Type

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorProfileInvalid", {
  message: Schema.String,
}) {}
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorProfileNotFound", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly catalog: () => Effect.Effect<CatalogInfo>
  readonly saveLayer: (
    id: string | undefined,
    input: LayerInput,
  ) => Effect.Effect<OperatorProfile.Layer, InvalidError | NotFoundError>
  readonly removeLayer: (id: string) => Effect.Effect<void, InvalidError | NotFoundError>
  readonly saveGroup: (
    id: string | undefined,
    input: GroupInput,
  ) => Effect.Effect<OperatorProfile.PromptGroup, InvalidError | NotFoundError>
  readonly removeGroup: (id: string) => Effect.Effect<void, InvalidError | NotFoundError>
  readonly saveProfile: (
    id: string | undefined,
    input: ProfileInput,
  ) => Effect.Effect<OperatorProfile.Profile, InvalidError | NotFoundError>
  readonly removeProfile: (id: string) => Effect.Effect<void, InvalidError | NotFoundError>
  readonly saveDefaults: (defaults: OperatorProfile.Defaults) => Effect.Effect<OperatorProfile.Defaults, InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorProfileStore") {}

export function folder() {
  return path.join(Global.Path.config, "profile")
}

// The stored layers, groups, profiles and defaults, with the old files of the given projects. Built-in
// resources are not included; OperatorProfile adds them where it needs them.
export async function read(projects: ReadonlyArray<{ key: string; root: string }>): Promise<OperatorProfile.Catalog> {
  const dir = folder()
  const projectDirs = projects
    .map((project) => ({ key: project.key, dir: path.join(project.root, ".opencode") }))
    .filter((project) => project.dir !== Global.Path.config)
  const [stored, groups, profiles, defaults, legacy] = await Promise.all([
    readLayers(path.join(dir, "layers")),
    readJson(path.join(dir, "groups"), (id, data) => toGroup(id, data)),
    readJson(path.join(dir, "profiles"), (id, data) => toProfile(id, data)),
    Bun.file(path.join(dir, "defaults.json"))
      .json()
      .then(toDefaults)
      .catch(() => ({ projects: {} })),
    Promise.all([
      readOldFiles(Global.Path.config, "*"),
      ...projectDirs.map((project) => readOldFiles(project.dir, [project.key])),
    ]),
  ])
  return { layers: [...stored, ...legacy.flat()], groups, profiles, defaults }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const projects = Effect.fnUntraced(function* () {
      const rows = yield* db
        .select({ worktree: ProjectTable.worktree, name: ProjectTable.name })
        .from(ProjectTable)
        .all()
        .pipe(Effect.orDie)
      return rows
        .filter((row) => row.worktree !== "/")
        .map((row) => ({ key: row.worktree, name: row.name || path.basename(row.worktree) }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const load = Effect.fnUntraced(function* () {
      const known = yield* projects()
      return {
        known,
        catalog: yield* Effect.promise(() => read(known.map((project) => ({ key: project.key, root: project.key })))),
      }
    })

    const catalog = Effect.fn("OperatorProfileStore.catalog")(function* () {
      const loaded = yield* load()
      return {
        layers: [...OperatorProfile.BUILTIN_LAYERS, ...loaded.catalog.layers],
        groups: [...OperatorProfile.BUILTIN_GROUPS, ...loaded.catalog.groups],
        profiles: [...OperatorProfile.BUILTIN_PROFILES, ...loaded.catalog.profiles],
        defaults: loaded.catalog.defaults,
        projects: [{ key: OperatorProfile.OPENCODE, name: "OpenCode" }, ...loaded.known],
      }
    })

    const refuse = (message: string | undefined) => (message ? Effect.fail(new InvalidError({ message })) : Effect.void)

    const saveLayer = Effect.fn("OperatorProfileStore.saveLayer")(function* (
      id: string | undefined,
      input: LayerInput,
    ) {
      const current = (yield* load()).catalog
      const existing = id ? current.layers.find((item) => item.id === id) : undefined
      if (id && !existing) {
        if (OperatorProfile.findLayer(current, id))
          yield* refuse("OpenCode's own layers cannot be changed; override the text instead")
        return yield* new NotFoundError({ message: `No layer "${id}"` })
      }
      if (existing?.origin === "file" && JSON.stringify(existing.projects) !== JSON.stringify(input.projects))
        yield* refuse(`This layer is the file ${existing.path}; its scope is where the file is`)
      if (existing?.origin === "file" && existing.overrides !== input.overrides)
        yield* refuse(`This layer is the file ${existing.path}; it always replaces ${existing.overrides ?? "nothing"}`)
      const next: OperatorProfile.Layer = {
        id: existing?.id ?? (yield* Effect.promise(() => freeId(path.join(folder(), "layers"), input.name, ".md"))),
        name: input.name.trim(),
        section: input.section,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.overrides ? { overrides: input.overrides } : {}),
        projects: input.projects,
        ...(input.agents?.length ? { agents: [...input.agents] } : {}),
        priority: input.priority ?? existing?.priority ?? 50,
        ...(input.maxLength ? { maxLength: input.maxLength } : {}),
        enabled: input.enabled ?? existing?.enabled ?? true,
        text: input.text,
        origin: existing?.origin ?? "profile",
        ...(existing?.path ? { path: existing.path } : {}),
      }
      yield* refuse(OperatorProfile.checkLayer(current, next))
      yield* Effect.promise(() => writeLayer(next))
      return next
    })

    const removeLayer = Effect.fn("OperatorProfileStore.removeLayer")(function* (id: string) {
      const current = (yield* load()).catalog
      const existing = current.layers.find((item) => item.id === id)
      if (!existing) return yield* new NotFoundError({ message: `No layer "${id}"` })
      if (existing.origin === "file")
        yield* refuse(`This layer is the file ${existing.path}; turn it off here, or delete the file yourself`)
      const user = current.groups.find((item) => item.layers.includes(id))
      if (user) yield* refuse(`The group "${user.name}" uses this layer; take it out first`)
      yield* Effect.promise(() => fs.rm(path.join(folder(), "layers", `${id}.md`), { force: true }))
    })

    const saveGroup = Effect.fn("OperatorProfileStore.saveGroup")(function* (
      id: string | undefined,
      input: GroupInput,
    ) {
      const current = (yield* load()).catalog
      if (id && OperatorProfile.BUILTIN_GROUPS.some((item) => item.id === id))
        yield* refuse("Built-in groups cannot be changed; make your own group")
      if (id && !current.groups.some((item) => item.id === id))
        return yield* new NotFoundError({ message: `No group "${id}"` })
      const next: OperatorProfile.PromptGroup = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(folder(), "groups"), input.name, ".json"))),
        name: input.name.trim(),
        type: input.type,
        projects: input.projects,
        layers: [...input.layers],
        builtin: false,
      }
      yield* refuse(OperatorProfile.checkGroup(current, next))
      const after = { ...current, groups: [...current.groups.filter((item) => item.id !== next.id), next] }
      const broken = current.profiles.find(
        (item) => item.groups.includes(next.id) && OperatorProfile.checkProfile(after, item),
      )
      if (broken)
        yield* refuse(`The profile "${broken.name}" uses this group: ${OperatorProfile.checkProfile(after, broken)}`)
      yield* Effect.promise(() =>
        writeJson(path.join(folder(), "groups", `${next.id}.json`), {
          name: next.name,
          type: next.type,
          projects: next.projects,
          layers: next.layers,
        }),
      )
      return next
    })

    const removeGroup = Effect.fn("OperatorProfileStore.removeGroup")(function* (id: string) {
      const current = (yield* load()).catalog
      if (!current.groups.some((item) => item.id === id))
        return yield* new NotFoundError({ message: `No group "${id}"` })
      const user = current.profiles.find((item) => item.groups.includes(id))
      if (user) yield* refuse(`The profile "${user.name}" uses this group; take it out first`)
      yield* Effect.promise(() => fs.rm(path.join(folder(), "groups", `${id}.json`), { force: true }))
    })

    const saveProfile = Effect.fn("OperatorProfileStore.saveProfile")(function* (
      id: string | undefined,
      input: ProfileInput,
    ) {
      const current = (yield* load()).catalog
      if (id && OperatorProfile.BUILTIN_PROFILES.some((item) => item.id === id))
        yield* refuse("Built-in profiles cannot be changed; duplicate one instead")
      if (id && !current.profiles.some((item) => item.id === id))
        return yield* new NotFoundError({ message: `No profile "${id}"` })
      const next: OperatorProfile.Profile = {
        id: id ?? (yield* Effect.promise(() => freeId(path.join(folder(), "profiles"), input.name, ".json"))),
        name: input.name.trim(),
        projects: input.projects,
        groups: [...input.groups],
        builtin: false,
      }
      yield* refuse(OperatorProfile.checkProfile(current, next))
      yield* refuse(
        OperatorProfile.checkDefaults(
          { ...current, profiles: [...current.profiles.filter((item) => item.id !== next.id), next] },
          current.defaults,
        ),
      )
      yield* Effect.promise(() =>
        writeJson(path.join(folder(), "profiles", `${next.id}.json`), {
          name: next.name,
          projects: next.projects,
          groups: next.groups,
        }),
      )
      return next
    })

    const removeProfile = Effect.fn("OperatorProfileStore.removeProfile")(function* (id: string) {
      const current = (yield* load()).catalog
      if (!current.profiles.some((item) => item.id === id))
        return yield* new NotFoundError({ message: `No profile "${id}"` })
      if (current.defaults.global === id || Object.values(current.defaults.projects).includes(id))
        yield* refuse("This profile is a default; choose another default first")
      yield* Effect.promise(() => fs.rm(path.join(folder(), "profiles", `${id}.json`), { force: true }))
    })

    const saveDefaults = Effect.fn("OperatorProfileStore.saveDefaults")(function* (defaults: OperatorProfile.Defaults) {
      const current = (yield* load()).catalog
      yield* refuse(OperatorProfile.checkDefaults(current, defaults))
      const next = { ...(defaults.global ? { global: defaults.global } : {}), projects: { ...defaults.projects } }
      yield* Effect.promise(() => writeJson(path.join(folder(), "defaults.json"), next))
      return next
    })

    return Service.of({
      catalog,
      saveLayer,
      removeLayer,
      saveGroup,
      removeGroup,
      saveProfile,
      removeProfile,
      saveDefaults,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

async function readLayers(dir: string) {
  const files = await Glob.scan("*.md", { cwd: dir, absolute: true, dot: false, symlink: true }).catch(() => [])
  const layers = await Promise.all(
    files.map(async (file): Promise<OperatorProfile.Layer | undefined> => {
      const parsed = await Bun.file(file)
        .text()
        .then((text) => matter(text))
        .catch(() => undefined)
      if (!parsed) return undefined
      const data = parsed.data as Record<string, unknown>
      const section = Schema.decodeUnknownOption(OperatorProfile.Section)(data.section)
      if (section._tag === "None") return undefined
      const purpose = data.purpose === "org" || data.purpose === "goal" ? data.purpose : undefined
      return {
        id: path.basename(file, ".md"),
        name: typeof data.name === "string" ? data.name : path.basename(file, ".md"),
        section: section.value,
        ...(purpose ? { purpose } : {}),
        ...(typeof data.overrides === "string" ? { overrides: data.overrides } : {}),
        projects: toProjects(data.projects),
        ...agentsField(data.agents),
        priority: typeof data.priority === "number" ? data.priority : 50,
        ...maxLengthField(data.max_length),
        enabled: data.enabled !== false,
        text: parsed.content.replace(/\n$/, ""),
        origin: "profile",
      }
    }),
  )
  return layers.filter((item) => item !== undefined)
}

// prompts/<id>.md overrides and identity/*.md layers in one config folder.
async function readOldFiles(dir: string, projects: OperatorProfile.Projects) {
  const prompts = await Glob.scan("*.md", { cwd: path.join(dir, "prompts"), absolute: true, symlink: true }).catch(
    () => [] as string[],
  )
  const identity = await Glob.scan("*.md", { cwd: path.join(dir, "identity"), absolute: true, symlink: true }).catch(
    () => [] as string[],
  )
  const overrides = await Promise.all(
    prompts
      .filter((file) => OperatorProfile.isBuiltinText(path.basename(file, ".md")))
      .map(async (file) => {
        const id = path.basename(file, ".md")
        return {
          id: fileId(file),
          name: id,
          section: OperatorProfile.sectionOf(id),
          overrides: id,
          projects,
          priority: 50,
          enabled: true,
          text: (await Bun.file(file).text()).trim(),
          origin: "file" as const,
          path: file,
        } satisfies OperatorProfile.Layer
      }),
  )
  const layers = await Promise.all(
    identity.map(async (file) => {
      const parsed = matter(await Bun.file(file).text())
      const data = parsed.data as Record<string, unknown>
      return {
        id: fileId(file),
        name: typeof data.name === "string" ? data.name : path.basename(file, ".md"),
        section: "identity" as const,
        projects,
        ...agentsField(data.agents),
        priority: typeof data.priority === "number" ? data.priority : 50,
        ...maxLengthField(data.max_length),
        enabled: data.enabled !== false,
        text: parsed.content.trim(),
        origin: "file" as const,
        path: file,
      } satisfies OperatorProfile.Layer
    }),
  )
  return [...overrides, ...layers]
}

async function readJson<T>(
  dir: string,
  decode: (id: string, data: Record<string, unknown>) => T | undefined,
): Promise<T[]> {
  const files = await Glob.scan("*.json", { cwd: dir, absolute: true, symlink: true }).catch(() => [] as string[])
  const items = await Promise.all(
    files.map(
      (file): Promise<T | undefined> =>
        Bun.file(file)
          .json()
          .then((data: unknown) =>
            data && typeof data === "object"
              ? decode(path.basename(file, ".json"), data as Record<string, unknown>)
              : undefined,
          )
          .catch(() => undefined),
    ),
  )
  return items.filter((item) => item !== undefined)
}

function toGroup(id: string, data: Record<string, unknown>): OperatorProfile.PromptGroup | undefined {
  const type = Schema.decodeUnknownOption(OperatorProfile.GroupType)(data.type)
  if (type._tag === "None") return undefined
  return {
    id,
    name: typeof data.name === "string" ? data.name : id,
    type: type.value,
    projects: toProjects(data.projects),
    layers: strings(data.layers),
    builtin: false,
  }
}

function toProfile(id: string, data: Record<string, unknown>): OperatorProfile.Profile {
  return {
    id,
    name: typeof data.name === "string" ? data.name : id,
    projects: toProjects(data.projects),
    groups: strings(data.groups),
    builtin: false,
  }
}

function toDefaults(data: unknown): OperatorProfile.Defaults {
  const value = (data && typeof data === "object" ? data : {}) as Record<string, unknown>
  const projects = value.projects && typeof value.projects === "object" ? value.projects : {}
  return {
    ...(typeof value.global === "string" ? { global: value.global } : {}),
    projects: Object.fromEntries(
      Object.entries(projects).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    ),
  }
}

async function writeLayer(layer: OperatorProfile.Layer) {
  if (layer.origin === "file" && layer.path && layer.section !== "identity") return write(layer.path, `${layer.text}\n`)
  if (layer.origin === "file" && layer.path) {
    // Keep the old file's other keys (such as `layer: org`) as they were.
    const before = matter(await Bun.file(layer.path).text()).data as Record<string, unknown>
    const data: Record<string, unknown> = {
      ...without(before, ["name", "priority", "agents", "max_length", "enabled"]),
      name: layer.name,
      priority: layer.priority,
      ...(layer.agents?.length ? { agents: [...layer.agents] } : {}),
      ...(layer.maxLength ? { max_length: layer.maxLength } : {}),
      ...(layer.enabled ? {} : { enabled: false }),
    }
    return write(layer.path, matter.stringify(`${layer.text.trim()}\n`, data))
  }
  const data = {
    name: layer.name,
    section: layer.section,
    ...(layer.purpose ? { purpose: layer.purpose } : {}),
    ...(layer.overrides ? { overrides: layer.overrides } : {}),
    projects: layer.projects,
    ...(layer.agents?.length ? { agents: [...layer.agents] } : {}),
    priority: layer.priority,
    ...(layer.maxLength ? { max_length: layer.maxLength } : {}),
    enabled: layer.enabled,
  }
  return write(path.join(folder(), "layers", `${layer.id}.md`), matter.stringify(`${layer.text}\n`, data))
}

async function writeJson(file: string, data: unknown) {
  return write(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
}

// An id made from the name that no file in `dir` uses yet.
async function freeId(dir: string, name: string, ext: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item"
  // Ids of built-in resources and old files are kept free.
  const taken = (id: string) =>
    id === "default" ||
    id === "helper" ||
    id.startsWith("builtin.") ||
    id.startsWith("file-") ||
    Bun.file(path.join(dir, `${id}${ext}`)).exists()
  const next = async (index: number): Promise<string> => {
    const id = index === 1 ? base : `${base}-${index}`
    return (await taken(id)) ? next(index + 1) : id
  }
  return next(1)
}

// Old files get an id from their path, so the same file keeps its id.
function fileId(file: string) {
  return `file-${Bun.hash(file).toString(36)}`
}

function toProjects(value: unknown): OperatorProfile.Projects {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  return "*"
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function agentsField(value: unknown) {
  const agents = strings(value)
  return agents.length ? { agents } : {}
}

function maxLengthField(value: unknown) {
  return typeof value === "number" && value > 0 ? { maxLength: value } : {}
}

function without(data: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(data).filter((pair) => !keys.includes(pair[0])))
}
