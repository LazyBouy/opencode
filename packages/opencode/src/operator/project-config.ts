export * as OperatorProjectConfig from "./project-config"

import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Context, Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorLayout } from "./layout"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorPermissionMarks } from "./permission-marks"

// A project's config (global_and_opencode_namespaces_spec.md §6, §7): its own config file if it has one,
// else its namespace's. A project page never writes a namespace's or Global's config: the first change
// saved from a project page that has no config of its own copies the namespace's config into
// `<project>/.opencode/opencode.jsonc`, with the change applied ("copy-on-write"). From then on the
// project uses only its own file (namespace-scope.ts skips the namespace's), so later changes to the
// namespace's config don't reach it.
// - Lines the namespace locks are never copied: they stay in its file and keep applying from there
//   (permission-live.ts). The namespace's deletions are copied as the project's.
// - The copy is recorded (`project-config-copies.json`), with the namespace file's hash, for "Copied from
//   Acme on …" and "Acme's config has changed since".
// - Making the copy needs consent: a write without it fails with CopyNeededError, which the app turns into
//   the "Save as this project's own config?" question. Handlers give consent with `consent(confirmCopy)`.
// Every write into a project's config file goes through OperatorConfig's project scope, which uses this.

export class CopyNeededError extends Schema.TaggedErrorClass<CopyNeededError>()("OperatorProjectConfigCopyNeeded", {
  project: Schema.String,
  namespace: Schema.String,
  file: Schema.String,
  message: Schema.String,
}) {}

/** Whether the caller agreed to give the project its own copy of its namespace's config. */
export const Consent = Context.Reference<boolean>("~opencode/OperatorProjectConfigConsent", {
  defaultValue: () => false,
})
export const consent =
  (confirm: boolean | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Consent, confirm === true)

export type Copy = {
  namespace: string
  copiedAt: number
  /** The namespace file's content hash when copied: it powers "has changed since". */
  namespaceHash: string
  file: string
  /** The namespace's deletions copied as the project's, taken back with the copy. */
  deleted?: ReadonlyArray<OperatorPermissionMarks.Key>
}

const store = () => path.join(Global.Path.config, "namespaces")
const copiesFile = () => path.join(store(), "project-config-copies.json")
const readJson = (file: string): Promise<Record<string, unknown>> =>
  fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .then((data) => (data && typeof data === "object" ? (data as Record<string, unknown>) : {}))
    .catch(() => ({}))
const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
const readText = (file: string) => fs.readFile(file, "utf8").catch(() => undefined)

export const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

let queue: Promise<unknown> = Promise.resolve()
const serial = <A>(work: () => Promise<A>) => {
  const next = queue.then(work)
  queue = next.catch(() => undefined)
  return next
}

/** The copy records whose file still exists (a record without its file is removed). */
export function copies(): Promise<Record<string, Copy>> {
  return serial(async () => {
    const data = await readJson(copiesFile())
    const kept: Record<string, Copy> = {}
    for (const [project, value] of Object.entries(data)) {
      const record = value as Copy
      if (record && typeof record.file === "string" && (await exists(record.file))) kept[project] = record
    }
    if (Object.keys(kept).length !== Object.keys(data).length) await writeCopies(kept)
    return kept
  })
}

const writeCopies = async (data: Record<string, Copy>) => {
  await fs.mkdir(store(), { recursive: true })
  await fs.writeFile(copiesFile(), JSON.stringify(data, null, 2) + "\n")
}

export async function copyOf(project: string) {
  return (await copies())[project]
}

export function recordCopy(project: string, copy: Copy) {
  return serial(async () => writeCopies({ ...(await readJson(copiesFile())), [project]: copy } as never))
}

export function removeCopy(project: string) {
  return serial(async () => {
    const data = await readJson(copiesFile())
    if (!(project in data)) return
    delete data[project]
    await writeCopies(data as never)
  })
}

const recordName = async (id: string) => {
  const record = await readJson(path.join(store(), id, "namespace.json"))
  return typeof record.name === "string" && record.name ? record.name : id
}

export type NamespaceConfig = {
  id: string
  name: string
  /** Global (or "Global · OpenCode"): its config is Global's own file, the base under every namespace. */
  global: boolean
  /** The file its config page edits: Global's own file, else `<folder>/.opencode/opencode.json(c)`. */
  file: string
  /** The file's text; absent when the namespace has no config yet. */
  text?: string
}

/** A namespace's config file and text (`global` for Global). */
export async function namespaceConfig(namespace: string): Promise<NamespaceConfig> {
  const layout = await OperatorLayout.snapshot()
  const id = OperatorLayout.resolveId(namespace, layout)
  const place = OperatorLayout.placeOf(id, layout)
  const name = await recordName(id)
  if (!place || place.global) {
    const file = await OperatorLayout.globalConfigFile()
    return { id, name, global: true, file, text: await readText(file) }
  }
  const found = await OperatorNamespaceScope.ownConfigFiles(place.configDir, ["opencode.jsonc", "opencode.json"])
  const file = found[0] ?? path.join(place.configDir, "opencode.jsonc")
  return { id, name, global: false, file, text: await readText(file) }
}

/** The text a project's editor starts from when its namespace has no config yet. */
export const emptyText = (name: string) =>
  `// ${name} has no config yet. Saving here creates this project's own config.\n{}\n`

/** The namespace's lines it locks, left out of a copy: they keep applying from the namespace's file. */
export function withoutLocked(text: string, locks: ReadonlyArray<OperatorPermissionMarks.Key>) {
  const value = parse(text) as { permission?: unknown } | undefined
  const permission = value?.permission
  if (!locks.length || !permission || typeof permission !== "object") return text
  const locked = (name: string, pattern: string) =>
    locks.some((key) => key.permission === name && key.pattern === pattern)
  const edits = Object.entries(permission as Record<string, unknown>).flatMap(([name, rule]) => {
    if (typeof rule === "string") return locked(name, "*") ? [["permission", name]] : []
    if (!rule || typeof rule !== "object") return []
    const patterns = Object.keys(rule)
    const gone = patterns.filter((pattern) => locked(name, pattern))
    if (gone.length && gone.length === patterns.length) return [["permission", name]]
    return gone.map((pattern) => ["permission", name, pattern])
  })
  return edits.reduce(
    (result, at) =>
      applyEdits(result, modify(result, at, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    text,
  )
}

/**
 * A copy leaves out the namespace's locked hooks (SPEC-0022 §6.3): they keep running from its file. From
 * Global (`all`), it leaves out every hook: Global's level keeps running them for the project anyway.
 */
export function withoutLockedHooks(text: string, all = false) {
  const value = parse(text) as { hooks?: unknown } | undefined
  const hooks = value?.hooks
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return text
  const gone = Object.entries(hooks as Record<string, unknown>)
    .filter(
      ([, entry]) => all || (!!entry && typeof entry === "object" && (entry as { locked?: unknown }).locked === true),
    )
    .map(([name]) => name)
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  if (gone.length && gone.length === Object.keys(hooks).length)
    return applyEdits(text, modify(text, ["hooks"], undefined, options))
  return gone.reduce((result, name) => applyEdits(result, modify(result, ["hooks", name], undefined, options)), text)
}

/**
 * A copy leaves out the namespace's default and small model (default_models_spec.md §6.3): the project keeps
 * following them (namespace-scope.ts configFiles) until it sets its own. With `all` false, only a key whose
 * value is still the namespace's (`from`) goes: a whole text saved from the Config page keeps a model the
 * user changed there.
 */
export function withoutModels(text: string, from: OperatorNamespaceScope.ModelKeys = {}, all = true) {
  const value = parse(text) as Record<string, unknown> | undefined
  if (!value || typeof value !== "object") return text
  return OperatorNamespaceScope.MODEL_KEYS.filter(
    (key) => key in value && (all || (from[key] !== undefined && value[key] === from[key])),
  ).reduce(
    (result, key) =>
      applyEdits(result, modify(result, [key], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    text,
  )
}

export type Prepared = {
  project: string
  /** The file the write goes to: the project's own config, or where its copy will be. */
  file: string
  /** Its text now: the own file's, or the namespace's (without its locked lines) for a copy. */
  text: string
  own: boolean
  copy?: {
    namespace: string
    namespaceHash: string
    locks: ReadonlyArray<OperatorPermissionMarks.Key>
    /** The namespace's default and small model, left out of the copy. */
    models: OperatorNamespaceScope.ModelKeys
  }
}

/** Where a write into the project's config goes, and the text it changes (§7.3). */
export const prepare = Effect.fnUntraced(function* (ctx: { directory: string; worktree: string }) {
  const layer = yield* Effect.promise(() => OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree))
  const project = layer.project
  const own = yield* Effect.promise(() => OperatorNamespaceScope.ownConfigFiles(project))
  if (own.length) {
    const file = own[0]!
    return { project, file, text: (yield* Effect.promise(() => readText(file))) ?? "", own: true } satisfies Prepared
  }
  const source = yield* Effect.promise(() => namespaceConfig(layer.namespace))
  const file = path.join(project, OperatorNamespaceScope.OWN_CONFIG_FILES[0]!)
  if (!(yield* Consent))
    return yield* new CopyNeededError({
      project,
      namespace: source.id,
      file,
      message: `This project uses ${source.name}'s config. Saving here gives it its own copy at ${file}; ${source.name}'s config isn't changed.`,
    })
  const locks = source.global
    ? []
    : (yield* Effect.promise(() => OperatorPermissionMarks.namespaceMarks(source.id))).locks
  const value = parse(source.text ?? "{}") as Record<string, unknown> | undefined
  const models = Object.fromEntries(
    OperatorNamespaceScope.MODEL_KEYS.flatMap((key) => (typeof value?.[key] === "string" ? [[key, value[key]]] : [])),
  ) as OperatorNamespaceScope.ModelKeys
  return {
    project,
    file,
    // The editor shows `emptyText` for a namespace without a config; a copy of none starts empty. The copy
    // has neither the namespace's locked lines nor its default and small model.
    text: withoutModels(withoutLockedHooks(withoutLocked(source.text ?? "{}\n", locks), source.global)),
    own: false,
    copy: { namespace: source.id, namespaceHash: hash(source.text ?? ""), locks, models },
  } satisfies Prepared
})

/**
 * After a copy was written: records it, and copies the namespace's deletions as the project's (a Global
 * project keeps Global's: Global stays its base).
 */
export async function finish(prepared: Prepared, written: string) {
  if (!prepared.copy) return
  const { namespace } = prepared.copy
  const source = await namespaceConfig(namespace)
  const marks = source.global ? OperatorPermissionMarks.EMPTY : await OperatorPermissionMarks.namespaceMarks(namespace)
  const current = await OperatorPermissionMarks.projectMarks(prepared.project)
  const same = (a: OperatorPermissionMarks.Key, b: OperatorPermissionMarks.Key) =>
    a.permission === b.permission && a.pattern === b.pattern
  const added = marks.deleted.filter((key) => !current.deleted.some((item) => same(item, key)))
  if (added.length)
    await OperatorPermissionMarks.writeProject(prepared.project, {
      ...current,
      deleted: [...current.deleted, ...added],
    })
  await recordCopy(prepared.project, {
    namespace,
    copiedAt: Date.now(),
    namespaceHash: prepared.copy.namespaceHash,
    file: written,
    ...(added.length ? { deleted: added } : {}),
  })
}

/** Takes back what a copy added to the project's marks (the copied deletions). */
export async function takeBack(project: string, copy: Copy | undefined) {
  if (!copy?.deleted?.length) return
  const current = await OperatorPermissionMarks.projectMarks(project)
  await OperatorPermissionMarks.writeProject(project, {
    ...current,
    deleted: current.deleted.filter(
      (key) => !copy.deleted!.some((item) => item.permission === key.permission && item.pattern === key.pattern),
    ),
  })
}

/** Gives back what `takeBack` took, when the project's config comes back from Trash. */
export async function giveBack(project: string, copy: Copy) {
  const current = await OperatorPermissionMarks.projectMarks(project)
  const missing = (copy.deleted ?? []).filter(
    (key) => !current.deleted.some((item) => item.permission === key.permission && item.pattern === key.pattern),
  )
  if (missing.length)
    await OperatorPermissionMarks.writeProject(project, { ...current, deleted: [...current.deleted, ...missing] })
  await recordCopy(project, copy)
}

/** Whether git tracks the file: a tracked own config is edited but never removed by the console. */
export async function tracked(file: string) {
  const child = Bun.spawn(["git", "ls-files", "--error-unmatch", path.basename(file)], {
    cwd: path.dirname(file),
    stdout: "ignore",
    stderr: "ignore",
  })
  return (await child.exited) === 0
}

// Config files below the project folder apply only to sessions in those subfolders (§7.1); listed, not
// edited. A bounded walk: dependencies, build output and dot folders (but `.opencode`) are skipped.
const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", ".git"])
export async function subfolderFiles(project: string, depth = 4): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth || found.length >= 50) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue
      if (entry.name.startsWith(".") && entry.name !== ".opencode") continue
      const child = path.join(dir, entry.name)
      if (level > 0 || entry.name !== ".opencode") {
        for (const name of ["opencode.jsonc", "opencode.json"]) {
          const file = path.join(child, name)
          if (await exists(file)) found.push(file)
        }
      }
      if (entry.name !== ".opencode") await walk(child, level + 1)
    }
  }
  await walk(project, 0)
  return found.toSorted()
}

export type Resolved = {
  mode: "own" | "namespace"
  project: string
  /** The file the project uses: its own config, else its namespace's. */
  file: string
  /** That file's text (`emptyText` when the namespace has no config yet). */
  text: string
  namespace: Omit<NamespaceConfig, "text"> & { exists: boolean }
  /** The copy record, when the console made the project's config. */
  copy?: { namespace: string; name: string; copiedAt: number; changedSince: boolean }
  /** Every own config file, in the order upstream merges them (more than one gets a warning). */
  ownFiles: string[]
  /** The own file is tracked by git: it is edited, never removed. */
  tracked: boolean
  /** Where a copy goes. */
  target: string
}

/** The config a project uses (§7.2): its own, else its namespace's. */
export async function resolved(ctx: { directory: string; worktree: string }): Promise<Resolved> {
  const layer = await OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree)
  const project = layer.project
  const own = await OperatorNamespaceScope.ownConfigFiles(project)
  const { text: namespaceText, ...source } = await namespaceConfig(layer.namespace)
  const namespace = { ...source, exists: namespaceText !== undefined }
  const target = path.join(project, OperatorNamespaceScope.OWN_CONFIG_FILES[0]!)
  if (!own.length)
    return {
      mode: "namespace",
      project,
      file: source.file,
      text: namespaceText ?? emptyText(source.name),
      namespace,
      ownFiles: [],
      tracked: false,
      target,
    }
  const file = own[0]!
  const record = await copyOf(project)
  const from = record ? await namespaceConfig(record.namespace) : undefined
  return {
    mode: "own",
    project,
    file,
    text: (await readText(file)) ?? "",
    namespace,
    ...(record && from
      ? {
          copy: {
            namespace: from.id,
            name: from.name,
            copiedAt: record.copiedAt,
            changedSince: hash(from.text ?? "") !== record.namespaceHash,
          },
        }
      : {}),
    ownFiles: await OperatorNamespaceScope.ownConfigFiles(project, OperatorNamespaceScope.MERGE_ORDER),
    tracked: await tracked(file),
    target,
  }
}
