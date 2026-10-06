// The Tool Prompt tab's logic, without the page: what a tool's rules allow, and the tools of a real
// request's `tools` value in each provider's format.

export type Action = "allow" | "ask" | "deny"
export type RuleRow = { index: number; permission: string; pattern: string; action: Action }

// What a tool's rules (in evaluation order, the last match wins) mean when it is called: the action
// for every call, from the last rule whose pattern is `*` ("ask" when there is none, as OpenCode
// asks when nothing matches), then the exceptions after it, grouped by action in order. An exception
// with the same action as every call is left out unless an earlier exception made it matter.
export function accessOf(rows: ReadonlyArray<RuleRow>) {
  const at = rows.findLastIndex((row) => row.pattern === "*")
  const every: Action = at >= 0 ? rows[at]!.action : "ask"
  const exceptions: Array<{ action: Action; patterns: string[] }> = []
  let differs = false
  for (const row of rows.slice(at + 1)) {
    if (row.action !== every) differs = true
    if (row.action === every && !differs) continue
    const last = exceptions.at(-1)
    if (last?.action === row.action) last.patterns.push(row.pattern)
    else exceptions.push({ action: row.action, patterns: [row.pattern] })
  }
  return { every, exceptions }
}

// The rule that decides whether a tool is sent: the last rule for its permission.
export function decisiveOf(rows: ReadonlyArray<RuleRow>) {
  return rows.at(-1)
}

export type LastTool = { name: string; entry: unknown; chars: number }

// The tools of a recorded `tools` value, in the provider's format: Anthropic and OpenAI responses
// `[{ name, … }]`, OpenAI chat `[{ type: "function", function: { name, … } }]`, Google
// `[{ functionDeclarations: [{ name, … }] }]`. Each entry's size is its JSON as sent.
export function lastTools(text: string | undefined): LastTool[] {
  if (!text) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const size = (entry: unknown) => JSON.stringify(entry).length
  return value.flatMap((item): LastTool[] => {
    if (!item || typeof item !== "object") return []
    const record = item as Record<string, unknown>
    if (Array.isArray(record.functionDeclarations))
      return record.functionDeclarations.flatMap((entry) =>
        entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? [{ name: (entry as { name: string }).name, entry, chars: size(entry) }]
          : [],
      )
    const fn = record.function as { name?: unknown } | undefined
    if (fn && typeof fn.name === "string") return [{ name: fn.name, entry: item, chars: size(item) }]
    if (typeof record.name === "string") return [{ name: record.name, entry: item, chars: size(item) }]
    return []
  })
}

// Tools in one list and not the other, by name.
export function compareNames(would: ReadonlyArray<string>, last: ReadonlyArray<string>) {
  const sent = new Set(last)
  const built = new Set(would)
  return {
    onlyWould: would.filter((name) => !sent.has(name)),
    onlyLast: last.filter((name) => !built.has(name)),
  }
}

// JSON laid out for reading: indented, with the line breaks inside texts (a tool's description)
// shown as lines instead of `\n`. Not valid JSON; Raw shows the exact text.
export function readableJson(value: unknown, indent = ""): string {
  const next = `${indent}  `
  if (typeof value === "string") {
    if (!value.includes("\n")) return JSON.stringify(value)
    return `"${value.split("\n").join(`\n${next}`)}"`
  }
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    return `[\n${value.map((item) => next + readableJson(item, next)).join(",\n")}\n${indent}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
    if (!entries.length) return "{}"
    return `{\n${entries.map(([key, item]) => `${next}${JSON.stringify(key)}: ${readableJson(item, next)}`).join(",\n")}\n${indent}}`
  }
  return JSON.stringify(value) ?? "null"
}
