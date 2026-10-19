export * as OperatorTelemetryAlertRules from "./alert-rules"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorTrashFiles } from "../trash-files"
import { OperatorTelemetryAlerts as A } from "./alerts"

// Alert rules (observability_spec.md §14.1, §14.3) as one JSON file each, in `<data>/operator/alert-rules/`, so
// deleting a rule moves its file to Trash and restoring it moves the file back, like the console's other records.
// Built-in rules live in code; editing one writes its file, and Reset removes it. Reads are cached until the folder
// changes (its time or its files): every write here is a rename into it, and a restore from Trash moves a file in.

export const dir = () => path.join(Global.Path.data, "operator", "alert-rules")
const fileOf = (id: string) => path.join(dir(), `${id}.json`)

let cache: { key: string; rules: A.Rule[] } | undefined

const valid = (value: unknown): value is A.Rule => {
  const rule = value as Partial<A.Rule> | undefined
  return (
    !!rule &&
    typeof rule.id === "string" &&
    typeof rule.name === "string" &&
    (A.METRICS as ReadonlyArray<string>).includes(rule.metric as string) &&
    (A.OPS as ReadonlyArray<string>).includes(rule.op as string) &&
    typeof rule.threshold === "number"
  )
}

/** The rules stored as files: the user's, and the built-ins someone edited. */
async function stored(): Promise<A.Rule[]> {
  const stat = await fs.stat(dir()).catch(() => undefined)
  if (!stat) return []
  // The folder's time and its files: a file moved in or out (a restore from Trash) shows even within one clock tick.
  const names = (await fs.readdir(dir()).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort()
  const key = `${stat.mtimeMs}:${names.join("/")}`
  if (cache?.key === key) return cache.rules
  const rules: A.Rule[] = []
  for (const name of names) {
    const value = await Bun.file(path.join(dir(), name))
      .json()
      .catch(() => undefined)
    if (valid(value) && `${value.id}.json` === name) rules.push(value)
  }
  cache = { key, rules }
  return rules
}

/** Every rule: the built-ins (with their edits), then the user's, oldest first. */
export async function list(budget: number | undefined): Promise<A.Rule[]> {
  const found = await stored()
  const byId = new Map(found.map((rule) => [rule.id, rule]))
  const builtins = A.builtins(budget).map((rule): A.Rule => {
    const id = `${A.BUILTIN_PREFIX}${rule.builtin}`
    const edited = byId.get(id)
    return edited ? { ...edited, id, builtin: rule.builtin } : { ...rule, id, createdAt: 0, updatedAt: 0 }
  })
  const users = found
    .filter((rule) => !rule.id.startsWith(A.BUILTIN_PREFIX))
    .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return [...builtins, ...users]
}

export async function get(id: string, budget: number | undefined) {
  return (await list(budget)).find((rule) => rule.id === id)
}

/** Writes a rule's file, atomically (a rename into the folder). */
export async function write(rule: A.Rule) {
  await fs.mkdir(dir(), { recursive: true })
  const temporary = path.join(dir(), `.${rule.id}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await Bun.write(temporary, JSON.stringify(rule, null, 2))
  await fs.rename(temporary, fileOf(rule.id))
  cache = undefined
  return rule
}

export const newId = () => `rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Moves a user rule's file to Trash. */
export async function trash(rule: A.Rule) {
  const entry = await OperatorTrashFiles.put({ kind: "alert-rule", name: rule.name, paths: [fileOf(rule.id)] })
  cache = undefined
  return entry
}

/** A built-in rule back to its defaults: its file goes. */
export async function reset(id: string) {
  await fs.rm(fileOf(id), { force: true })
  cache = undefined
}
