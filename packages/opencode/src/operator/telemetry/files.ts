export * as OperatorTelemetryFiles from "./files"

import fs from "fs/promises"
import path from "path"
import { OperatorTrashFiles } from "../trash-files"

// Observability's records kept as one JSON file each (alert rules, saved views): deleting one moves its file to Trash
// and restoring it moves the file back, like the console's other records. Reads are cached until the folder changes,
// its time or its files: every write here is a rename into it, and a restore from Trash moves a file in (a file
// moved in or out shows even within one clock tick).

export type Folder<T extends { id: string }> = {
  readonly dir: () => string
  readonly list: () => Promise<T[]>
  readonly write: (record: T) => Promise<T>
  readonly trash: (
    record: T,
    input: { kind: OperatorTrashFiles.Kind; name: string },
  ) => Promise<OperatorTrashFiles.Entry>
  readonly remove: (id: string) => Promise<void>
}

export function folder<T extends { id: string }>(dir: () => string, valid: (value: unknown) => value is T): Folder<T> {
  let cache: { key: string; records: T[] } | undefined
  const fileOf = (id: string) => path.join(dir(), `${id}.json`)
  const list = async () => {
    const stat = await fs.stat(dir()).catch(() => undefined)
    if (!stat) return []
    const names = (await fs.readdir(dir()).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort()
    const key = `${stat.mtimeMs}:${names.join("/")}`
    if (cache?.key === key) return cache.records
    const records: T[] = []
    for (const name of names) {
      const value = await Bun.file(path.join(dir(), name))
        .json()
        .catch(() => undefined)
      if (valid(value) && `${value.id}.json` === name) records.push(value)
    }
    cache = { key, records }
    return records
  }
  return {
    dir,
    list,
    // Atomic: written beside, then renamed into the folder.
    write: async (record) => {
      await fs.mkdir(dir(), { recursive: true })
      const temporary = path.join(dir(), `.${record.id}.${Math.random().toString(36).slice(2, 8)}.tmp`)
      await Bun.write(temporary, JSON.stringify(record, null, 2))
      await fs.rename(temporary, fileOf(record.id))
      cache = undefined
      return record
    },
    trash: async (record, input) => {
      const entry = await OperatorTrashFiles.put({ kind: input.kind, name: input.name, paths: [fileOf(record.id)] })
      cache = undefined
      return entry
    },
    remove: async (id) => {
      await fs.rm(fileOf(id), { force: true })
      cache = undefined
    },
  }
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
