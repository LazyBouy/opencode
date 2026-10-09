export * as OperatorLayout from "./layout"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

// Where namespaces and projects live (global_and_opencode_namespaces_spec.md §4, §5, §9):
// - Global is the namespace whose folder is `~/.config/opencode/` (its config sits directly in it).
// - Every other namespace is at `<working directory>/<id>/`, its config in the folder's `.opencode/`;
//   OpenCode's is `<working directory>/opencode/`.
// - A blank working directory means Global and OpenCode are one namespace ("Global · OpenCode"): its id
//   is `opencode`, `global` resolves to it, and its folder is Global's.
// - A project is in the namespace whose folder contains it (the deepest), else in OpenCode, flagged
//   "Outside OpenCode's folder". A project `projects.json` assigns to another namespace stays in that
//   namespace until it moves there, flagged "Not in place"; so does a namespace whose record still names
//   an old folder.
// No service imports: config/paths.ts reaches this through namespace-scope.ts.

export const GLOBAL = "global"
export const OPENCODE = "opencode"
const CONFIG_DIR = ".opencode"
const GLOBAL_CONFIGS = ["opencode.jsonc", "opencode.json", "config.json"]

const store = () => path.join(Global.Path.config, "namespaces")
const settingsFile = () => path.join(store(), "settings.json")

export type Settings = {
  /** The working directory; empty or missing means blank. */
  workingDir?: string
  /** OpenCode's MCP logins were copied to their own keys when it became separate from Global. */
  mcpLoginsCopied?: boolean
}

const readJson = (file: string): Promise<Record<string, unknown>> =>
  fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .then((data) => (data && typeof data === "object" ? (data as Record<string, unknown>) : {}))
    .catch(() => ({}))

export async function readSettings(): Promise<Settings> {
  const data = await readJson(settingsFile())
  return {
    ...(typeof data.workingDir === "string" && data.workingDir ? { workingDir: data.workingDir } : {}),
    ...(data.mcpLoginsCopied === true ? { mcpLoginsCopied: true } : {}),
  }
}

export async function writeSettings(next: Settings) {
  await fs.mkdir(store(), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2) + "\n")
}

export const contains = (folder: string, file: string) => {
  const resolved = path.resolve(file)
  const root = path.resolve(folder)
  return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

export type Place = {
  id: string
  /** The folder it uses now: its target, or (not in place) the folder its record still names. */
  folder: string
  /** Where it belongs: Global's folder, or `<working dir>/<id>/`. */
  target: string
  inPlace: boolean
  /** Where its config and capability folders are: Global's folder itself, else the folder's `.opencode/`. */
  configDir: string
  /** Global's config sits directly in its folder; the others' in `.opencode/`. */
  global: boolean
  inheritGlobal: boolean
}

export type Snapshot = {
  workingDir?: string
  /** A blank working directory: Global and OpenCode are one namespace (id `opencode`). */
  merged: boolean
  places: ReadonlyArray<Place>
}

/** Every namespace's place now, Global's included. */
export async function snapshot(): Promise<Snapshot> {
  const settings = await readSettings()
  const workingDir = settings.workingDir ? path.resolve(settings.workingDir) : undefined
  const merged = !workingDir
  const entries = await fs.readdir(store(), { withFileTypes: true }).catch(() => [])
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        id: entry.name,
        record: await readJson(path.join(store(), entry.name, "namespace.json")),
      })),
  )
  const globalFolder = path.resolve(Global.Path.config)
  const places: Place[] = []
  const known = records.filter((item) => item.record.id === item.id || Object.keys(item.record).length)
  const ids = new Set(known.map((item) => item.id))
  // Global is a namespace even before it has a record; with a blank working directory it is OpenCode.
  if (!merged) ids.add(GLOBAL)
  ids.add(OPENCODE)
  for (const id of ids) {
    const record = known.find((item) => item.id === id)?.record ?? {}
    const isGlobal = id === GLOBAL || (merged && id === OPENCODE)
    const target = isGlobal ? globalFolder : path.join(workingDir ?? globalFolder, id)
    const named = typeof record.folder === "string" && record.folder ? path.resolve(record.folder) : undefined
    // Without a working directory the other namespaces have no target: their own folders are used.
    const folder = isGlobal ? globalFolder : (named ?? target)
    places.push({
      id,
      folder,
      target: merged && !isGlobal ? folder : target,
      inPlace: isGlobal || merged || folder === target,
      configDir: isGlobal ? globalFolder : path.join(folder, CONFIG_DIR),
      global: isGlobal,
      // Global can't leave out its own capabilities.
      inheritGlobal: isGlobal || record.inheritGlobal !== false,
    })
  }
  return { ...(workingDir ? { workingDir } : {}), merged, places }
}

/** The id a namespace goes by: `global` is OpenCode's when the working directory is blank. */
export function resolveId(id: string, layout: Snapshot) {
  return layout.merged && id === GLOBAL ? OPENCODE : id
}

export function placeOf(id: string, layout: Snapshot) {
  const resolved = resolveId(id, layout)
  return layout.places.find((item) => item.id === resolved)
}

/** Whether a namespace is Global (or "Global · OpenCode"). */
export function isGlobal(id: string, layout: Snapshot) {
  return placeOf(id, layout)?.global ?? false
}

/** Global's config file: the existing one of its names, else `opencode.jsonc`. */
export async function globalConfigFile() {
  for (const name of GLOBAL_CONFIGS) {
    const file = path.join(Global.Path.config, name)
    if (
      await fs.stat(file).then(
        () => true,
        () => false,
      )
    )
      return file
  }
  return path.join(Global.Path.config, "opencode.jsonc")
}

/** Built-in (OpenCode's own) permission lines can't be deleted in the OpenCode and Global namespaces. */
export function builtinsProtected(id: string, layout: Snapshot) {
  return resolveId(id, layout) === OPENCODE || isGlobal(id, layout)
}

/** The id Global's marks and record are kept under: `global`, or `opencode` when they are one. */
export function globalId(layout: Snapshot) {
  return layout.merged ? OPENCODE : GLOBAL
}

export type Flag = "outside-opencode" | "not-in-place"

/**
 * The namespace a project is in, by where its folder is: the deepest namespace folder that contains it.
 * `assigned` is the namespace `projects.json` names (the move target); a project assigned to another
 * namespace than OpenCode stays there until it moves into its folder.
 */
export function membership(project: string, layout: Snapshot, assigned?: string): { namespace: string; flag?: Flag } {
  const wanted = assigned ? resolveId(assigned, layout) : undefined
  if (wanted && wanted !== OPENCODE) {
    const place = placeOf(wanted, layout)
    if (place)
      return contains(place.folder, project) ? { namespace: wanted } : { namespace: wanted, flag: "not-in-place" }
  }
  const found = layout.places
    .filter((place) => contains(place.folder, project))
    .toSorted((a, b) => b.folder.length - a.folder.length)[0]
  if (found) return { namespace: found.id }
  return { namespace: OPENCODE, flag: "outside-opencode" }
}

/** The working directory a fresh installation starts with (§9, §12.1). */
export function derivedWorkingDir(env: NodeJS.ProcessEnv, opencodeFolder: string | undefined) {
  const given = env.OPENCODE_OPERATOR_WORKING_DIR?.trim()
  if (given && path.isAbsolute(given)) return path.resolve(given)
  if (opencodeFolder && path.isAbsolute(opencodeFolder)) return path.dirname(path.resolve(opencodeFolder))
  return undefined
}

/** Why a folder can't be the working directory, if it can't (§4.3). */
export async function workingDirProblem(folder: string, roots: ReadonlyArray<string>) {
  if (!path.isAbsolute(folder)) return `The working directory must be an absolute path: ${folder}`
  const resolved = path.resolve(folder)
  if (!roots.some((root) => contains(root, resolved)))
    return `${resolved} is outside the workspace (${roots.join(", ")})`
  if (contains(Global.Path.config, resolved)) return `The working directory can't be inside ${Global.Path.config}`
  if (await insideGit(resolved)) return `${resolved} is inside a git repository`
  return undefined
}

async function insideGit(folder: string): Promise<boolean> {
  let current = folder
  for (;;) {
    if (
      await fs.stat(path.join(current, ".git")).then(
        () => true,
        () => false,
      )
    )
      return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}
