import os from "os"
import path from "path"
import { Effect, Option, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { MergeAdapter } from "../adapter"

// Claude stores each session as `<config>/projects/<slug(cwd)>/<session-id>.jsonl`, where the slug
// replaces every non-alphanumeric character with "-". Slugs longer than 200 characters are cut and
// suffixed with a hash, so those directories are matched by prefix. Only transcript metadata is
// read here; Claude's credential files are never opened.

const MAX_SLUG = 200
const HEAD_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isID(value: string) {
  return UUID.test(value)
}

export function configDir(env: MergeAdapter.Env) {
  return env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? os.homedir(), ".claude")
}

export function slug(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

// The folder name Claude Code (2.1.123, its `SM`) gives a working folder under `projects/`: the slug, or,
// over 200 characters, the slug cut and suffixed with a hash of the folder in base 36.
export function folderName(cwd: string) {
  const name = slug(cwd)
  if (name.length <= MAX_SLUG) return name
  let hash = 0
  for (let index = 0; index < cwd.length; index++) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0
  return `${name.slice(0, MAX_SLUG)}-${Math.abs(hash).toString(36)}`
}

export const projectDirs = Effect.fnUntraced(function* (fs: FSUtil.Interface, cwd: string, env: MergeAdapter.Env) {
  const root = path.join(configDir(env), "projects")
  const name = slug(cwd)
  if (name.length <= MAX_SLUG) return [path.join(root, name)]
  const prefix = name.slice(0, MAX_SLUG) + "-"
  const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => []))
  return entries
    .filter((entry) => entry.type === "directory" && entry.name.startsWith(prefix))
    .map((entry) => path.join(root, entry.name))
})

export const exists = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  cwd: string,
  id: string,
  env: MergeAdapter.Env,
) {
  if (!isID(id)) return false
  const dirs = yield* projectDirs(fs, cwd, env)
  const found = yield* Effect.forEach(dirs, (dir) => fs.isFile(path.join(dir, `${id}.jsonl`)))
  return found.some(Boolean)
})

export const list = Effect.fnUntraced(function* (fs: FSUtil.Interface, cwd: string, env: MergeAdapter.Env) {
  const dirs = yield* projectDirs(fs, cwd, env)
  const files = yield* Effect.forEach(dirs, (dir) =>
    fs.readDirectoryEntries(dir).pipe(
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.type === "file" && entry.name.endsWith(".jsonl") && isID(entry.name.slice(0, -6)))
          .map((entry) => path.join(dir, entry.name)),
      ),
      Effect.orElseSucceed(() => [] as string[]),
    ),
  )
  const sessions = yield* Effect.forEach(files.flat(), (file) => describe(fs, file), { concurrency: 8 })
  return sessions.filter((item) => item !== undefined).toSorted((a, b) => b.modified - a.modified)
})

const parseLine = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const describe = Effect.fnUntraced(function* (fs: FSUtil.Interface, file: string) {
  const info = yield* fs.stat(file).pipe(Effect.option)
  if (Option.isNone(info)) return undefined
  const head = yield* Effect.scoped(
    fs.open(file, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.readAlloc(HEAD_BYTES))),
  ).pipe(Effect.option)
  const text = Option.isSome(head) && Option.isSome(head.value) ? new TextDecoder().decode(head.value.value) : ""
  const lines = text
    .split("\n")
    .flatMap((line) => Option.toArray(parseLine(line)))
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
  const title = lines.find((line) => line.type === "ai-title" || line.type === "summary")
  const branch = lines.find((line) => typeof line.gitBranch === "string")?.gitBranch
  return {
    id: path.basename(file, ".jsonl"),
    modified: Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0,
    title:
      typeof title?.aiTitle === "string"
        ? title.aiTitle
        : typeof title?.summary === "string"
          ? title.summary
          : undefined,
    preview: lines.map(firstUserText).find((value) => value !== undefined),
    branch: typeof branch === "string" ? branch : undefined,
  } satisfies MergeAdapter.ExternalSession
})

function firstUserText(line: Record<string, unknown>) {
  if (line.type !== "user" || typeof line.message !== "object" || line.message === null) return undefined
  const content = "content" in line.message ? line.message.content : undefined
  if (typeof content === "string") return content.slice(0, 120)
  if (!Array.isArray(content)) return undefined
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string",
  )
  return text?.text.slice(0, 120)
}

// Moving a folder (operator/layout-move.ts): Claude Code finds a session only in the `projects/` folder of
// the working folder it resumes in, so the folders of sessions that ran in the moved folder or below it
// are renamed to the new folders' names, and the `cwd` each transcript line records is rewritten (Claude's
// session picker compares it with where it runs). Message contents keep the old paths: they are history.
// Which folder a `projects/` entry belongs to is read from its transcripts' `cwd`, since names are lossy
// (`/a/b-c` and `/a/b/c` share one); an entry without transcripts follows only when its name is exactly
// the moved folder's.

const inside = (folder: string, file: string) => file === folder || file.startsWith(folder + path.sep)
const swap = (file: string, from: string, to: string) => (inside(from, file) ? to + file.slice(from.length) : undefined)

// A folder's transcripts: its sessions' `.jsonl` files and their subagents' (`<id>/subagents/*.jsonl`).
const transcripts = (fs: FSUtil.Interface, dir: string, depth = 0): Effect.Effect<string[]> =>
  fs.readDirectoryEntries(dir).pipe(
    Effect.orElseSucceed(() => [] as FSUtil.DirEntry[]),
    Effect.flatMap((entries) =>
      Effect.forEach(entries, (entry) => {
        const file = path.join(dir, entry.name)
        if (entry.type === "file" && entry.name.endsWith(".jsonl")) return Effect.succeed([file])
        if (entry.type === "directory" && depth < 2) return transcripts(fs, file, depth + 1)
        return Effect.succeed([] as string[])
      }),
    ),
    Effect.map((found) => found.flat()),
  )

// The working folder a `projects/` entry's sessions ran in, from the first transcript line that records one.
const recordedCwd = Effect.fnUntraced(function* (fs: FSUtil.Interface, dir: string) {
  for (const file of (yield* transcripts(fs, dir)).toSorted()) {
    const head = yield* Effect.scoped(
      fs.open(file, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.readAlloc(HEAD_BYTES))),
    ).pipe(Effect.option)
    const text = Option.isSome(head) && Option.isSome(head.value) ? new TextDecoder().decode(head.value.value) : ""
    for (const line of text.split("\n")) {
      const value = Option.getOrUndefined(parseLine(line))
      if (typeof value === "object" && value !== null && "cwd" in value && typeof value.cwd === "string")
        return value.cwd
    }
  }
  return undefined
})

// The `projects/` entries of sessions that ran in `from` or below it, with the folder each ran in.
const entriesUnder = Effect.fnUntraced(function* (fs: FSUtil.Interface, from: string, env: MergeAdapter.Env) {
  const root = path.join(configDir(env), "projects")
  const prefix = slug(from).slice(0, MAX_SLUG)
  const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => [] as FSUtil.DirEntry[]))
  const found: Array<{ dir: string; cwd: string }> = []
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.type !== "directory" || !entry.name.startsWith(prefix)) continue
    const dir = path.join(root, entry.name)
    const cwd = yield* recordedCwd(fs, dir)
    if (cwd ? inside(from, cwd) : entry.name === folderName(from)) found.push({ dir, cwd: cwd ?? from })
  }
  return { root, found }
})

// Each transcript line's `cwd`, moved; other lines and fields are kept as they are.
function rewriteCwd(text: string, from: string, to: string) {
  let changed = false
  const lines = text.split("\n").map((line) => {
    if (!line.includes('"cwd"')) return line
    const value = Option.getOrUndefined(parseLine(line))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return line
    const cwd = (value as { cwd?: unknown }).cwd
    const next = typeof cwd === "string" ? swap(cwd, from, to) : undefined
    if (next === undefined || next === cwd) return line
    changed = true
    return JSON.stringify({ ...value, cwd: next })
  })
  return changed ? lines.join("\n") : undefined
}

const failed = (message: string) => new MergeAdapter.RelocateFailed({ adapter: "claude", message })
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function relocator(fs: FSUtil.Interface): MergeAdapter.Relocator {
  const rewriteFile = (file: string, from: string, to: string) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(file)
      const next = rewriteCwd(text, from, to)
      if (next === undefined) return false
      yield* fs.writeFileString(`${file}.relocate`, next)
      yield* fs.rename(`${file}.relocate`, file)
      return true
    })

  const restore = (done: MergeAdapter.Relocation, from: string, to: string) =>
    Effect.gen(function* () {
      for (const file of done.rewritten) yield* rewriteFile(file, to, from).pipe(Effect.ignore)
      for (const item of done.renames.toReversed()) {
        if (!(yield* fs.exists(item.to).pipe(Effect.orElseSucceed(() => false)))) continue
        if (yield* fs.exists(item.from).pipe(Effect.orElseSucceed(() => true))) continue
        yield* fs.rename(item.to, item.from).pipe(Effect.ignore)
      }
    })

  return {
    check: (from, env) =>
      Effect.gen(function* () {
        const { root, found } = yield* entriesUnder(fs, from, env)
        if (!found.length) return { root, folders: 0 }
        const writable = yield* fs.access(root, { writable: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        return {
          root,
          folders: found.length,
          ...(writable
            ? {}
            : {
                problem: `Claude Code's sessions for it are in ${root}, which can't be written: they wouldn't follow`,
              }),
        }
      }),
    move: (from, to, env) => {
      const renames: Array<{ from: string; to: string }> = []
      const rewritten: string[] = []
      return Effect.gen(function* () {
        const { root, found } = yield* entriesUnder(fs, from, env)
        for (const item of found) {
          const target = path.join(root, folderName(to + item.cwd.slice(from.length)))
          if (target === item.dir) continue
          // A folder already there (an earlier session in the new place): what isn't there joins it.
          const moved: string[] = []
          if (!(yield* fs.exists(target))) {
            yield* fs.rename(item.dir, target)
            renames.push({ from: item.dir, to: target })
            moved.push(target)
          } else
            for (const entry of yield* fs.readDirectoryEntries(item.dir)) {
              const destination = path.join(target, entry.name)
              if (yield* fs.exists(destination)) continue
              yield* fs.rename(path.join(item.dir, entry.name), destination)
              renames.push({ from: path.join(item.dir, entry.name), to: destination })
              moved.push(destination)
            }
          for (const place of moved) {
            const files = place.endsWith(".jsonl") ? [place] : yield* transcripts(fs, place)
            for (const file of files) if (yield* rewriteFile(file, from, to)) rewritten.push(file)
          }
        }
        return { adapter: "claude", renames, rewritten } satisfies MergeAdapter.Relocation
      }).pipe(
        Effect.catch((error) =>
          restore({ adapter: "claude", renames, rewritten }, from, to).pipe(
            Effect.andThen(Effect.fail(failed(describeError(error)))),
          ),
        ),
      )
    },
    restore,
  }
}

export * as ClaudeSessions from "./sessions"
