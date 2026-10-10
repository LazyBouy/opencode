export * as OperatorResolver from "./resolver"

import { Schema } from "effect"

// One resolution pipeline for every Dynamic layer (specs/docs/feedbacks/prompt/dynamic_layer_resolution_spec.md):
//
//   Sources → Read → Filter → Score → Select → Render → Trace
//
// This module is the pure part: a layer's resolver (what it reads and how it chooses), and `run`, which
// takes the candidates its sources gave (read elsewhere: resolver-sources.ts for the built-in layers) and
// returns the layer's text with a trace of every candidate. Nothing here reads files or depends on the
// current message, so the same candidates always give the same text (the prompt stays cacheable).

export const SourceKind = Schema.Literals([
  "text",
  "agent-field",
  "file",
  "config",
  "url",
  "live",
  "registry",
  "memory",
  "helper",
]).annotate({ identifier: "OperatorResolverSourceKind" })
export type SourceKind = typeof SourceKind.Type

// A source as a resolver lists it. Reading one gives zero or more candidates (a glob gives one per file).
export const Source = Schema.Struct({
  kind: SourceKind,
  location: Schema.String.annotate({
    description:
      "What to read: a file path or glob, a config key, a URL, a live value's name, a registry's name, a layer id, a helper's prompt",
  }),
  group: Schema.optional(Schema.String).annotate({
    description: "A sub-group: a policy of one or top N applies per group, and groups render in order",
  }),
  name: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Finite).annotate({ description: "For the priority rule" }),
}).annotate({ identifier: "OperatorResolverSource" })
export type Source = typeof Source.Type

export const Filter = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    need: Schema.Literals(["exists", "text"]).annotate({
      description: "exists: the source was found (an empty one stays, and renders nothing); text: it has text",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("permission"),
    permission: Schema.String.annotate({ description: "Decided for each candidate's name (skill: the skill's)" }),
  }),
  Schema.Struct({
    kind: Schema.Literal("size"),
    max: Schema.Finite.annotate({ description: "Characters; a longer candidate is left out" }),
  }),
  Schema.Struct({
    kind: Schema.Literal("attribute"),
    attribute: Schema.String,
    present: Schema.Boolean.annotate({ description: "Keep candidates that have it (true) or don't (false)" }),
  }),
  // A yes/no the source's reader worked out (an MCP server: can the agent use any of its tools).
  Schema.Struct({
    kind: Schema.Literal("flag"),
    attribute: Schema.String,
    reason: Schema.String.annotate({ description: "Why a candidate whose flag is not yes is left out" }),
  }),
]).annotate({ identifier: "OperatorResolverFilter" })
export type Filter = typeof Filter.Type

export const Rule = Schema.Union([
  // Earlier in the list scores higher; a value not in it scores nothing. Without a list: alphabetical.
  Schema.Struct({
    kind: Schema.Literal("precedence"),
    attribute: Schema.String,
    order: Schema.optional(Schema.Array(Schema.String)),
    weight: Schema.Finite,
  }),
  // The attribute equals a value (or the context's value of that name, `$name`), or matches a pattern.
  Schema.Struct({
    kind: Schema.Literal("match"),
    attribute: Schema.String,
    equals: Schema.optional(Schema.String),
    pattern: Schema.optional(Schema.String),
    weight: Schema.Finite,
  }),
  // By origin: earlier in the list (a profile's copy, the namespace's version, OpenCode's) scores higher.
  Schema.Struct({ kind: Schema.Literal("prefer"), order: Schema.Array(Schema.String), weight: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("present"), weight: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("recency"), weight: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("size"), weight: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("priority"), weight: Schema.Finite }),
]).annotate({ identifier: "OperatorResolverRule" })
export type Rule = typeof Rule.Type

export const Select = Schema.Struct({
  policy: Schema.Literals(["one", "top", "all"]),
  n: Schema.optional(Schema.Finite).annotate({ description: "top: how many" }),
  budget: Schema.optional(Schema.Finite).annotate({ description: "Characters for the whole layer" }),
  perSource: Schema.optional(Schema.Finite).annotate({ description: "Characters per candidate; longer is cut" }),
  overflow: Schema.optional(Schema.String).annotate({
    description: "A line added when candidates are over budget; {count} is how many",
  }),
  unique: Schema.optional(Schema.String).annotate({
    description: "An attribute (path): a candidate whose value was already selected is left out",
  }),
  groups: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "The groups' order" }),
  per: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["one", "top", "all"]))).annotate({
    description: "A group's own policy, in place of the layer's (Instructions: one per file group, all of config's)",
  }),
}).annotate({ identifier: "OperatorResolverSelect" })
export type Select = typeof Select.Type

export const Template = Schema.Struct({
  header: Schema.optional(Schema.String).annotate({ description: "Put before the items as it is" }),
  item: Schema.String.annotate({
    description: "Per candidate: {text}, {path}, {name}, {description}, …; {text|indent:4} indents each line",
  }),
  separator: Schema.String.annotate({ description: "Between items" }),
  footer: Schema.optional(Schema.String).annotate({ description: "Put after the items as it is" }),
  keepEmpty: Schema.optional(Schema.Boolean).annotate({
    description: "Render selected candidates with no text too (OpenCode's MCP instructions); else they add nothing",
  }),
  empty: Schema.optional(Schema.String).annotate({
    description:
      'The text when nothing is selected (OpenCode\'s skills: "No skills are currently available."); else nothing',
  }),
}).annotate({ identifier: "OperatorResolverTemplate" })
export type Template = typeof Template.Type

export const Resolver = Schema.Struct({
  sources: Schema.Array(Source),
  filter: Schema.Array(Filter),
  score: Schema.Array(Rule),
  select: Select,
  template: Template,
}).annotate({ identifier: "OperatorResolver" })
export type Resolver = typeof Resolver.Type

export type Attributes = Readonly<Record<string, string | number | undefined>>

// What reading a source gave. `text` is undefined when it is missing or unreadable (`reason` says why).
export type Candidate = {
  readonly source: number
  readonly location: string
  readonly text?: string
  readonly reason?: string
  readonly attributes?: Attributes
}

export const ScorePart = Schema.Struct({ rule: Schema.String, points: Schema.Finite }).annotate({
  identifier: "OperatorResolverScorePart",
})

export const CandidateTrace = Schema.Struct({
  source: Schema.Finite.annotate({ description: "The source's index in the resolver" }),
  kind: SourceKind,
  location: Schema.String,
  group: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  read: Schema.Literals(["ok", "missing", "unreadable", "empty"]),
  reason: Schema.optional(Schema.String),
  filtered: Schema.optional(Schema.String).annotate({ description: "The filter that left it out" }),
  score: Schema.Finite,
  parts: Schema.Array(ScorePart),
  selected: Schema.Boolean,
  why: Schema.String.annotate({ description: "Why it was or wasn't selected" }),
  chars: Schema.Finite,
  cut: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OperatorResolverCandidateTrace" })
export type CandidateTrace = typeof CandidateTrace.Type

const traceFields = {
  policy: Select.fields.policy,
  candidates: Schema.Array(CandidateTrace),
  chars: Schema.Finite,
  overBudget: Schema.Finite,
  off: Schema.optional(Schema.String).annotate({ description: "Why the whole layer adds nothing" }),
}

// The resolution of a selected candidate that is a layer itself (Agent prompt, else base prompt: the base
// prompt by model). One level.
export const InnerTrace = Schema.Struct({ ...traceFields, layer: Schema.String }).annotate({
  identifier: "OperatorResolverInnerTrace",
})

export const Trace = Schema.Struct({
  ...traceFields,
  inner: Schema.optional(InnerTrace),
}).annotate({ identifier: "OperatorResolverTrace" })
export type Trace = typeof Trace.Type

export type Context = {
  /** Values a `match` rule can name with `$name` (the model's family, the agent, …). */
  readonly values?: Readonly<Record<string, string | undefined>>
  /** The whole layer adds nothing, and why (OpenCode's skills when the agent may not use the skill tool). */
  readonly off?: string
  /** The permission decision for a candidate's name (the permission filter). */
  readonly decide?: (permission: string, input: string) => "allow" | "ask" | "deny"
}

// The `{name}` placeholders a template fills in, from a candidate's text, location and attributes;
// `{name|indent:N}` puts N spaces before each of its lines.
export function fill(template: string, values: Readonly<Record<string, string | number | undefined>>) {
  return template.replace(/\{([a-zA-Z][\w-]*)(?:\|indent:(\d+))?\}/g, (whole, key: string, indent?: string) => {
    const value = values[key]
    if (value === undefined) return whole
    if (indent === undefined) return String(value)
    const pad = " ".repeat(Number(indent))
    return String(value)
      .split("\n")
      .map((line) => pad + line)
      .join("\n")
  })
}

const CUT = "\n(cut)"

// A candidate's attribute, else its source's field of that name (name, group, kind, location).
function attribute(item: Scored, key: string): string | number | undefined {
  const own = item.candidate.attributes?.[key]
  if (own !== undefined) return own
  const field = (item.spec as Record<string, unknown>)[key]
  return typeof field === "string" || typeof field === "number" ? field : undefined
}

type Scored = {
  /** The candidate's position among all candidates, and its source's in the resolver. */
  index: number
  source: number
  candidate: Candidate
  spec: Source
  group: string
  text: string
  read: CandidateTrace["read"]
  filtered?: string
  score: number
  parts: Array<{ rule: string; points: number }>
}

function readOf(candidate: Candidate): CandidateTrace["read"] {
  if (candidate.text === undefined)
    return candidate.reason === "missing" || !candidate.reason ? "missing" : "unreadable"
  return candidate.text === "" ? "empty" : "ok"
}

function filterOf(rules: ReadonlyArray<Filter>, item: Scored, context: Context): string | undefined {
  for (const rule of rules) {
    if (rule.kind === "available") {
      if (item.read === "missing" || item.read === "unreadable") return `not available (${item.read})`
      if (rule.need === "text" && item.read === "empty") return "not available (empty)"
    }
    if (rule.kind === "permission") {
      const input = String(attribute(item, "name") ?? item.candidate.location)
      const action = context.decide?.(rule.permission, input) ?? "allow"
      if (action === "deny") return `permission: ${rule.permission} denied for ${input}`
    }
    if (rule.kind === "size" && item.text.length > rule.max) return `size: over ${rule.max} characters`
    if (rule.kind === "attribute") {
      const has = attribute(item, rule.attribute) !== undefined
      if (has !== rule.present) return `${rule.attribute}: ${rule.present ? "none" : "set"}`
    }
    if (rule.kind === "flag" && attribute(item, rule.attribute) !== "yes") return rule.reason
  }
  return undefined
}

// Points for each rule. Rank-based rules spread `weight` over the candidates in play, highest first.
function scoreAll(rules: ReadonlyArray<Rule>, items: Scored[], context: Context) {
  const rank = (values: ReadonlyArray<number | undefined>, descending: boolean) => {
    const known = [...new Set(values.filter((value): value is number => value !== undefined))].toSorted((a, b) =>
      descending ? b - a : a - b,
    )
    return (value: number | undefined) =>
      value === undefined || !known.length ? 0 : (known.length - known.indexOf(value)) / known.length
  }
  for (const rule of rules) {
    const name = ruleName(rule)
    if (rule.kind === "precedence") {
      const values = items.map((item) => String(attribute(item, rule.attribute) ?? ""))
      const order = rule.order ?? [...new Set(values)].toSorted((a, b) => a.localeCompare(b))
      for (const item of items) {
        const at = order.indexOf(String(attribute(item, rule.attribute) ?? ""))
        add(item, name, at < 0 ? 0 : (rule.weight * (order.length - at)) / order.length)
      }
    }
    if (rule.kind === "match")
      for (const item of items) {
        const value = attribute(item, rule.attribute)
        const wanted = rule.equals?.startsWith("$") ? context.values?.[rule.equals.slice(1)] : rule.equals
        const hit =
          value !== undefined &&
          ((rule.equals !== undefined && wanted !== undefined && String(value) === wanted) ||
            (rule.pattern !== undefined && new RegExp(rule.pattern).test(String(value))))
        add(item, name, hit ? rule.weight : 0)
      }
    if (rule.kind === "prefer")
      for (const item of items) {
        const at = rule.order.indexOf(String(attribute(item, "origin") ?? ""))
        add(item, name, at < 0 ? 0 : (rule.weight * (rule.order.length - at)) / rule.order.length)
      }
    if (rule.kind === "present") for (const item of items) add(item, name, item.text ? rule.weight : 0)
    if (rule.kind === "recency") {
      const of = (item: Scored) => numeric(attribute(item, "updated"))
      const ranked = rank(items.map(of), true)
      for (const item of items) add(item, name, rule.weight * ranked(of(item)))
    }
    if (rule.kind === "size") {
      const ranked = rank(
        items.map((item) => item.text.length),
        false,
      )
      for (const item of items) add(item, name, rule.weight * ranked(item.text.length))
    }
    if (rule.kind === "priority")
      for (const item of items) add(item, name, rule.weight * (numeric(item.spec.priority) ?? 0))
  }
}

const numeric = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const add = (item: Scored, rule: string, points: number) => {
  item.parts.push({ rule, points })
  item.score += points
}
function ruleName(rule: Rule) {
  if (rule.kind === "precedence" || rule.kind === "match") return `${rule.kind} (${rule.attribute})`
  return rule.kind
}

// Higher score first; ties by the source list's order, then the order a source gave its candidates.
const byScore = (a: Scored, b: Scored) => b.score - a.score || a.source - b.source || a.index - b.index

function differing(winner: Scored, loser: Scored) {
  return winner.parts.find((part, at) => part.points !== loser.parts[at]?.points)?.rule
}

/** Resolves a layer: its candidates (read from its sources, in order) into its text and trace. */
export function run(resolver: Resolver, candidates: ReadonlyArray<Candidate>, context: Context = {}) {
  if (context.off !== undefined)
    return {
      text: "",
      trace: { policy: resolver.select.policy, candidates: [], chars: 0, overBudget: 0, off: context.off } as Trace,
    }
  const items: Scored[] = candidates.map((candidate, index) => {
    const spec = resolver.sources[candidate.source] ?? { kind: "text" as const, location: candidate.location }
    return {
      index,
      source: candidate.source,
      candidate,
      spec,
      group: spec.group ?? "",
      text: candidate.text ?? "",
      read: readOf(candidate),
      score: 0,
      parts: [],
    }
  })
  for (const item of items) item.filtered = filterOf(resolver.filter, item, context)
  const kept = items.filter((item) => !item.filtered)
  scoreAll(resolver.score, kept, context)

  // Select per group, groups in their order (listed, else as the sources first name them).
  const order = [
    ...(resolver.select.groups ?? []),
    ...[...new Set(resolver.sources.map((source) => source.group ?? ""))].filter(
      (group) => !resolver.select.groups?.includes(group),
    ),
  ]
  const why = new Map<Scored, string>()
  const chosen: Scored[] = []
  for (const group of order) {
    const pool = kept.filter((item) => item.group === group).toSorted(byScore)
    if (!pool.length) continue
    const policy = resolver.select.per?.[group] ?? resolver.select.policy
    const take =
      policy === "all"
        ? pool
        : policy === "top"
          ? pool.slice(0, Math.max(0, resolver.select.n ?? 1))
          : // one: the best, with its source's other candidates of the same score (all files of a name).
            pool.filter(
              (item) => item === pool[0] || (item.source === pool[0]!.source && item.score === pool[0]!.score),
            )
    for (const item of pool) {
      if (take.includes(item)) continue
      const rule = differing(pool[0]!, item)
      why.set(
        item,
        policy === "top"
          ? `not in the top ${resolver.select.n ?? 1}`
          : `lost to ${label(pool[0]!)}${rule ? ` (${rule})` : " (order)"}`,
      )
    }
    chosen.push(...take)
  }

  // Unique values, the per-source cut and the budget, in the order they render.
  const seen = new Set<string>()
  const rendered: Array<{ item: Scored; text: string; cut: boolean }> = []
  let chars = 0
  let over = 0
  const budget = resolver.select.budget
  for (const item of chosen) {
    const key = resolver.select.unique ? attribute(item, resolver.select.unique) : undefined
    if (key !== undefined && seen.has(String(key))) {
      why.set(item, `already included (same ${resolver.select.unique})`)
      continue
    }
    if (key !== undefined) seen.add(String(key))
    const limit = resolver.select.perSource
    const cut = limit !== undefined && item.text.length > limit
    const text = cut ? item.text.slice(0, limit) + CUT : item.text
    if (budget !== undefined && chars + text.length > budget) {
      over++
      why.set(item, "over budget")
      continue
    }
    chars += text.length
    rendered.push({ item, text, cut })
    why.set(item, "selected")
  }

  const t = resolver.template
  const pieces = rendered
    .filter(({ text }) => t.keepEmpty || text !== "")
    .map(({ item, text }) =>
      fill(t.item, {
        ...item.candidate.attributes,
        text,
        location: item.candidate.location,
        name: String(attribute(item, "name") ?? ""),
      }),
    )
  const overflow = over && resolver.select.overflow ? [fill(resolver.select.overflow, { count: over })] : []
  const body = [...pieces, ...overflow]
  // An empty selection renders nothing (no header, footer or separator), or the template's empty text.
  const text = body.length ? (t.header ?? "") + body.join(t.separator) + (t.footer ?? "") : (t.empty ?? "")

  const cutSet = new Set(rendered.filter((item) => item.cut).map((item) => item.item))
  const trace: Trace = {
    policy: resolver.select.policy,
    chars: text.length,
    overBudget: over,
    candidates: items.map((item) => ({
      source: item.source,
      kind: item.spec.kind,
      location: item.candidate.location,
      ...(item.spec.group !== undefined ? { group: item.spec.group } : {}),
      ...(attribute(item, "name") !== undefined ? { name: String(attribute(item, "name")) } : {}),
      read: item.read,
      ...(item.candidate.reason ? { reason: item.candidate.reason } : {}),
      ...(item.filtered ? { filtered: item.filtered } : {}),
      score: item.score,
      parts: item.parts,
      selected: rendered.some((entry) => entry.item === item),
      why: item.filtered ? `filtered: ${item.filtered}` : (why.get(item) ?? "not selected"),
      chars: item.text.length,
      ...(cutSet.has(item) ? { cut: true } : {}),
    })),
  }
  return { text, trace }
}

function label(item: Scored) {
  const name = attribute(item, "name")
  if (name !== undefined) return String(name)
  const path = attribute(item, "path") ?? item.candidate.location
  return String(path).split("/").at(-1) ?? String(path)
}
