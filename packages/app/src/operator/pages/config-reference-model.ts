import type { OperatorConfigOption } from "@opencode-ai/sdk/v2/client"
import { compareText, searchItems } from "../ui/paged"

// The Config reference's logic (specs/docs/issues/003): where an option is set in the effective config, and the
// options grouped by top-level key, searched and filtered.

export type Filter = "all" | "set"

export type Found = { path: string; value: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Where an option is set in a config, with each value: `<…>` stands for any key, `name[]` for each item of a list. */
export function setIn(config: unknown, path: string): Found[] {
  const steps = path.split(".")
  const walk = (value: unknown, at: number, trail: string[]): Found[] => {
    if (at === steps.length) return value === undefined ? [] : [{ path: trail.join("."), value }]
    if (!isRecord(value)) return []
    const step = steps[at]!
    if (step.startsWith("<") && step.endsWith(">"))
      return Object.entries(value).flatMap(([key, item]) => walk(item, at + 1, [...trail, key]))
    if (step.endsWith("[]")) {
      const key = step.slice(0, -2)
      const list = value[key]
      if (!Array.isArray(list)) return []
      return list.flatMap((item, index) => walk(item, at + 1, [...trail, `${key}[${index}]`]))
    }
    return walk(value[step], at + 1, [...trail, step])
  }
  return walk(config, 0, [])
}

/** A value as one short line of JSON. */
export function shortValue(value: unknown, max = 160) {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type Group = { key: string; head?: OperatorConfigOption; options: OperatorConfigOption[] }

/** The options by top-level key (A→Z), each group's options A→Z: searched by path and description, then filtered. */
export function groupsOf(
  options: readonly OperatorConfigOption[],
  input: { query: string; filter: Filter; config: unknown },
): Group[] {
  const found = searchItems(options, input.query, (item) =>
    [item.path, item.description, item.deprecated ?? ""].join(" "),
  ).filter((item) => input.filter === "all" || setIn(input.config, item.path).length > 0)
  const groups = new Map<string, OperatorConfigOption[]>()
  for (const item of found) groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  const heads = new Map(options.filter((item) => item.path === item.group).map((item) => [item.group, item]))
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      head: heads.get(key),
      options: items.toSorted((a, b) => compareText(a.path, b.path)),
    }))
    .toSorted((a, b) => compareText(a.key, b.key))
}
