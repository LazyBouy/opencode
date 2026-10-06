// Converts between the config's permission format and editable rows.
// Config: { bash: "ask", edit: { "*": "deny", "docs/**": "allow" } }. Rows keep that order; a
// permission whose only row is "*" is written back as a plain action.

export type Action = "allow" | "ask" | "deny"
export interface Rule {
  readonly permission: string
  readonly pattern: string
  readonly action: Action
}
export type PermissionConfig = Record<string, Action | Record<string, Action>>

const ACTIONS = new Set<unknown>(["allow", "ask", "deny"])

export function rulesFromConfig(config: unknown): Rule[] {
  if (!config || typeof config !== "object") return []
  return Object.entries(config).flatMap(([permission, value]) => {
    if (ACTIONS.has(value)) return [{ permission, pattern: "*", action: value as Action }]
    if (!value || typeof value !== "object") return []
    return Object.entries(value)
      .filter(([, action]) => ACTIONS.has(action))
      .map(([pattern, action]) => ({ permission, pattern, action: action as Action }))
  })
}

// Rules in config form: grouped by permission, in the order each permission first appears. A
// permission + pattern pair can be written once: a later rule with the same pair replaces the earlier
// one and takes its place after the rules in between (the last rule that matches wins, so the later
// one is the one that counted). The server's toConfig (operator/permission-rules.ts) does the same.
export function rulesToConfig(rules: readonly Rule[]): PermissionConfig {
  const groups = new Map<string, Map<string, Action>>()
  for (const rule of rules) {
    const permission = rule.permission.trim()
    if (!permission) continue
    const pattern = rule.pattern.trim() || "*"
    const group = groups.get(permission) ?? new Map<string, Action>()
    group.delete(pattern)
    group.set(pattern, rule.action)
    groups.set(permission, group)
  }
  return Object.fromEntries(
    [...groups].map(([permission, group]) => {
      const entries = [...group]
      return entries.length === 1 && entries[0]![0] === "*"
        ? [permission, entries[0]![1]]
        : [permission, Object.fromEntries(entries)]
    }),
  )
}

// OpenCode's wildcard match (core/util/wildcard.ts): `*` is anything, `?` one character, and a
// trailing " *" also matches nothing after it.
export function wildcard(input: string, pattern: string) {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(input.replaceAll("\\", "/"))
}

const pairOf = (rule: Rule) => `${rule.permission.trim()}\n${rule.pattern.trim() || "*"}`

// What saving these rules in config form does to their order: pairs written twice (the later
// replaces the earlier), the order they are saved in, and the rules whose order against another rule
// that can match the same call (with a different action) flips, so what they decide can change.
// Indexes are positions in `rules`.
export function orderCheck(rules: readonly Rule[]) {
  const duplicates: Array<{ earlier: number; later: number }> = []
  const seen = new Map<string, number>()
  rules.forEach((rule, index) => {
    const found = seen.get(pairOf(rule))
    if (found !== undefined) duplicates.push({ earlier: found, later: index })
    seen.set(pairOf(rule), index)
  })
  const saved = rulesFromConfig(rulesToConfig(rules))
  const position = (rule: Rule) =>
    saved.findIndex((item) => pairOf(item) === pairOf(rule) && item.action === rule.action)
  const overlaps = (a: string, b: string) => wildcard(a, b) || wildcard(b, a)
  const patterns = (a: string, b: string) => a === b || /[*?]/.test(a) || /[*?]/.test(b)
  const changed = new Set<number>()
  rules.forEach((a, i) =>
    rules.forEach((b, j) => {
      if (j <= i || a.action === b.action) return
      if (!overlaps(a.permission.trim(), b.permission.trim()) || !patterns(a.pattern, b.pattern)) return
      const pa = position(a)
      const pb = position(b)
      if (pa < 0 || pb < 0 || pa < pb) return
      changed.add(i)
      changed.add(j)
    }),
  )
  return { duplicates, changed: [...changed].sort((a, b) => a - b), saved }
}

// The pattern a permission is asked with (from the server: path, absolute, command, search, url,
// query, agent, skill, tool, any).
export type PatternForm = string

// A rule whose pattern can't match the way its permission is asked: an absolute pattern on a
// permission asked with paths relative to the project (read, edit), a relative one on
// external_directory (asked with absolute folders), or anything but `*` on a permission always asked
// with `*` (todowrite, lsp, MCP tools).
export function hintOf(rule: Rule, forms: Readonly<Record<string, PatternForm>>) {
  const form = forms[rule.permission.trim()]
  const pattern = rule.pattern.trim() || "*"
  const absolute = /^(\/|~|\$HOME|[a-zA-Z]:[\\/])/.test(pattern)
  if (form === "path" && absolute) return "absolute" as const
  if (form === "absolute" && !absolute && !pattern.startsWith("*")) return "relative" as const
  if (form === "any" && !wildcard("*", pattern)) return "any" as const
  return undefined
}
