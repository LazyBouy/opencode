export * as OperatorConfigReference from "./config-reference"

import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigForkV1 } from "@opencode-ai/core/v1/config/fork"
import { OperatorConfigTexts } from "./config-texts"

// The Config page's reference (specs/docs/issues/003): every option OpenCode's config accepts, built from the config
// schema itself (ConfigV1.Info, the fork's keys included), so options upstream adds later appear on their own. Each
// option has its path (`provider.<id>.options.baseURL`), type and allowed values, default, description, an example
// and its status (deprecated, the fork's). Descriptions are the schema's; where it has none, the fork's
// (config-texts.ts), keyed by path. A test fails for an option with neither.

export const Entry = Schema.Struct({
  path: Schema.String.annotate({ description: "The option's full path; <…> is a key of your choosing" }),
  group: Schema.String.annotate({ description: "Its top-level key" }),
  type: Schema.String.annotate({ description: "Its type in words: string, number, boolean, object, list of …" }),
  values: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "The values it allows" }),
  default: Schema.optional(Schema.String).annotate({ description: "Its default, as JSON" }),
  description: Schema.String,
  example: Schema.String.annotate({ description: "A short JSONC snippet" }),
  deprecated: Schema.optional(Schema.String).annotate({ description: "Deprecated: what replaces it" }),
  fork: Schema.optional(Schema.Boolean).annotate({ description: "The console's own key (fork.ts)" }),
  docs: Schema.optional(Schema.String).annotate({ description: "OpenCode's documentation for its section" }),
}).annotate({ identifier: "OperatorConfigOption" })
export type Entry = typeof Entry.Type

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value)

// What a key of a map is called in a path, by the map's own key.
const KEY_NAMES: Record<string, string> = {
  provider: "<id>",
  models: "<model>",
  agent: "<name>",
  mode: "<name>",
  mcp: "<name>",
  command: "<name>",
  lsp: "<language>",
  formatter: "<name>",
  permission: "<tool>",
  references: "<name>",
  reference: "<name>",
  variants: "<variant>",
  headers: "<header>",
  environment: "<variable>",
  env: "<variable>",
  options: "<option>",
}

// OpenCode's documentation, by top-level key.
const DOCS: Record<string, string> = {
  agent: "https://opencode.ai/docs/agents",
  command: "https://opencode.ai/docs/commands",
  formatter: "https://opencode.ai/docs/formatters",
  lsp: "https://opencode.ai/docs/lsp",
  mcp: "https://opencode.ai/docs/mcp-servers",
  permission: "https://opencode.ai/docs/permissions",
  provider: "https://opencode.ai/docs/providers",
  model: "https://opencode.ai/docs/models",
  small_model: "https://opencode.ai/docs/models",
  share: "https://opencode.ai/docs/share",
  server: "https://opencode.ai/docs/server",
  tools: "https://opencode.ai/docs/tools",
  instructions: "https://opencode.ai/docs/rules",
  plugin: "https://opencode.ai/docs/plugins",
  keybinds: "https://opencode.ai/docs/keybinds",
  theme: "https://opencode.ai/docs/themes",
}

const FORK_TOP = new Set(Object.keys(ConfigForkV1.fields))
const FORK_AGENT = new Set(Object.keys(ConfigForkV1.agentFields))

function document() {
  const made = Schema.toJsonSchemaDocument(ConfigV1.Info)
  return { root: made.schema as Json, defs: (made.definitions ?? {}) as Record<string, Json> }
}

// A schema with its references followed and its null branch dropped.
function resolve(schema: unknown, defs: Record<string, Json>, seen: ReadonlySet<string>): Json | undefined {
  if (!isRecord(schema)) return undefined
  const ref = typeof schema.$ref === "string" ? schema.$ref.split("/").at(-1) : undefined
  if (ref) {
    if (seen.has(ref)) return undefined
    const target = defs[ref]
    if (!target) return undefined
    const { $ref: _, ...rest } = schema
    return resolve({ ...target, ...rest }, defs, new Set([...seen, ref]))
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    const { allOf, ...rest } = schema
    return resolve({ ...(allOf[0] as Json), ...rest }, defs, seen)
  }
  return schema
}

const branches = (schema: Json) =>
  (Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : [schema]).filter(
    (item) => !(isRecord(item) && item.type === "null"),
  )

function typeOf(schema: Json, defs: Record<string, Json>, seen: ReadonlySet<string>): string {
  const parts = branches(schema).map((branch) => {
    const item = resolve(branch, defs, seen)
    if (!item) return "object"
    if (Array.isArray(item.enum) || item.const !== undefined) return "value"
    if (item.type === "array") {
      const inner = resolve(item.items, defs, seen)
      return `list of ${inner ? typeOf(inner, defs, seen) : "values"}`
    }
    if (typeof item.type === "string") return item.type === "integer" ? "number" : item.type
    if (item.properties || item.additionalProperties) return "object"
    return "any"
  })
  return [...new Set(parts)].join(" or ")
}

function valuesOf(schema: Json, defs: Record<string, Json>, seen: ReadonlySet<string>) {
  const values = branches(schema).flatMap((branch) => {
    const item = resolve(branch, defs, seen)
    if (!item) return []
    if (Array.isArray(item.enum)) return item.enum.map((value) => JSON.stringify(value))
    if (item.const !== undefined) return [JSON.stringify(item.const)]
    return []
  })
  return values.length ? [...new Set(values)] : undefined
}

function exampleOf(path: string, type: string, values: ReadonlyArray<string> | undefined) {
  const value = values?.[0]
    ? values[0]
    : type.startsWith("list of")
      ? "[]"
      : type.startsWith("boolean")
        ? "true"
        : type.startsWith("number")
          ? "1"
          : type.startsWith("string")
            ? '"…"'
            : "{}"
  const keys = path.split(".")
  return keys.reduceRight((inner, key, at) => {
    const pad = "  ".repeat(at + 1)
    return `{\n${pad}${JSON.stringify(key)}: ${inner}\n${"  ".repeat(at)}}`
  }, value)
}

/** Every option of the config schema, by path; descriptions from the schema, else the fork's texts. */
export function entries(): Entry[] {
  const { root, defs } = document()
  const found = new Map<string, Entry>()
  const walk = (schema: Json, path: string[], seen: ReadonlySet<string>, depth: number, forkAgent: boolean) => {
    if (depth > 8) return
    for (const branch of branches(schema)) {
      const item = resolve(branch, defs, seen)
      if (!item) continue
      const properties = isRecord(item.properties) ? item.properties : {}
      for (const [key, child] of Object.entries(properties)) visit(child, [...path, key], seen, depth, forkAgent)
      const rest = isRecord(item.additionalProperties) ? item.additionalProperties : undefined
      if (rest) visit(rest, [...path, KEY_NAMES[path.at(-1) ?? ""] ?? "<name>"], seen, depth, forkAgent)
      if (item.type === "array" && isRecord(item.items)) {
        const inner = resolve(item.items, defs, seen)
        if (inner && (inner.properties || branches(inner).some((b) => isRecord(resolve(b, defs, seen)?.properties))))
          walk(inner, [...path.slice(0, -1), `${path.at(-1)}[]`], seen, depth + 1, forkAgent)
      }
    }
  }
  const visit = (raw: unknown, path: string[], seen: ReadonlySet<string>, depth: number, forkAgent: boolean) => {
    const schema = resolve(raw, defs, seen)
    if (!schema) return
    const key = path.join(".")
    const isAgent = path.length >= 3 && (path[0] === "agent" || path[0] === "mode")
    const fork =
      (path.length === 1 && FORK_TOP.has(path[0]!)) || (isAgent && path.length === 3 && FORK_AGENT.has(path[2]!))
    const own = typeof schema.description === "string" ? schema.description : undefined
    const branchText = branches(schema)
      .map((branch) => resolve(branch, defs, seen)?.description)
      .find((text): text is string => typeof text === "string")
    const raw_ = own ?? branchText ?? OperatorConfigTexts.TEXTS[key] ?? ""
    const deprecated = raw_.startsWith("@deprecated") ? raw_.slice("@deprecated".length).trim() : undefined
    const type = typeOf(schema, defs, seen)
    const values = valuesOf(schema, defs, seen)
    if (!found.has(key))
      found.set(key, {
        path: key,
        group: path[0]!,
        type,
        ...(values ? { values } : {}),
        ...(schema.default !== undefined ? { default: JSON.stringify(schema.default) } : {}),
        description: deprecated ?? raw_,
        example: exampleOf(key, type, values),
        ...(deprecated !== undefined ? { deprecated: deprecated || "deprecated" } : {}),
        ...(fork || forkAgent ? { fork: true } : {}),
        ...(DOCS[path[0]!] ? { docs: DOCS[path[0]!] } : {}),
      })
    walk(schema, path, seen, depth + 1, forkAgent || fork)
  }
  walk(root, [], new Set(), 0, false)
  // An option of a built-in agent (`agent.build.model`) or a legacy mode reads as any agent's (`agent.<name>.model`).
  for (const entry of found.values()) {
    if (entry.description) continue
    const generic = genericPath(entry.path)
    const text = generic ? (found.get(generic)?.description ?? OperatorConfigTexts.TEXTS[generic]) : undefined
    if (text) found.set(entry.path, { ...entry, description: text })
  }
  return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}

// The same option elsewhere: `agent.build.x`, `mode.plan.x` and `mode.<name>.x` read as `agent.<name>.x`, and the
// deprecated `reference.*` as `references.*`.
function genericPath(path: string) {
  const [top, name, ...rest] = path.split(".")
  if (top === "reference") return ["references", ...(name ? [name] : []), ...rest].join(".")
  if (top !== "agent" && top !== "mode") return undefined
  if (top === "agent" && name === "<name>") return undefined
  if (name === undefined) return undefined
  return ["agent", "<name>", ...rest].join(".")
}

let cached: Entry[] | undefined
/** Built once: the schema doesn't change while the server runs. */
export function all() {
  cached ??= entries()
  return cached
}
