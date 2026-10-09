export * as OperatorNamespaceScope from "./namespace-scope"

import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorLayout } from "./layout"

// The namespace layer of a project's capabilities (capability_scopes_spec.md §4): the folder
// `<namespace folder>/.opencode/`, laid out as a project's `.opencode` (opencode.jsonc, commands/,
// skills/, tools/, agents/, plugins/). OpenCode loads it through two seams:
// - `ConfigPaths.directories()` lists it right after the global config folder, so the project's own
//   command, agent, tool and plugin files (later in the list) win over the namespace's;
// - `Config` merges its opencode.json(c) right after the global files and before the project's
//   opencode.json, and skips it in the folder loop (where it would be merged after the project's JSON).
// A namespace whose folder has no `.opencode` adds nothing, so OpenCode's behaviour is unchanged until
// something is put there.
//
// A namespace can also leave out the global capabilities (§6, "Inherit global capabilities" off): the
// global capability folders (`~/.config/opencode`, `~/.opencode`; `~/.claude/skills` and
// `~/.agents/skills` in skill/index.ts) and the global config's capability keys. The global config's
// other settings (providers, model, username, keybinds, …) always apply. Every namespace has the
// switch, OpenCode's included (global_and_opencode_namespaces_spec.md §6); it is on unless turned off.

const CONFIG_DIR = ".opencode"
// This module is imported by config/paths.ts, so it reads the namespace store's two small files itself
// (profile-store.ts writes them) rather than importing the operator's services.
const store = () => path.join(Global.Path.config, "namespaces")
const readJson = (file: string) =>
  Bun.file(file)
    .json()
    .then((data: unknown) => (data && typeof data === "object" ? (data as Record<string, unknown>) : {}))
    .catch(() => ({}) as Record<string, unknown>)

// The namespace `.opencode` folders handed out, so the folder loop can tell them apart.
const owned = new Set<string>()
// Every instance folder that asked for its namespace layer, with its project and namespace: a change to
// a namespace, or a project moving between namespaces, reloads exactly those instances.
const loaded = new Map<string, { project: string; namespace: string }>()

export type Layer = { namespace: string; project: string; dir?: string; inherit: boolean }

// The config keys that are capabilities: left out of the global config for a namespace that doesn't
// inherit it.
export const CAPABILITY_KEYS: ReadonlyArray<string> = [
  "command",
  "agent",
  "mode",
  "mcp",
  "plugin",
  "skills",
  "instructions",
  "tools",
  "permission",
  "references",
]

// The global folders that hold capability files.
const globalFolders = () => [Global.Path.config, path.join(Global.Path.home, CONFIG_DIR)]

const exists = (dir: string) =>
  fs
    .stat(dir)
    .then((stat) => stat.isDirectory())
    .catch(() => false)

// The project a folder belongs to (as OperatorProjects.keyOf): its worktree, or outside git the
// registered folder it is in.
function projectOf(directory: string, worktree: string, registered: ReadonlyArray<string>) {
  if (worktree !== "/") return worktree
  const resolved = path.resolve(directory)
  return (
    registered
      .filter((key) => resolved === key || resolved.startsWith(key.endsWith(path.sep) ? key : key + path.sep))
      .toSorted((a, b) => b.length - a.length)[0] ?? resolved
  )
}

// The namespace a folder's project is in (by location, layout.ts), and that namespace's `.opencode`
// folder when it exists. Global's projects have no namespace layer: Global is already the base.
export async function layerOf(directory: string, worktree?: string): Promise<Layer> {
  const settings = await readJson(path.join(store(), "projects.json"))
  const project = projectOf(directory, worktree ?? "/", Object.keys(settings))
  const entry = settings[project]
  const assigned =
    entry && typeof entry === "object" && typeof (entry as { namespace?: unknown }).namespace === "string"
      ? (entry as { namespace: string }).namespace
      : undefined
  const layout = await OperatorLayout.snapshot()
  const namespace = OperatorLayout.membership(project, layout, assigned).namespace
  const place = OperatorLayout.placeOf(namespace, layout)
  const inherit = place?.inheritGlobal ?? true
  loaded.set(directory, { project, namespace })
  const dir = place && !place.global ? place.configDir : undefined
  if (!dir || !(await exists(dir))) return { namespace, project, inherit }
  owned.add(dir)
  return { namespace, project, dir, inherit }
}

// A namespace's own layer by id (for its Capabilities page, outside any project): its `.opencode`
// folder when it exists, where it would be, and whether it inherits Global's capabilities. Global's
// layer is Global's folder itself.
export async function namespaceLayer(namespace: string) {
  const layout = await OperatorLayout.snapshot()
  const place = OperatorLayout.placeOf(namespace, layout)
  const id = OperatorLayout.resolveId(namespace, layout)
  if (!place) return { namespace: id, inherit: true, global: false }
  const target = place.configDir
  const dir = (await exists(target)) ? target : undefined
  if (dir && !place.global) owned.add(dir)
  return { namespace: id, dir, target, inherit: place.inheritGlobal, global: place.global }
}

// Every namespace's folder but Global's, by id (scopes.ts classifies paths with them; Global's folder
// is Global's scope).
export async function namespaceFolders(): Promise<Array<{ id: string; folder: string }>> {
  const layout = await OperatorLayout.snapshot()
  return layout.places.filter((place) => !place.global).map((place) => ({ id: place.id, folder: place.folder }))
}

// The global folders that hold capability files (for telling scopes apart).
export function isGlobalFolder(dir: string) {
  return globalFolders().includes(dir)
}

// The config folders for `directory`: upstream's list with the namespace layer right after the global
// config folder (first when the namespace leaves out the global folders). A non-git project under its
// namespace folder would also reach the layer by walking up; it stays once, in the namespace position.
export const directories = Effect.fnUntraced(function* (
  directory: string,
  worktree: string | undefined,
  upstream: ReadonlyArray<string>,
) {
  const layer = yield* Effect.promise(() => layerOf(directory, worktree))
  const global = new Set(globalFolders())
  const kept = layer.inherit ? [...upstream] : upstream.filter((dir) => !global.has(dir))
  if (!layer.dir) return kept
  const rest = kept.filter((dir) => dir !== layer.dir)
  const at = rest[0] === Global.Path.config ? 1 : 0
  return [...rest.slice(0, at), layer.dir, ...rest.slice(at)]
})

// The global config as a project of the namespace sees it: whole, or without its capability keys.
export function globalFor<T extends object>(ctx: { directory: string; worktree: string }, config: T) {
  return Effect.promise(() => layerOf(ctx.directory, ctx.worktree)).pipe(
    Effect.map((layer) =>
      layer.inherit
        ? config
        : (Object.fromEntries(Object.entries(config).filter(([key]) => !CAPABILITY_KEYS.includes(key))) as T),
    ),
  )
}

// Whether the folder's namespace gets the global capabilities.
export const inheritsGlobal = Effect.fnUntraced(function* (directory: string, worktree: string) {
  return (yield* Effect.promise(() => layerOf(directory, worktree))).inherit
})

// The namespace layer's opencode.json(c), merged right after the global config files: only for a project
// without a config of its own (global_and_opencode_namespaces_spec.md §6, layer 2). A project's own config
// is a full copy of its namespace's, made when a project page first saved a change (project-config.ts).
export const configFiles = Effect.fnUntraced(function* (ctx: { directory: string; worktree: string }) {
  const layer = yield* Effect.promise(() => layerOf(ctx.directory, ctx.worktree))
  if (!layer.dir) return []
  if ((yield* Effect.promise(() => ownConfigFiles(layer.project))).length) return []
  return [path.join(layer.dir, "opencode.json"), path.join(layer.dir, "opencode.jsonc")]
})

// A project's own config files (§7.1), in the order the project Config page picks the one it edits: the
// first that exists. Upstream merges every one of them (MERGE_ORDER).
export const OWN_CONFIG_FILES: ReadonlyArray<string> = [
  path.join(CONFIG_DIR, "opencode.jsonc"),
  path.join(CONFIG_DIR, "opencode.json"),
  "opencode.jsonc",
  "opencode.json",
]
// The order upstream merges them: the project folder's files (json, then jsonc), then its `.opencode`'s.
export const MERGE_ORDER: ReadonlyArray<string> = [
  "opencode.json",
  "opencode.jsonc",
  path.join(CONFIG_DIR, "opencode.json"),
  path.join(CONFIG_DIR, "opencode.jsonc"),
]

const isFile = (file: string) =>
  fs
    .stat(file)
    .then((stat) => stat.isFile())
    .catch(() => false)

export async function ownConfigFiles(project: string, order: ReadonlyArray<string> = OWN_CONFIG_FILES) {
  const found = await Promise.all(
    order.map(async (name) => {
      const file = path.join(project, name)
      return (await isFile(file)) ? file : undefined
    }),
  )
  return found.filter((file): file is string => file !== undefined)
}

// The project files upstream walks up to, without Global's own config files: they are the Global base
// already, and a Global project outside git would otherwise find them again as its own (§6).
export function projectFiles(files: ReadonlyArray<string>) {
  const global = path.resolve(Global.Path.config)
  return files.filter((file) => path.dirname(path.resolve(file)) !== global)
}

// Whether a config folder is a namespace layer (its JSON is merged earlier, not in the folder loop).
export function owns(dir: string) {
  return owned.has(dir)
}

// The loaded instance folders a change affects: every one in the namespace, or in the project.
export function instancesOf(target: { namespace: string } | { project: string }) {
  return [...loaded.entries()]
    .filter(([, item]) =>
      "namespace" in target ? item.namespace === target.namespace : item.project === target.project,
    )
    .map(([directory]) => directory)
}

// An instance that is gone no longer needs reloading.
export function forget(directory: string) {
  loaded.delete(directory)
}
