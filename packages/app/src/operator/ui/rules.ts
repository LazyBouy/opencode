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

export function rulesToConfig(rules: readonly Rule[]): PermissionConfig {
  const groups = new Map<string, Rule[]>()
  for (const rule of rules) {
    const permission = rule.permission.trim()
    if (!permission) continue
    groups.set(permission, [
      ...(groups.get(permission) ?? []),
      { ...rule, permission, pattern: rule.pattern.trim() || "*" },
    ])
  }
  return Object.fromEntries(
    [...groups].map(([permission, items]) =>
      items.length === 1 && items[0].pattern === "*"
        ? [permission, items[0].action]
        : [permission, Object.fromEntries(items.map((item) => [item.pattern, item.action]))],
    ),
  )
}
