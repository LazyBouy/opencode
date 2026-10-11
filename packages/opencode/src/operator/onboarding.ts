export * as OperatorOnboarding from "./onboarding"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorLayout } from "./layout"

// The first start of a new installation (memory_spec.md §10). The web UI asks for the working folder (every
// namespace but Global lives in it; OpenCode's folder is <working folder>/opencode) and a default OpenCode
// project made inside OpenCode's folder; it warns about merged agents whose data is outside the home folder,
// shows a summary, then opens the console. The opencode repository is never registered by it.
//
// It runs once. A fresh installation is marked pending when the namespace store is first written without a
// working folder given (profile-store.ts ensure); finishing records it done, here in the server's data
// folder. An installation from before onboarding, or one given OPENCODE_OPERATOR_WORKING_DIR, isn't asked.

export const DEFAULT_PROJECT = "opencode"

const file = () => path.join(Global.Path.data, "operator", "onboarding.json")

export type State =
  | { readonly pending: true }
  | { readonly done: true; readonly at: number; readonly workingDir: string; readonly project: string }

export async function read(): Promise<State | undefined> {
  const data = (await Bun.file(file())
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (!data) return undefined
  if (data.done === true && typeof data.workingDir === "string" && typeof data.project === "string")
    return { done: true, at: Number(data.at) || 0, workingDir: data.workingDir, project: data.project }
  if (data.pending === true) return { pending: true }
  return undefined
}

async function write(state: State) {
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(state, null, 2) + "\n")
}

/** A new installation: the web UI onboards it. Nothing changes once a state is recorded. */
export async function markPending() {
  if (await read()) return
  await write({ pending: true })
}

export async function markDone(input: { workingDir: string; project: string }) {
  await write({ done: true, at: Date.now(), ...input })
}

/**
 * The working folder to suggest: the server's current folder when it can be one (inside the workspace roots,
 * outside Global's folder and outside git), else `opencode-home` in the home folder, else in the first root.
 */
export async function suggested(roots: ReadonlyArray<string>, cwd = process.cwd()) {
  const home = path.join(os.homedir(), "opencode-home")
  for (const folder of [cwd, home])
    if (!(await OperatorLayout.workingDirProblem(folder, roots))) return path.resolve(folder)
  return roots[0] ? path.join(roots[0], "opencode-home") : home
}

/** Why `name` can't be the default project's folder name, if it can't. */
export function projectNameProblem(name: string) {
  const trimmed = name.trim()
  if (!trimmed || trimmed.includes("/") || trimmed.includes(path.sep) || trimmed === "." || trimmed === "..")
    return `"${name}" isn't a folder name`
  if (trimmed.startsWith(".")) return "A project's folder name can't start with a dot"
  return undefined
}

/** The folders onboarding makes, for a working folder and a project name. */
export function folders(workingDir: string, project: string) {
  const resolved = path.resolve(workingDir.trim())
  const opencode = path.join(resolved, OperatorLayout.OPENCODE)
  return { workingDir: resolved, opencode, project: path.join(opencode, project.trim()) }
}

// The file system a path is on: the device of it or of the nearest folder above it that exists.
async function device(target: string): Promise<number | undefined> {
  let current = path.resolve(target)
  for (;;) {
    const stat = await fs.stat(current).catch(() => undefined)
    if (stat) return stat.dev
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Whether two paths are on the same file system (unknown counts as the same). */
export async function sameFileSystem(a: string, b: string) {
  const [first, second] = await Promise.all([device(a), device(b)])
  return first === undefined || second === undefined || first === second
}

export const home = () => os.homedir()

/** Whether a merged agent's data folder is inside the home folder. */
export const insideHome = (folder: string) => OperatorLayout.contains(home(), folder)
