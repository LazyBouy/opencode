import os from "os"
import path from "path"
import { Effect, Option, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { MergeAdapter } from "../adapter"

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

export * as ClaudeSessions from "./sessions"
