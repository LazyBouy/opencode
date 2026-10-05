export * as OperatorProjectCopy from "./project-copy"

import fs from "fs/promises"
import path from "path"

// A project's own resources, copied when a new project is made from it: its `.opencode` folder
// (agents, commands, tools, skills, plugins, its config there) and its project config at the root.
// Namespace resources (prompt profiles) are shared, not copied here. The source is only read; files
// the target already has are kept.
const ROOT_FILES = ["opencode.json", "opencode.jsonc"]
const SKIP = new Set(["node_modules", ".git"])

export type Result = { copied: string[]; kept: string[] }

export async function copyFiles(source: string, target: string): Promise<Result> {
  const result: Result = { copied: [], kept: [] }
  const copy = async (from: string, to: string, relative: string) => {
    const stat = await fs.lstat(from).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      if (SKIP.has(path.basename(from))) return
      await fs.mkdir(to, { recursive: true })
      for (const entry of await fs.readdir(from))
        await copy(path.join(from, entry), path.join(to, entry), path.join(relative, entry))
      return
    }
    if (!stat.isFile()) return
    const exists = await fs
      .access(to)
      .then(() => true)
      .catch(() => false)
    if (exists) return void result.kept.push(relative)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
    result.copied.push(relative)
  }
  await copy(path.join(source, ".opencode"), path.join(target, ".opencode"), ".opencode")
  for (const file of ROOT_FILES) await copy(path.join(source, file), path.join(target, file), file)
  return result
}
