export * as OperatorPathRewrite from "./path-rewrite"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { OperatorQueueStore } from "./queue-store"

// Every store that keeps absolute paths, rewritten when a folder moves (global_and_opencode_namespaces_spec.md
// §11.3 step 4). The list is here, in code, and test/operator/path-rewrite.test.ts seeds each store and
// checks nothing old is left. When the fork (or upstream) adds a store that keeps a folder, add it here.
//
// Rewritten here (plain files, each written to a temporary file and swapped in, the old one kept as a
// backup until the move finishes):
// - the namespace store, `<config>/namespaces/`: projects.json and agents.json (keys), each
//   <namespace>/namespace.json (folder, defaultProject), project-records.json, project-permissions.json
//   (keys), project-config-copies.json (keys, file);
// - the data folder's `operator/`: agent-sessions.json and calls/latest.json (keys `<project>\n<agent>`),
//   agent-permission-locks.json (keys), permission-decisions/*.jsonl (directory, project, rule.where),
//   calls/*/calls.jsonl (projectKey, directory), trash/*/entry.json (project, files[].path, copy.file);
// - queue.sqlite (queue_item.project), through queue-store.ts;
// - snapshot repositories, `<data>/snapshot/<project id>/<hash of the worktree>`: renamed to the new
//   worktree's hash, with their `objects/info/alternates` pointed at the moved repository.
// The core database (project, project_directory, workspace, session_merge_binding, and sessions through
// their events) is rewritten by layout-move.ts, which holds the database services; so are merged agents'
// own records of sessions in the folder, through their adapters' relocators (Claude Code: its
// `projects/<folder name>` folders under CLAUDE_CONFIG_DIR or ~/.claude are renamed, and the `cwd` of their
// transcripts' lines rewritten; merge/adapter/claude/sessions.ts).
// Not rewritten (content, not records): message and part bodies, prompts, call blobs, config files (listed
// in the move's report instead, §11.3 step 5).

export const STORES = [
  "namespaces/projects.json",
  "namespaces/agents.json",
  "namespaces/<id>/namespace.json",
  "namespaces/project-records.json",
  "namespaces/project-permissions.json",
  "namespaces/project-config-copies.json",
  "operator/agent-sessions.json",
  "operator/agent-permission-locks.json",
  "operator/permission-decisions/*.jsonl",
  "operator/calls/*/calls.jsonl",
  "operator/calls/latest.json",
  "operator/trash/*/entry.json",
  "operator/queue.sqlite",
  "snapshot/<project>/<worktree hash>",
  "database: project.worktree, project.sandboxes, project_directory.directory",
  "database: workspace.directory, session_merge_binding.cwd",
  "database: session.directory (through session events)",
  "merged agents: Claude Code's projects/<folder name> (folder names, transcript cwd)",
] as const

/** `value` with the folder `from` replaced by `to`, when it is `from` or inside it; else undefined. */
export function swap(value: string, from: string, to: string): string | undefined {
  if (value === from) return to
  for (const separator of [path.sep, "\n"]) if (value.startsWith(from + separator)) return to + value.slice(from.length)
  return undefined
}

/** Every string value and key that is the folder or inside it, replaced. */
export function deepSwap(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return swap(value, from, to) ?? value
  if (Array.isArray(value)) return value.map((item) => deepSwap(item, from, to))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        swap(key, from, to) ?? key,
        deepSwap(item, from, to),
      ]),
    )
  return value
}

const readText = (file: string) => fs.readFile(file, "utf8").catch(() => undefined)
const list = (dir: string) => fs.readdir(dir, { withFileTypes: true }).catch(() => [])

/** The JSON and JSONL files that may hold paths, as they are now. */
export async function files(): Promise<Array<{ file: string; lines: boolean }>> {
  const config = path.join(Global.Path.config, "namespaces")
  const data = path.join(Global.Path.data, "operator")
  const json = [
    path.join(config, "projects.json"),
    path.join(config, "agents.json"),
    path.join(config, "project-records.json"),
    path.join(config, "project-permissions.json"),
    path.join(config, "project-config-copies.json"),
    path.join(data, "agent-sessions.json"),
    path.join(data, "agent-permission-locks.json"),
    path.join(data, "calls", "latest.json"),
  ]
  for (const entry of await list(config))
    if (entry.isDirectory()) json.push(path.join(config, entry.name, "namespace.json"))
  for (const entry of await list(path.join(data, "trash")))
    if (entry.isDirectory()) json.push(path.join(data, "trash", entry.name, "entry.json"))
  const lines: string[] = []
  for (const entry of await list(path.join(data, "permission-decisions")))
    if (entry.isFile() && entry.name.endsWith(".jsonl")) lines.push(path.join(data, "permission-decisions", entry.name))
  for (const entry of await list(path.join(data, "calls")))
    if (entry.isDirectory()) lines.push(path.join(data, "calls", entry.name, "calls.jsonl"))
  return [...json.map((file) => ({ file, lines: false })), ...lines.map((file) => ({ file, lines: true }))]
}

/** A file's text with the folder replaced; undefined when nothing in it changes. */
export function rewriteText(text: string, from: string, to: string, lines: boolean): string | undefined {
  const one = (input: string) => {
    if (!input.trim()) return input
    try {
      return JSON.stringify(deepSwap(JSON.parse(input), from, to))
    } catch {
      return input
    }
  }
  if (lines) {
    const next = text.split("\n").map(one).join("\n")
    return next === text ? undefined : next
  }
  try {
    const before = JSON.parse(text) as unknown
    const after = deepSwap(before, from, to)
    if (JSON.stringify(after) === JSON.stringify(before)) return undefined
    return JSON.stringify(after, null, 2) + "\n"
  } catch {
    return undefined
  }
}

/** What a rewrite changed, for rolling it back: each file's backup, and the queue's rows. */
export type Undo = {
  backups: Array<{ file: string; backup: string }>
  queue: number
  snapshots: Array<{ from: string; to: string; alternates?: { file: string; text: string } }>
}

/**
 * Rewrites the plain-file stores, the queue and the snapshot repositories. The old files are kept as
 * `<file>.move-<id>` until `finish` (or put back by `rollback`).
 */
export async function rewrite(
  id: string,
  from: string,
  to: string,
  projects: ReadonlyArray<{ id: string; worktree: string }>,
): Promise<Undo> {
  const undo: Undo = { backups: [], queue: 0, snapshots: [] }
  try {
    for (const { file, lines } of await files()) {
      const text = await readText(file)
      if (text === undefined) continue
      const next = rewriteText(text, from, to, lines)
      if (next === undefined) continue
      const backup = `${file}.move-${id}`
      const temporary = `${file}.move-${id}.tmp`
      await fs.writeFile(temporary, next)
      await fs.rename(file, backup)
      undo.backups.push({ file, backup })
      await fs.rename(temporary, file)
    }
    undo.queue = OperatorQueueStore.store().movePaths(from, to)
    for (const project of projects) {
      const moved = swap(project.worktree, from, to)
      if (!moved) continue
      const base = path.join(Global.Path.data, "snapshot", project.id)
      const before = path.join(base, Hash.fast(project.worktree))
      const after = path.join(base, Hash.fast(moved))
      if (!(await exists(before)) || (await exists(after))) continue
      await fs.rename(before, after)
      const alternates = path.join(after, "objects", "info", "alternates")
      const text = await readText(alternates)
      undo.snapshots.push({
        from: before,
        to: after,
        ...(text !== undefined ? { alternates: { file: alternates, text } } : {}),
      })
      if (text !== undefined)
        await fs.writeFile(
          alternates,
          text
            .split("\n")
            .map((line) => swap(line, from, to) ?? line)
            .join("\n"),
        )
    }
    return undo
  } catch (error) {
    await rollback(undo, from, to)
    throw error
  }
}

/** Puts every rewritten store back as it was. */
export async function rollback(undo: Undo, from: string, to: string) {
  for (const snapshot of undo.snapshots.toReversed()) {
    if (snapshot.alternates)
      await fs.writeFile(snapshot.alternates.file, snapshot.alternates.text).catch(() => undefined)
    await fs.rename(snapshot.to, snapshot.from).catch(() => undefined)
  }
  if (undo.queue) OperatorQueueStore.store().movePaths(to, from)
  for (const { file, backup } of undo.backups.toReversed()) await fs.rename(backup, file).catch(() => undefined)
}

/** Drops the backups once the move has finished. */
export async function finish(undo: Undo) {
  for (const { backup } of undo.backups) await fs.rm(backup, { force: true })
}

/** Files under `folder` (config files, instructions) that still name the old folder: updated by hand (§11.3 step 5). */
export async function filesNaming(folder: string, old: string): Promise<string[]> {
  const found: string[] = []
  const candidates = ["opencode.json", "opencode.jsonc", "AGENTS.md", "CLAUDE.md"]
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || found.length >= 50) return
    for (const entry of await list(dir)) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue
        if (entry.name.startsWith(".") && entry.name !== ".opencode") continue
        await walk(child, depth + 1)
        continue
      }
      if (!entry.isFile() || !(candidates.includes(entry.name) || dir.endsWith(`${path.sep}.opencode`))) continue
      const text = await readText(child)
      if (text?.includes(old)) found.push(child)
    }
  }
  await walk(folder, 0)
  return found.toSorted()
}

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
