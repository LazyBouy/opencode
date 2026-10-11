export * as OperatorMemoryFolders from "./memory-folders"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "./file-cache"
import { OperatorLayout } from "./layout"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"

// Where short-term memory lives (specs/docs/feedbacks/memory/memory_spec.md §2): a `.memory` folder per
// level. The namespace's is in its folder (Global's in the global config folder), the project's at its
// root, an agent's in its home, or for an agent without a home in `<project>/.memory/agents/<name>/`.
// `.memory` folders stay out of git by default: the repository's `.git/info/exclude` gets a `.memory/`
// line (its `.gitignore` is never edited), taken out again when committing is switched on.

export const FOLDER = ".memory"
export const LEVELS = ["namespace", "project", "agent"] as const
export type Level = (typeof LEVELS)[number]

export type Folders = {
  readonly namespace: { readonly id: string; readonly folder: string }
  readonly project: string
  readonly agent?: string
}

/** An agent's own `.memory` folder: in its home, else under the project's `.memory/agents/`. */
export function agentFolder(project: string, agent: { name: string; home?: string }) {
  return agent.home
    ? path.join(path.resolve(project, agent.home), FOLDER)
    : path.join(project, FOLDER, "agents", agent.name)
}

/** The three `.memory` folders of an agent of a project (the agent's when one is given). */
export async function of(input: { project: string; agent?: { name: string; home?: string } }): Promise<Folders> {
  const layout = await OperatorLayout.snapshot()
  const projects = await OperatorProfileStore.readProjects()
  const member = OperatorLayout.membership(input.project, layout, projects[input.project]?.namespace)
  const place = OperatorLayout.placeOf(member.namespace, layout)
  return {
    namespace: { id: member.namespace, folder: path.join(place?.folder ?? Global.Path.config, FOLDER) },
    project: path.join(input.project, FOLDER),
    ...(input.agent ? { agent: agentFolder(input.project, input.agent) } : {}),
  }
}

// ---- Settings (Memory → Settings): committing .memory folders, and the index limits in prompts ----
// Per namespace: OpenCode's are the default every other namespace follows until it sets its own; a
// project can choose for itself whether its .memory folders are committed.

export type Limits = {
  /** Commit `.memory` folders to git (default: off). */
  readonly commit: boolean
  /** Each level's index in prompts is cut at this many lines … */
  readonly indexLines: number
  /** … or this many characters, whichever comes first. */
  readonly indexChars: number
}
export type Settings = Limits & {
  /** Namespaces' own settings (OpenCode's are the top-level ones). */
  readonly namespaces: Readonly<Record<string, Partial<Limits>>>
  /** Projects' own choice for committing (none: their namespace's). */
  readonly projects: Readonly<Record<string, { readonly commit: boolean }>>
}

export const DEFAULTS: Settings = { commit: false, indexLines: 200, indexChars: 25_000, namespaces: {}, projects: {} }

const settingsFile = () => path.join(Global.Path.config, "namespaces", "memory.json")

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

export async function settings(): Promise<Settings> {
  const data = (await OperatorFileCache.json(settingsFile())) as Record<string, unknown> | undefined
  const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})
  return {
    commit: data?.commit === true,
    indexLines: positive(data?.indexLines) ?? DEFAULTS.indexLines,
    indexChars: positive(data?.indexChars) ?? DEFAULTS.indexChars,
    namespaces: Object.fromEntries(
      Object.entries(record(data?.namespaces)).map(([id, value]) => {
        const own = record(value)
        return [
          id,
          {
            ...(typeof own.commit === "boolean" ? { commit: own.commit } : {}),
            ...(positive(own.indexLines) ? { indexLines: positive(own.indexLines)! } : {}),
            ...(positive(own.indexChars) ? { indexChars: positive(own.indexChars)! } : {}),
          },
        ]
      }),
    ),
    projects: Object.fromEntries(
      Object.entries(record(data?.projects)).flatMap(([key, value]) =>
        typeof record(value).commit === "boolean" ? [[key, { commit: record(value).commit as boolean }]] : [],
      ),
    ),
  }
}

export async function saveSettings(next: Settings) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await Bun.write(settingsFile(), JSON.stringify(next, null, 2) + "\n")
}

/** A namespace's settings: its own, else OpenCode's. */
export function limitsOf(all: Settings, namespace: string): Limits {
  const own = namespace === OperatorLayout.OPENCODE ? {} : (all.namespaces[namespace] ?? {})
  return {
    commit: own.commit ?? all.commit,
    indexLines: own.indexLines ?? all.indexLines,
    indexChars: own.indexChars ?? all.indexChars,
  }
}

/** Whether a project's `.memory` folders are committed: its own choice, else its namespace's. */
export function commits(all: Settings, project: string, namespace: string) {
  return all.projects[project]?.commit ?? limitsOf(all, namespace).commit
}

/** The namespace a project is in (by where its folder is, layout.ts). */
export async function namespaceOf(project: string) {
  const projects = await OperatorProfileStore.readProjects()
  return OperatorLayout.membership(project, await OperatorLayout.snapshot(), projects[project]?.namespace).namespace
}

export const SettingsView = Schema.Struct({
  namespace: Schema.String.annotate({ description: "The namespace these settings are for" }),
  commit: Schema.Boolean.annotate({ description: "Commit .memory folders to git (default: off)" }),
  indexLines: Schema.Finite.annotate({ description: "Each level's index in prompts is cut at this many lines" }),
  indexChars: Schema.Finite.annotate({ description: "… or at this many characters, whichever comes first" }),
  own: Schema.Boolean.annotate({
    description: "Whether the namespace has settings of its own (else it follows OpenCode's); always for OpenCode",
  }),
  projects: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      override: Schema.optional(Schema.Boolean).annotate({
        description: "The project's own choice; none: the namespace's",
      }),
      commits: Schema.Boolean.annotate({ description: "Whether its .memory folders are committed" }),
      repo: Schema.optional(Schema.String).annotate({ description: "The repository the project is in" }),
      excluded: Schema.optional(Schema.Boolean).annotate({
        description: "Whether the repository's .git/info/exclude keeps .memory out (the project is in a repository)",
      }),
    }),
  ).annotate({ description: "The namespace's projects with a .memory folder or a choice of their own" }),
}).annotate({ identifier: "OperatorMemorySettings" })
export type SettingsView = typeof SettingsView.Type

export const SettingsInput = Schema.Struct({
  namespace: Schema.optional(Schema.String).annotate({ description: "The namespace to change (default: OpenCode)" }),
  commit: Schema.optional(Schema.Boolean),
  indexLines: Schema.optional(Schema.Finite),
  indexChars: Schema.optional(Schema.Finite),
  follow: Schema.optional(Schema.Boolean).annotate({
    description: "A namespace other than OpenCode drops its own settings and follows OpenCode's",
  }),
  project: Schema.optional(
    Schema.Struct({
      key: Schema.String,
      commit: Schema.NullOr(Schema.Boolean).annotate({ description: "null: use the namespace's" }),
    }),
  ).annotate({ description: "One project's own choice for committing" }),
})
export type SettingsInput = typeof SettingsInput.Type

// The projects OpenCode knows (OperatorProfileStore's `projects()`: git projects, registered folders),
// with the namespace each is in.
export type Known = ReadonlyArray<{ readonly key: string; readonly name: string; readonly namespace?: string }>

/** A namespace's settings, with its projects' choices and their repositories' state. */
export async function view(known: Known, namespace: string = OperatorLayout.OPENCODE): Promise<SettingsView> {
  const all = await settings()
  const limits = limitsOf(all, namespace)
  const mine = known.filter((item) => (item.namespace ?? OperatorLayout.OPENCODE) === namespace)
  const names = new Map(mine.map((item) => [item.key, item.name]))
  const keys = [...names.keys()]
  const projects = await Promise.all(
    keys.map(async (key) => {
      const folder = path.join(key, FOLDER)
      const has = await fs.stat(folder).then(
        (info) => info.isDirectory(),
        () => false,
      )
      if (!has && all.projects[key] === undefined) return undefined
      const git = await gitState(folder).catch(() => undefined)
      return {
        key,
        name: names.get(key) ?? path.basename(key),
        ...(all.projects[key] ? { override: all.projects[key]!.commit } : {}),
        commits: commits(all, key, namespace),
        ...(git ? { repo: git.repo, excluded: git.excluded } : {}),
      }
    }),
  )
  return {
    namespace,
    ...limits,
    own: namespace === OperatorLayout.OPENCODE || all.namespaces[namespace] !== undefined,
    projects: projects.filter((item) => item !== undefined),
  }
}

/** Saves a change (a limit below 1 is refused) and applies the commit choice to the repositories. */
export async function update(input: SettingsInput, known: Known) {
  const all = await settings()
  const namespace = input.namespace ?? OperatorLayout.OPENCODE
  const limit = (value: number | undefined) => {
    if (value === undefined) return undefined
    if (!Number.isFinite(value) || value < 1) throw new Error("A limit must be at least 1")
    return Math.floor(value)
  }
  const change = {
    ...(input.commit !== undefined ? { commit: input.commit } : {}),
    ...(limit(input.indexLines) !== undefined ? { indexLines: limit(input.indexLines)! } : {}),
    ...(limit(input.indexChars) !== undefined ? { indexChars: limit(input.indexChars)! } : {}),
  }
  const projects = { ...all.projects }
  if (input.project) {
    if (input.project.commit === null) delete projects[input.project.key]
    else projects[input.project.key] = { commit: input.project.commit }
  }
  const namespaces = { ...all.namespaces }
  if (namespace !== OperatorLayout.OPENCODE) {
    if (input.follow) delete namespaces[namespace]
    else if (Object.keys(change).length)
      namespaces[namespace] = { ...limitsOf(all, namespace), ...namespaces[namespace], ...change }
  }
  await saveSettings({
    ...all,
    ...(namespace === OperatorLayout.OPENCODE ? change : {}),
    namespaces,
    projects,
  })
  await applyAll(known)
  return view(known, namespace)
}

/** A `.memory` folder made (or found) for a project: created, and kept out of git unless the project commits it. */
export async function ensure(folder: string, project: string) {
  await fs.mkdir(folder, { recursive: true })
  await setExcluded(folder, !commits(await settings(), project, await namespaceOf(project))).catch(() => undefined)
  return folder
}

/**
 * Applies the commit settings to every project with a `.memory` folder (after they changed), and to the
 * namespaces' folders (by their own settings).
 */
export async function applyAll(known: Known) {
  const all = await settings()
  const exists = (folder: string) =>
    fs.stat(folder).then(
      (info) => info.isDirectory(),
      () => false,
    )
  const namespaces = new Map(known.map((item) => [item.key, item.namespace ?? OperatorLayout.OPENCODE]))
  for (const project of new Set([...known.map((item) => item.key), ...Object.keys(all.projects)])) {
    const folder = path.join(project, FOLDER)
    const namespace = namespaces.get(project) ?? (await namespaceOf(project))
    if (await exists(folder)) await setExcluded(folder, !commits(all, project, namespace)).catch(() => undefined)
  }
  const layout = await OperatorLayout.snapshot()
  for (const place of layout.places) {
    const folder = path.join(place.folder, FOLDER)
    if (await exists(folder)) await setExcluded(folder, !limitsOf(all, place.id).commit).catch(() => undefined)
  }
}

// ---- Keeping .memory out of git ----

const LINE = ".memory/"
const MARK = "# Added by OpenCode's operator: .memory folders are not committed (Memory → Settings)"

/** The `info/exclude` file of the repository a folder is in (a linked worktree's main repository's). */
export async function excludeFile(folder: string): Promise<{ repo: string; file: string } | undefined> {
  const repo = await OperatorProjects.gitRoot(folder)
  if (!repo) return undefined
  const dotgit = path.join(repo, ".git")
  const info = await fs.stat(dotgit).catch(() => undefined)
  if (!info) return undefined
  let gitdir = dotgit
  if (info.isFile()) {
    const pointer = (await fs.readFile(dotgit, "utf8").catch(() => "")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!pointer) return undefined
    gitdir = path.resolve(repo, pointer)
  }
  const common = await fs
    .readFile(path.join(gitdir, "commondir"), "utf8")
    .then((text) => path.resolve(gitdir, text.trim()))
    .catch(() => gitdir)
  return { repo, file: path.join(common, "info", "exclude") }
}

const isLine = (line: string) => [".memory", ".memory/", "/.memory", "/.memory/"].includes(line.trim())

/**
 * Whether git ignores `.memory` folders in the repository a folder is in: `excluded` (a line in
 * info/exclude), `added` (the line OpenCode added), or none when the folder is not in a repository.
 */
export async function gitState(folder: string) {
  const found = await excludeFile(folder)
  if (!found) return undefined
  const lines = ((await fs.readFile(found.file, "utf8").catch(() => "")) as string).split("\n")
  const at = lines.findIndex(isLine)
  return { repo: found.repo, excluded: at >= 0, added: at > 0 && lines[at - 1] === MARK }
}

/**
 * Keeps `.memory` folders out of the repository a folder is in, or lets them be committed again. Only
 * the line OpenCode added is taken out; one the user wrote stays.
 */
export async function setExcluded(folder: string, excluded: boolean) {
  const found = await excludeFile(folder)
  if (!found) return undefined
  const text = await fs.readFile(found.file, "utf8").catch(() => "")
  const lines = text.split("\n")
  const at = lines.findIndex(isLine)
  if (excluded) {
    if (at >= 0) return found.repo
    await fs.mkdir(path.dirname(found.file), { recursive: true })
    const prefix = text === "" || text.endsWith("\n") ? text : `${text}\n`
    await fs.writeFile(found.file, `${prefix}${MARK}\n${LINE}\n`)
    return found.repo
  }
  if (at > 0 && lines[at - 1] === MARK) {
    lines.splice(at - 1, 2)
    await fs.writeFile(found.file, lines.join("\n"))
  }
  return found.repo
}
