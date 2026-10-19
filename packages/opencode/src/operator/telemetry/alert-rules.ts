export * as OperatorTelemetryAlertRules from "./alert-rules"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorTelemetryAlerts as A } from "./alerts"
import { OperatorTelemetryFiles } from "./files"

// Alert rules (observability_spec.md §14.1, §14.3) as one JSON file each, in `<data>/operator/alert-rules/` (files.ts:
// deleting a rule moves its file to Trash, restoring it moves the file back). Built-in rules live in code; editing one
// writes its file, and Reset removes it.

export const dir = () => path.join(Global.Path.data, "operator", "alert-rules")

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

const files = OperatorTelemetryFiles.folder(dir, valid)

/** Every rule: the built-ins (with their edits), then the user's, oldest first. */
export async function list(budget: number | undefined): Promise<A.Rule[]> {
  const found = await files.list()
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

export const write = (rule: A.Rule) => files.write(rule)
export const newId = () => OperatorTelemetryFiles.newId("rule")
/** Moves a user rule's file to Trash. */
export const trash = (rule: A.Rule) => files.trash(rule, { kind: "alert-rule", name: rule.name })
/** A built-in rule back to its defaults: its file goes. */
export const reset = (id: string) => files.remove(id)
