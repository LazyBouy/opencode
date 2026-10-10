export * as OperatorProjects from "./projects"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "./file-cache"

// Which project a folder belongs to. Every session and its agents belong to exactly one project:
// - a git repository (any folder inside one belongs to the repository);
// - a folder outside git that was registered as a project (its subfolders belong to it too).
// A folder outside git that is not inside a registered one is not a project.

export type Project = { key: string; git: boolean }

// The repository a folder is in (the folder holding `.git`), if any.
export async function gitRoot(folder: string): Promise<string | undefined> {
  let current = path.resolve(folder)
  while (true) {
    const found = await fs
      .stat(path.join(current, ".git"))
      .then(() => true)
      .catch(() => false)
    if (found) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// The registered folder a folder outside git is in (itself, or the nearest registered one above it).
export function registeredRoot(folder: string, registered: ReadonlyArray<string>) {
  const resolved = path.resolve(folder)
  return registered
    .filter((key) => resolved === key || resolved.startsWith(key.endsWith(path.sep) ? key : key + path.sep))
    .toSorted((a, b) => b.length - a.length)[0]
}

// The folders registered as projects (projects.json, written by profile-store.ts), read on every
// permission ask: through the file cache.
async function registered() {
  const data = await OperatorFileCache.json(path.join(Global.Path.config, "namespaces", "projects.json"))
  // As OperatorProfileStore.readProjects counts them: entries that name a namespace.
  return data && typeof data === "object"
    ? Object.entries(data as Record<string, unknown>)
        .filter(([, value]) => !!value && typeof (value as { namespace?: unknown }).namespace === "string")
        .map(([key]) => key)
    : []
}

// The project a folder belongs to, or undefined when it is not part of one.
export async function projectOf(folder: string): Promise<Project | undefined> {
  const repository = await gitRoot(folder)
  if (repository) return { key: repository, git: true }
  const key = registeredRoot(folder, await registered())
  return key ? { key, git: false } : undefined
}

// The project key of a request's instance: its worktree, or for a folder outside git the
// registered folder it is in (the folder itself when it is not in one).
export async function keyOf(ctx: { directory: string; worktree: string }) {
  if (ctx.worktree !== "/") return ctx.worktree
  return registeredRoot(ctx.directory, await registered()) ?? ctx.directory
}

// Whether sessions are refused in folders that are not projects. Upstream's test suite (which
// sets OPENCODE_TEST_HOME) creates sessions in plain temporary folders, so the rule is off there;
// OPENCODE_PROJECT_GUARD=on|off overrides.
export function guarded(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCODE_PROJECT_GUARD === "on") return true
  if (env.OPENCODE_PROJECT_GUARD === "off") return false
  return !env.OPENCODE_TEST_HOME
}
