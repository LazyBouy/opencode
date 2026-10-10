export * as OperatorFileCache from "./file-cache"

import fs from "fs/promises"

// Files read on the hot paths (every permission ask, every model request): kept until they change. Each
// use checks the file first, with one stat (modification and change time in nanoseconds, size, inode),
// and reads it again only when that changed, so an edit made anywhere (a fork writer, a hand edit, a git
// checkout) shows on the next use. A missing file is remembered as missing, so one that appears is seen.
// What `json` returns is frozen and shared: callers must not change it (writers read the file themselves).

export type Stamp = string
export const ABSENT: Stamp = "absent"

/** What identifies a file's content now (or its absence): it changes whenever the file does. */
export async function stamp(file: string): Promise<Stamp> {
  return fs.stat(file, { bigint: true }).then(
    (info) => `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`,
    () => ABSENT,
  )
}

/** Many stamps at once, in order. */
export function stamps(files: ReadonlyArray<string>) {
  return Promise.all(files.map(stamp))
}

const LIMIT = 4000
const texts = new Map<string, { stamp: Stamp; text: string | undefined }>()
const parsed = new Map<string, { stamp: Stamp; value: unknown }>()
const listings = new Map<string, { stamp: Stamp; entries: ReadonlyArray<Entry> }>()

/** How many times a file was actually read or listed (tests check that a warm cache reads nothing). */
export const counts = { reads: 0 }

const remember = <V>(map: Map<string, V>, key: string, value: V) => {
  if (map.size >= LIMIT) map.clear()
  map.set(key, value)
}

/** A file's text, or undefined when it doesn't exist or can't be read. */
export async function text(file: string): Promise<string | undefined> {
  const now = await stamp(file)
  const found = texts.get(file)
  if (found && found.stamp === now) return found.text
  counts.reads++
  const value = now === ABSENT ? undefined : await fs.readFile(file, "utf8").catch(() => undefined)
  remember(texts, file, { stamp: now, text: value })
  return value
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}

/** A JSON file's value (frozen), or undefined when it doesn't exist or isn't JSON. */
export async function json(file: string): Promise<unknown> {
  const now = await stamp(file)
  const found = parsed.get(file)
  if (found && found.stamp === now) return found.value
  const raw = await text(file)
  let value: unknown
  try {
    value = raw === undefined ? undefined : freeze(JSON.parse(raw) as unknown)
  } catch {
    value = undefined
  }
  remember(parsed, file, { stamp: now, value })
  return value
}

export type Entry = { readonly name: string; readonly directory: boolean }

/** A folder's entries (empty when it doesn't exist): a new or removed entry changes the folder's stamp. */
export async function entries(dir: string): Promise<ReadonlyArray<Entry>> {
  const now = await stamp(dir)
  const found = listings.get(dir)
  if (found && found.stamp === now) return found.entries
  counts.reads++
  const value =
    now === ABSENT
      ? []
      : (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) =>
          Object.freeze({ name: entry.name, directory: entry.isDirectory() }),
        )
  remember(listings, dir, { stamp: now, entries: Object.freeze(value) })
  return value
}

/** Forgets what is kept for a file (a writer that can't trust timestamps), or everything. */
export function forget(file?: string) {
  if (file === undefined) {
    texts.clear()
    parsed.clear()
    listings.clear()
    return
  }
  texts.delete(file)
  parsed.delete(file)
  listings.delete(file)
}
