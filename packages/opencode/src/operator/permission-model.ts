export * as OperatorPermissionModel from "./permission-model"

import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { OperatorPermissionReach as Reach } from "./permission-reach"

// How permission lines decide, in levels (tool_prompt_from_permission.md §3, with the rules the user set
// on 2026-10-08). The levels, highest first: OpenCode (its defaults, then the built-in agent's rules),
// Global config, Namespace, Project, Agent, Session.
//
// - The most specific line that matches decides, at any level and in any order. Line A is more specific
//   than B when A's permission and pattern both fall inside B's (as wildcard languages).
// - A lower level's line with the same permission and pattern replaces the inherited one (it keeps its
//   place in the list); a level can also delete inherited lines.
// - Two matching lines where neither falls inside the other: at the same level the stricter action wins
//   (deny, then ask, then allow: "AND"); across levels the lower level's line wins ("OR": the line above
//   can be overridden below).
// - A locked line ("Can be overridden below: no") binds every level below the level that locked it: for
//   an input it matches, only the lines of that level and above decide.
// - An input no line matches is denied. (OpenCode's own `* *` line always matches, except in a namespace
//   that deletes it.)
//
// OpenCode itself checks the last line that matches (permission/index.ts `evaluate`). The fork decides
// asks with exact rules per input (`exact`), and gives upstream's other readers an ordered list that
// gives the same decisions in practice (`compile`).

export type Action = "allow" | "ask" | "deny"
export type Key = { readonly permission: string; readonly pattern: string }
export type Rule = Key & { readonly action: Action }

export type Line<T = {}> = Rule &
  T & {
    /** The level the line is written at: 0 is OpenCode's; a higher number is a lower level. */
    readonly level: number
    /** The level that locked the line, if one did. The lock binds every level below that one. */
    readonly lockedAt?: number
  }

export type Level<T = {}> = {
  /** The level's own lines, in the order written; a later line with the same permission and pattern replaces an earlier one. */
  readonly lines: ReadonlyArray<Rule & T>
  /** Inherited lines the level deletes. */
  readonly deleted?: ReadonlyArray<Key>
  /** Lines the level locks (its own or inherited). */
  readonly locks?: ReadonlyArray<Key>
}

export type Blocked<T = {}> = {
  level: number
  key: Key
  kind: "line" | "deleted"
  /** The lock that sets it aside; none for a deletion of a line that can't be deleted. */
  lock?: Line<T>
}

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 }
export const sameKey = (a: Key, b: Key) => a.permission === b.permission && a.pattern === b.pattern

// The lines in force, level by level. A level's line or deletion that a lock above it forbids is left out
// and reported (saving one is refused; one written by hand or by another client is ignored), as is the
// deletion of a line `keep` protects (OpenCode's own lines, in the OpenCode namespace).
export function build<T>(levels: ReadonlyArray<Level<T>>, options: { keep?: (line: Line<T>) => boolean } = {}) {
  let lines: Line<T>[] = []
  const blocked: Blocked<T>[] = []
  levels.forEach((level, index) => {
    for (const key of level.deleted ?? []) {
      const found = lines.find((line) => sameKey(line, key))
      if (!found) continue
      if (found.lockedAt !== undefined || options.keep?.(found)) {
        blocked.push({ level: index, key, kind: "deleted", ...(found.lockedAt !== undefined ? { lock: found } : {}) })
        continue
      }
      lines = lines.filter((line) => line !== found)
    }
    for (const rule of level.lines) {
      const at = lines.findIndex((line) => sameKey(line, rule))
      const line = { ...rule, level: index } as Line<T>
      if (at < 0) {
        lines.push(line)
        continue
      }
      const found = lines[at]!
      if (found.lockedAt !== undefined) {
        if (found.action !== rule.action) blocked.push({ level: index, key: rule, kind: "line", lock: found })
        continue
      }
      lines[at] = line
    }
    for (const key of level.locks ?? []) {
      const at = lines.findIndex((line) => sameKey(line, key))
      if (at >= 0 && lines[at]!.lockedAt === undefined) lines[at] = { ...lines[at]!, lockedAt: index }
    }
  })
  return { lines, blocked }
}

// Wildcard languages, compiled once.
const automata = new Map<string, Reach.Automaton>()
const automaton = (pattern: string) => {
  const found = automata.get(pattern)
  if (found) return found
  const made = Reach.compile(pattern)
  if (automata.size > 5000) automata.clear()
  automata.set(pattern, made)
  return made
}

// Whether every text `inner` matches, `outer` matches too.
const inclusion = new Map<string, boolean>()
export function contains(outer: string, inner: string) {
  if (outer === inner || outer === "*") return true
  const key = `${outer}\u0000${inner}`
  const known = inclusion.get(key)
  if (known !== undefined) return known
  const result = Reach.exclusive(automaton(inner), [automaton(outer)]) === undefined
  if (inclusion.size > 20000) inclusion.clear()
  inclusion.set(key, result)
  return result
}

// Whether some text matches both.
const overlap = new Map<string, boolean>()
export function intersects(a: string, b: string) {
  if (a === b || a === "*" || b === "*") return true
  const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
  const known = overlap.get(key)
  if (known !== undefined) return known
  const left = automaton(a)
  const right = automaton(b)
  const alphabet = Reach.alphabetOf([left, right])
  const start = [Reach.close(left, new Set([0])), Reach.close(right, new Set([0]))] as const
  const id = (states: readonly [ReadonlySet<number>, ReadonlySet<number>]) =>
    JSON.stringify(states.map((set) => [...set].sort()))
  const seen = new Set([id(start)])
  const queue = [start]
  let result = false
  while (queue.length && !result) {
    const [l, r] = queue.shift()!
    if (Reach.accepts(left, l) && Reach.accepts(right, r)) result = true
    for (const symbol of alphabet) {
      const next = [Reach.step(left, l, symbol), Reach.step(right, r, symbol)] as const
      if (!next[0].size || !next[1].size) continue
      const nextId = id(next)
      if (seen.has(nextId)) continue
      seen.add(nextId)
      queue.push(next)
    }
  }
  if (overlap.size > 20000) overlap.clear()
  overlap.set(key, result)
  return result
}

/** A falls inside B (both its permission and its pattern), and not the other way round. */
export function moreSpecific(a: Key, b: Key) {
  const inside = contains(b.permission, a.permission) && contains(b.pattern, a.pattern)
  return inside && !(contains(a.permission, b.permission) && contains(a.pattern, b.pattern))
}

/** Some request could match both lines. */
export const overlaps = (a: Key, b: Key) => intersects(a.permission, b.permission) && intersects(a.pattern, b.pattern)

export type Decision<T = {}> = {
  readonly action: Action
  /** The line that decides; none when no line matches. */
  readonly line?: Line<T>
  /** The lock that binds this input, when one does. */
  readonly lock?: Line<T>
}

// The decision among the lines that match one input.
function resolve<T>(matched: ReadonlyArray<Line<T>>, fallback: Action): Decision<T> {
  const lock = matched.reduce<Line<T> | undefined>(
    (found, line) =>
      line.lockedAt !== undefined && (found === undefined || line.lockedAt < found.lockedAt!) ? line : found,
    undefined,
  )
  const kept = lock ? matched.filter((line) => line.level <= lock.lockedAt!) : matched
  if (!kept.length) return { action: fallback, ...(lock ? { lock } : {}) }
  const most = kept.filter((line) => !kept.some((other) => other !== line && moreSpecific(other, line)))
  const lowest = Math.max(...most.map((line) => line.level))
  const line = most
    .filter((item) => item.level === lowest)
    .reduce((found, item) => (RANK[item.action] > RANK[found.action] ? item : found))
  return { action: line.action, line, ...(lock ? { lock } : {}) }
}

export function decide<T>(
  lines: ReadonlyArray<Line<T>>,
  permission: string,
  input: string,
  fallback: Action = "deny",
): Decision<T> {
  return resolve(
    lines.filter((line) => Wildcard.match(permission, line.permission) && Wildcard.match(input, line.pattern)),
    fallback,
  )
}

export type Live<T = {}> = Decision<T> & {
  /** An input this decision applies to. */
  readonly example: string
}

export type Reachability<T = {}> = {
  readonly permission: string
  /** Some input gets allow or ask. */
  readonly reachable: boolean
  /** Each different decision some input gets, with an input that gets it (shortest first). */
  readonly live: ReadonlyArray<Live<T>>
  /** False when the search stopped early (then the permission counts as reachable). */
  readonly complete: boolean
}

// Can any input of a permission be allowed or asked? Searches the inputs by the lines' automata at once:
// each state of the product tells which lines match, so every decision any input can get is found.
export function reach<T>(
  lines: ReadonlyArray<Line<T>>,
  permission: string,
  fallback: Action = "deny",
  limit = 20000,
): Reachability<T> {
  const applicable = lines.filter((line) => Wildcard.match(permission, line.permission))
  const machines = applicable.map((line) => automaton(line.pattern))
  const alphabet = Reach.alphabetOf(machines)
  type Node = { states: ReadonlySet<number>[]; text: string }
  const start: Node = { states: machines.map((machine) => Reach.close(machine, new Set([0]))), text: "" }
  const id = (node: Node) => JSON.stringify(node.states.map((set) => [...set].sort()))
  const seen = new Set([id(start)])
  const queue = [start]
  const live: Live<T>[] = []
  const found = new Set<string>()
  let complete = true
  while (queue.length) {
    if (seen.size > limit) {
      complete = false
      break
    }
    const node = queue.shift()!
    const decision = resolve(
      applicable.filter((_, index) => Reach.accepts(machines[index]!, node.states[index]!)),
      fallback,
    )
    const key = `${decision.line ? applicable.indexOf(decision.line) : -1}:${decision.lock ? applicable.indexOf(decision.lock) : -1}:${decision.action}`
    if (!found.has(key)) {
      found.add(key)
      live.push({ ...decision, example: node.text })
    }
    for (const symbol of alphabet) {
      const next: Node = {
        states: machines.map((machine, index) => Reach.step(machine, node.states[index]!, symbol)),
        text: node.text + Reach.textOf(symbol),
      }
      const nextId = id(next)
      if (seen.has(nextId)) continue
      seen.add(nextId)
      queue.push(next)
    }
  }
  return {
    permission,
    reachable: !complete || live.some((item) => item.action !== "deny"),
    live,
    complete,
  }
}

// Whether `a` must come after `b` in an ordered list for last-match checking to pick it where both match.
function beats(a: Line<unknown>, b: Line<unknown>) {
  if (b.lockedAt !== undefined && a.level > b.lockedAt) return false
  if (a.lockedAt !== undefined && b.level > a.lockedAt) return true
  if (moreSpecific(a, b)) return true
  if (moreSpecific(b, a)) return false
  if (a.level !== b.level) return a.level > b.level
  return RANK[a.action] > RANK[b.action]
}

// The lines in one order where each line comes after every line it wins against where both can match:
// the broader lines first. Exact for the usual lists; the fork decides asks and the tool list from the
// lines themselves.
export function order<L extends Line<unknown>>(lines: ReadonlyArray<L>): L[] {
  const after = lines.map(() => new Set<number>())
  lines.forEach((a, i) =>
    lines.forEach((b, j) => {
      if (i === j || !overlaps(a, b)) return
      if (beats(a, b) && !beats(b, a)) after[i]!.add(j)
    }),
  )
  const placed = new Set<number>()
  const result: L[] = []
  while (result.length < lines.length) {
    const ready = lines.findIndex(
      (_, index) => !placed.has(index) && [...after[index]!].every((other) => placed.has(other)),
    )
    // A cycle (lines that each win somewhere): the first one left goes next.
    const next = ready >= 0 ? ready : lines.findIndex((_, index) => !placed.has(index))
    placed.add(next)
    result.push(lines[next]!)
  }
  return result
}

// The lines as one ordered list for upstream code that checks the last line that matches (the skills and
// subagent lists, MCP instructions).
export function compile<T>(lines: ReadonlyArray<Line<T>>): Rule[] {
  return order(lines).map(({ permission, pattern, action }) => ({ permission, pattern, action }))
}

// One rule per input, each deciding its own input when checked last: what the permission hook returns, so
// an ask is decided as the lines decide it. A rule whose pattern also matches another input comes before
// that input's own rule.
export function exact<T>(
  lines: ReadonlyArray<Line<T>>,
  permission: string,
  inputs: ReadonlyArray<string>,
  fallback: Action = "deny",
): Rule[] {
  const decided = [...new Set(inputs)].map((input) => ({
    permission,
    pattern: input,
    action: decide(lines, permission, input, fallback).action,
  }))
  const placed = new Set<number>()
  const order: Rule[] = []
  while (order.length < decided.length) {
    // Next: an input whose decision no rule placed after it changes (none of the rest matches it, or
    // gives it the same action).
    const ready = decided.findIndex(
      (rule, index) =>
        !placed.has(index) &&
        decided.every(
          (other, j) =>
            j === index ||
            placed.has(j) ||
            other.action === rule.action ||
            !Wildcard.match(rule.pattern, other.pattern),
        ),
    )
    const next =
      ready >= 0
        ? ready
        : decided.reduce(
            (best, rule, index) =>
              placed.has(index) ? best : best < 0 || RANK[rule.action] < RANK[decided[best]!.action] ? index : best,
            -1,
          )
    placed.add(next)
    order.push(decided[next]!)
  }
  return order
}
