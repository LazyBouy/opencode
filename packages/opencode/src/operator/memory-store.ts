export * as OperatorMemoryStore from "./memory-store"

import fs from "fs/promises"
import path from "path"
import { OperatorMemoryFolders } from "./memory-folders"
import { OperatorMemoryFormat as M } from "./memory-format"

// Reading and writing one `.memory` folder (specs/docs/feedbacks/memory/memory_spec.md §3, §5): the same
// code for the memory tool and the Memory page. Writes are atomic (a temporary file, then a rename), and
// one lock per folder keeps two sessions saving at once from breaking `MEMORY.md`. The index stays
// valid: its grammar, the limits, unique file names; lines that are not entries are kept as they are.

export class MemoryError extends Error {}

const locks = new Map<string, Promise<unknown>>()
function locked<T>(folder: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(folder)
  const next = (locks.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

async function writeAtomic(file: string, text: string) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await Bun.write(temporary, text)
  await fs.rename(temporary, file)
}

const indexFile = (folder: string) => path.join(folder, M.INDEX)
const readText = (file: string) => fs.readFile(file, "utf8").catch(() => undefined)

export type Listed = M.Index & { readonly folder: string; readonly exists: boolean; readonly text: string }

/** A folder's index: its entries and the lines that are not entries. A missing folder has none. */
export async function list(folder: string): Promise<Listed> {
  const text = await readText(indexFile(folder))
  return { ...M.parseIndex(text ?? ""), folder, exists: text !== undefined, text: text ?? "" }
}

function fileOf(file: string) {
  if (!M.isFileName(file)) throw new MemoryError(`"${file}" is not a memory file name (like release-checklist.md)`)
  return file
}

/** One memory's detailed file. */
export async function read(folder: string, file: string) {
  const where = path.join(folder, fileOf(file))
  const text = await readText(where)
  if (text === undefined) throw new MemoryError(`No memory ${file} in ${folder}`)
  return { path: where, text, detail: M.parseDetail(text) }
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

function checked(input: { title: string; description: string }) {
  const found = M.checkEntry(input)
  if ("reason" in found) throw new MemoryError(found.reason)
  return found
}
function content(text: string) {
  if (text.length > M.MAX_CONTENT) throw new MemoryError(`A memory is at most ${M.MAX_CONTENT} characters`)
  return text
}

// The index with one entry's line set (replaced where it is, else added at the end).
function withLine(text: string, file: string, line: string | undefined) {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n")
  const at = lines.findIndex((item) => M.parseIndex(item).entries[0]?.file === file)
  if (line === undefined) {
    if (at >= 0) lines.splice(at, 1)
  } else if (at >= 0) lines[at] = line
  else lines.push(line)
  return lines.length ? `${lines.join("\n")}\n` : ""
}

export type Saved = { readonly path: string; readonly file: string; readonly line: string; readonly before?: string }

/** Saves a new memory: its file (a unique slug of its title) and its index line. */
export function save(input: {
  folder: string
  project: string
  level: OperatorMemoryFolders.Level
  title: string
  description: string
  content: string
  by: string
}): Promise<Saved> {
  const entry = checked(input)
  const body = content(input.content)
  return locked(input.folder, async () => {
    await OperatorMemoryFolders.ensure(input.folder, input.project)
    const index = await list(input.folder)
    const files = await fs.readdir(input.folder).catch(() => [] as string[])
    const file = M.fileFor(
      entry.title,
      new Set([...files.map((item) => item.toLowerCase()), ...index.entries.map((item) => item.file)]),
    )
    const stamp = now()
    const where = path.join(input.folder, file)
    await writeAtomic(
      where,
      M.renderDetail({ ...entry, level: input.level, created: stamp, updated: stamp, by: input.by, content: body }),
    )
    const line = M.formatLine({ ...entry, file })
    await writeAtomic(indexFile(input.folder), withLine(index.text, file, line))
    return { path: where, file, line }
  })
}

/** Changes a memory: its file and its index line; `updated` is set. */
export function update(input: {
  folder: string
  project: string
  level: OperatorMemoryFolders.Level
  file: string
  title?: string
  description?: string
  content?: string
  by: string
}): Promise<Saved> {
  const file = fileOf(input.file)
  return locked(input.folder, async () => {
    const found = await read(input.folder, file)
    const index = await list(input.folder)
    const listed = index.entries.find((item) => item.file === file)
    const entry = checked({
      title: input.title ?? found.detail.title ?? listed?.title ?? "",
      description: input.description ?? found.detail.description ?? listed?.description ?? "",
    })
    const body = content(input.content ?? found.detail.content)
    await OperatorMemoryFolders.ensure(input.folder, input.project)
    await writeAtomic(
      found.path,
      M.renderDetail({
        ...entry,
        level: input.level,
        created: found.detail.created ?? now(),
        updated: now(),
        by: input.by,
        content: body,
      }),
    )
    const line = M.formatLine({ ...entry, file })
    await writeAtomic(indexFile(input.folder), withLine(index.text, file, line))
    return { path: found.path, file, line, before: found.text }
  })
}

/** Forgets a memory: its index line goes, and its file is handed to `trash` (restorable). */
export function forget(input: { folder: string; file: string; trash: (file: string) => Promise<unknown> }) {
  const file = fileOf(input.file)
  return locked(input.folder, async () => {
    const found = await read(input.folder, file)
    const index = await list(input.folder)
    const listed = index.entries.find((item) => item.file === file)
    await input.trash(found.path)
    await writeAtomic(indexFile(input.folder), withLine(index.text, file, undefined))
    return { path: found.path, file, line: listed ? M.formatLine(listed) : undefined }
  })
}

/** Writes the index as text (the Memory page's hand fix): lines that are not entries are kept, and flagged. */
export function writeIndex(input: { folder: string; project: string; text: string }) {
  return locked(input.folder, async () => {
    await OperatorMemoryFolders.ensure(input.folder, input.project)
    const text = input.text === "" || input.text.endsWith("\n") ? input.text : `${input.text}\n`
    await writeAtomic(indexFile(input.folder), text)
    return list(input.folder)
  })
}
