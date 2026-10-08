export * as OperatorPermissionReach from "./permission-reach"

import { Wildcard } from "@opencode-ai/core/util/wildcard"

// Can a tool ever be allowed? (tool_prompt_from_permission.md §4)
//
// For a permission P and a ruleset R, the rules that apply are R's rules whose `permission` matches P,
// in order. An input's decision is the action of the last applicable rule whose pattern matches it, or
// "ask" when none does (OpenCode's rule, permission/index.ts `evaluate`). P is reachable when some input
// gets allow or ask ("ask" counts: the user may approve).
//
// Patterns are OpenCode's wildcards (core/src/util/wildcard.ts): `*` is any text (newlines too), `?` one
// character, a trailing " *" also matches without its tail, everything else is literal; backslashes
// count as "/"; matching ignores case on Windows. These are regular languages, so the check is exact:
// each pattern becomes a small automaton, and a breadth-first search over the product of "this rule
// matches" and "no later rule matches" finds an input, or proves there is none.

export type Action = "allow" | "ask" | "deny"
export type Rule = { readonly permission: string; readonly pattern: string; readonly action: Action }

const IGNORE_CASE = process.platform === "win32"
// Every character that appears in no pattern behaves the same; one symbol stands for all of them.
const OTHER = "\u0000other"

type Token = { kind: "char"; char: string } | { kind: "one" } | { kind: "any" }
type Automaton = { tokens: Token[]; optionalTail: boolean }

const normalize = (text: string) => {
  const slashed = text.replaceAll("\\", "/")
  return IGNORE_CASE ? slashed.toLowerCase() : slashed
}

export function compile(pattern: string): Automaton {
  const text = normalize(pattern)
  const tokens: Token[] = [...text].map((char) =>
    char === "*" ? { kind: "any" } : char === "?" ? { kind: "one" } : { kind: "char", char },
  )
  // `foo *` also matches `foo` (Wildcard turns a trailing " .*" into "( .*)?").
  return { tokens, optionalTail: text.endsWith(" *") }
}

// The states an automaton can be in after reading nothing more, from a set: `*` lets a state move on
// without a character, and the optional tail lets the state before " *" reach the end.
function close(automaton: Automaton, states: ReadonlySet<number>) {
  const result = new Set(states)
  const stack = [...states]
  const end = automaton.tokens.length
  while (stack.length) {
    const state = stack.pop()!
    const next: number[] = []
    if (automaton.tokens[state]?.kind === "any") next.push(state + 1)
    if (automaton.optionalTail && state === end - 2) next.push(end)
    for (const item of next)
      if (!result.has(item)) {
        result.add(item)
        stack.push(item)
      }
  }
  return result
}

function step(automaton: Automaton, states: ReadonlySet<number>, symbol: string) {
  const next = new Set<number>()
  for (const state of states) {
    const token = automaton.tokens[state]
    if (!token) continue
    if (token.kind === "any") next.add(state)
    else if (token.kind === "one") next.add(state + 1)
    else if (symbol !== OTHER && token.char === symbol) next.add(state + 1)
  }
  return close(automaton, next)
}

const accepts = (automaton: Automaton, states: ReadonlySet<number>) => states.has(automaton.tokens.length)

// Whether a compiled pattern matches a text (for tests against Wildcard.match).
export function matches(pattern: string, text: string) {
  const automaton = compile(pattern)
  let states = close(automaton, new Set([0]))
  for (const char of normalize(text)) states = step(automaton, states, char)
  return accepts(automaton, states)
}

// An input in L(own) and in none of `later` (or, with `own` undefined, in none of `later` at all),
// found by a breadth-first search; undefined when there is none.
function exclusive(own: Automaton | undefined, later: ReadonlyArray<Automaton>) {
  const alphabet = [
    ...new Set(
      [own, ...later].flatMap((item) =>
        (item?.tokens ?? []).flatMap((token) => (token.kind === "char" ? [token.char] : [])),
      ),
    ),
    OTHER,
  ]
  const start = {
    own: own ? close(own, new Set([0])) : undefined,
    later: later.map((item) => close(item, new Set([0]))),
    text: "",
  }
  const key = (node: typeof start) =>
    JSON.stringify([node.own ? [...node.own].sort() : null, node.later.map((states) => [...states].sort())])
  const seen = new Set([key(start)])
  const queue = [start]
  while (queue.length) {
    const node = queue.shift()!
    const inOwn = own ? accepts(own, node.own!) : true
    if (inOwn && node.later.every((states, index) => !accepts(later[index]!, states))) return node.text
    // A dead end: `own` can't match anything longer.
    if (own && node.own!.size === 0) continue
    for (const symbol of alphabet) {
      const next = {
        own: own ? step(own, node.own!, symbol) : undefined,
        later: node.later.map((states, index) => step(later[index]!, states, symbol)),
        text: node.text + (symbol === OTHER ? "⁣" : symbol),
      }
      if (own && next.own!.size === 0) continue
      const id = key(next)
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(next)
    }
  }
  return undefined
}

// Whether a rule applies to a permission (its `permission` matches it).
export function applies(permission: string, rule: Rule) {
  return Wildcard.match(permission, rule.permission)
}

export type Live = {
  /** The rule's index in the ruleset; undefined for "no rule matches" (OpenCode asks). */
  readonly index: number | undefined
  readonly rule: Rule | undefined
  readonly action: Action
  /** An input this rule (alone among the later ones) decides. */
  readonly example: string
}

export type Reach = {
  readonly permission: string
  readonly reachable: boolean
  /** The rules that decide some input: each rule, last first, with an input only it decides. */
  readonly live: ReadonlyArray<Live>
  /** The applicable rules (indexes into the ruleset), in order. */
  readonly applicable: ReadonlyArray<number>
}

// Which rules of `rules` decide some input of `permission`, and whether any of them allows or asks.
export function reach(permission: string, rules: ReadonlyArray<Rule>): Reach {
  const applicable = rules.flatMap((rule, index) => (Wildcard.match(permission, rule.permission) ? [index] : []))
  const automata = new Map(applicable.map((index) => [index, compile(rules[index]!.pattern)]))
  const live: Live[] = []
  // From the last rule up: a later rule with pattern `*` shadows every rule before it.
  for (let position = applicable.length - 1; position >= 0; position--) {
    const index = applicable[position]!
    const later = applicable.slice(position + 1).map((item) => automata.get(item)!)
    const example = exclusive(automata.get(index)!, later)
    if (example !== undefined) live.push({ index, rule: rules[index], action: rules[index]!.action, example })
    if (normalize(rules[index]!.pattern) === "*") break
  }
  const fallback = exclusive(
    undefined,
    applicable.map((index) => automata.get(index)!),
  )
  if (fallback !== undefined) live.push({ index: undefined, rule: undefined, action: "ask", example: fallback })
  return {
    permission,
    reachable: live.some((item) => item.action !== "deny"),
    live,
    applicable,
  }
}

// The decision OpenCode makes for an input (permission/index.ts `evaluate`), for tests and traces.
export function decide(permission: string, input: string, rules: ReadonlyArray<Rule>): Action {
  const found = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(input, rule.pattern),
  )
  return found?.action ?? "ask"
}
