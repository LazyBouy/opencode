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

export type Settings = {
  /** Commit `.memory` folders to git (default: off). */
  readonly commit: boolean
  /** Each level's index in prompts is cut at this many lines … */
  readonly indexLines: number
  /** … or this many characters, whichever comes first. */
  readonly indexChars: number
  /** Projects' own choice for committing (none: the default). */
  readonly projects: Readonly<Record<string, { readonly commit: boolean }>>
}

export const DEFAULTS: Settings = { commit: false, indexLines: 200, indexChars: 25_000, projects: {} }

const settingsFile = () => path.join(Global.Path.config, "namespaces", "memory.json")

export async function settings(): Promise<Settings> {
  const data = (await OperatorFileCache.json(settingsFile())) as Partial<Record<keyof Settings, unknown>> | undefined
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  const projects = data?.projects && typeof data.projects === "object" ? (data.projects as Record<string, unknown>) : {}
  return {
    commit: data?.commit === true,
    indexLines: number(data?.indexLines, DEFAULTS.indexLines),
    indexChars: number(data?.indexChars, DEFAULTS.indexChars),
    projects: Object.fromEntries(
      Object.entries(projects).flatMap(([key, value]) =>
        value && typeof value === "object" && typeof (value as { commit?: unknown }).commit === "boolean"
          ? [[key, { commit: (value as { commit: boolean }).commit }]]
          : [],
      ),
    ),
  }
}

export async function saveSettings(next: Settings) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await Bun.write(settingsFile(), JSON.stringify(next, null, 2) + "\n")
}

/** Whether a project's `.memory` folders are committed: its own choice, else the default. */
export function commits(all: Settings, project: string) {
  return all.projects[project]?.commit ?? all.commit
}

export const SettingsView = Schema.Struct({
  commit: Schema.Boolean.annotate({ description: "Commit .memory folders to git (default: off)" }),
  indexLines: Schema.Finite.annotate({ description: "Each level's index in prompts is cut at this many lines" }),
  indexChars: Schema.Finite.annotate({ description: "… or at this many characters, whichever comes first" }),
  projects: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      override: Schema.optional(Schema.Boolean).annotate({
        description: "The project's own choice; none: the default",
      }),
      commits: Schema.Boolean.annotate({ description: "Whether its .memory folders are committed" }),
      repo: Schema.optional(Schema.String).annotate({ description: "The repository the project is in" }),
      excluded: Schema.optional(Schema.Boolean).annotate({
        description: "Whether the repository's .git/info/exclude keeps .memory out (the project is in a repository)",
      }),
    }),
  ).annotate({ description: "The projects with a .memory folder or a choice of their own" }),
}).annotate({ identifier: "OperatorMemorySettings" })
export type SettingsView = typeof SettingsView.Type

export const SettingsInput = Schema.Struct({
  commit: Schema.optional(Schema.Boolean),
  indexLines: Schema.optional(Schema.Finite),
  indexChars: Schema.optional(Schema.Finite),
  project: Schema.optional(
    Schema.Struct({
      key: Schema.String,
      commit: Schema.NullOr(Schema.Boolean).annotate({ description: "null: use the default" }),
    }),
  ).annotate({ description: "One project's own choice for committing" }),
})
export type SettingsInput = typeof SettingsInput.Type

// The projects OpenCode knows (OperatorProfileStore's `projects()`: git projects, registered folders).
export type Known = ReadonlyArray<{ readonly key: string; readonly name: string }>

/** The settings, with each project's choice and its repository's state. */
export async function view(known: Known): Promise<SettingsView> {
  const all = await settings()
  const names = new Map(known.map((item) => [item.key, item.name]))
  const keys = [...new Set([...names.keys(), ...Object.keys(all.projects)])]
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
        commits: commits(all, key),
        ...(git ? { repo: git.repo, excluded: git.excluded } : {}),
      }
    }),
  )
  return {
    commit: all.commit,
    indexLines: all.indexLines,
    indexChars: all.indexChars,
    projects: projects.filter((item) => item !== undefined),
  }
}

/** Saves a change (a limit below 1 is refused) and applies the commit choice to the repositories. */
export async function update(input: SettingsInput, known: Known) {
  const all = await settings()
  const limit = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback
    if (!Number.isFinite(value) || value < 1) throw new Error("A limit must be at least 1")
    return Math.floor(value)
  }
  const projects = { ...all.projects }
  if (input.project) {
    if (input.project.commit === null) delete projects[input.project.key]
    else projects[input.project.key] = { commit: input.project.commit }
  }
  await saveSettings({
    commit: input.commit ?? all.commit,
    indexLines: limit(input.indexLines, all.indexLines),
    indexChars: limit(input.indexChars, all.indexChars),
    projects,
  })
  await applyAll(known)
  return view(known)
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

/** A `.memory` folder made (or found) for a project: created, and kept out of git unless the project commits it. */
export async function ensure(folder: string, project: string) {
  await fs.mkdir(folder, { recursive: true })
  await setExcluded(folder, !commits(await settings(), project)).catch(() => undefined)
  return folder
}

/**
 * Applies the commit setting to every project with a `.memory` folder (after the setting changed), and
 * to the namespaces' folders (by the default).
 */
export async function applyAll(known: Known) {
  const all = await settings()
  const projects = new Set([...known.map((item) => item.key), ...Object.keys(all.projects)])
  const exists = (folder: string) =>
    fs.stat(folder).then(
      (info) => info.isDirectory(),
      () => false,
    )
  for (const project of projects) {
    const folder = path.join(project, FOLDER)
    if (await exists(folder)) await setExcluded(folder, !commits(all, project)).catch(() => undefined)
  }
  const layout = await OperatorLayout.snapshot()
  for (const place of layout.places) {
    const folder = path.join(place.folder, FOLDER)
    if (await exists(folder)) await setExcluded(folder, !all.commit).catch(() => undefined)
  }
}
