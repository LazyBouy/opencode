import { type Action, type Rule, wildcard } from "./rules"

// The permission list as it is shown: one line per rule, with a change made in the editable part (the
// agent's own rules, or a session's) shown on the line it changes instead of as a line of its own.
//
// Rules outside the editable part (OpenCode's, the config's) can't be changed where they are, so a
// change is a rule of the editable part with the same permission and pattern, which is checked after
// them. Shown on the changed line, it is out of evaluation order, so every line keeps its `number`
// (its place in that order: the change's place when it has one), and a line that a rule shown above it
// now decides instead (checked later, with another action) says so: `replacedBy` when that rule always
// decides instead, `partly` when it does for some calls.

type Base = { permission: string; pattern: string; action: Action }

export interface Line<R extends Base> {
  // A rule outside the editable part (with `own` set when a change is shown on it), or an editable rule.
  kind: "locked" | "own"
  row?: R
  // The editable rule: the change shown on a locked line, or the own line's rule (its index there).
  own?: number
  // What the line decides now.
  rule: Base
  // Its place in evaluation order (1-based).
  number: number
  replacedBy?: number
  partly?: number[]
}

export function linesOf<R extends Base>(
  before: ReadonlyArray<R>,
  own: ReadonlyArray<Rule>,
  after: ReadonlyArray<R>,
): Line<R>[] {
  // Each locked rule's change: the last editable rule with its permission and pattern (an earlier one
  // with the same pair stays a line of its own, which that last one replaces).
  const changeOf = new Map<number, number>()
  const folded = new Set<number>()
  for (let index = own.length - 1; index >= 0; index--) {
    const rule = own[index]!
    const at = before.findLastIndex(
      (row, position) =>
        !changeOf.has(position) &&
        row.permission === rule.permission.trim() &&
        samePattern(row.pattern, rule.pattern.trim() || "*"),
    )
    if (at < 0 || [...changeOf.values()].some((taken) => pairOf(own[taken]!) === pairOf(rule))) continue
    changeOf.set(at, index)
    folded.add(index)
  }
  const ownNumber = (index: number) => before.length + index + 1
  const lines: Line<R>[] = [
    ...before.map((row, index): Line<R> => {
      const change = changeOf.get(index)
      return change === undefined
        ? { kind: "locked", row, rule: row, number: index + 1 }
        : { kind: "locked", row, own: change, rule: own[change]!, number: ownNumber(change) }
    }),
    ...own.flatMap((rule, index): Line<R>[] =>
      folded.has(index) ? [] : [{ kind: "own", own: index, rule, number: ownNumber(index) }],
    ),
    ...after.map(
      (row, index): Line<R> => ({
        kind: "locked",
        row,
        rule: row,
        number: before.length + own.length + index + 1,
      }),
    ),
  ]
  // A line shown below a rule that is checked after it, with another action: that rule decides the
  // calls both match, whatever the order shown suggests.
  lines.forEach((line, shown) => {
    for (const above of lines.slice(0, shown)) {
      if (above.number < line.number || above.rule.action === line.rule.action) continue
      const a = { permission: line.rule.permission.trim(), pattern: line.rule.pattern.trim() || "*" }
      const b = { permission: above.rule.permission.trim(), pattern: above.rule.pattern.trim() || "*" }
      if (!mayOverlap(a.permission, b.permission) || !mayOverlap(a.pattern, b.pattern)) continue
      if (wildcard(a.permission, b.permission) && wildcard(a.pattern, b.pattern))
        line.replacedBy = Math.max(line.replacedBy ?? 0, above.number)
      else line.partly = [...(line.partly ?? []), above.number]
    }
    if (line.replacedBy) delete line.partly
  })
  return lines
}

// Where a new change for the locked rule `at` goes in the editable rules: after them (so it decides),
// but before a change of a locked rule further down with the same permission, so changes keep the
// order of the lines they are on.
export function insertAt<R extends Base>(before: ReadonlyArray<R>, own: ReadonlyArray<Rule>, at: number): number {
  const lines = linesOf(before, own, [])
  const later = lines.find(
    (line, index) =>
      index > at && line.own !== undefined && line.kind === "locked" && line.rule.permission === before[at]!.permission,
  )
  return later?.own ?? own.length
}

const pairOf = (rule: Rule) => `${rule.permission.trim()}\n${rule.pattern.trim() || "*"}`

// Two patterns can match the same call: some text matches both (`*` is anything, `?` one character;
// a trailing " *" also matches nothing after it, as in OpenCode's wildcard).
export function mayOverlap(a: string, b: string) {
  const forms = (pattern: string) => (pattern.endsWith(" *") ? [pattern, pattern.slice(0, -2)] : [pattern])
  return forms(a).some((x) => forms(b).some((y) => intersects(x.replaceAll("\\", "/"), y.replaceAll("\\", "/"))))
}

function intersects(a: string, b: string) {
  const memo = new Map<number, boolean>()
  const from = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j
    const known = memo.get(key)
    if (known !== undefined) return known
    let result: boolean
    if (i === a.length && j === b.length) result = true
    else if (a[i] === "*") result = from(i + 1, j) || (j < b.length && from(i, j + 1))
    else if (b[j] === "*") result = from(i, j + 1) || (i < a.length && from(i + 1, j))
    else if (i === a.length || j === b.length) result = false
    else result = (a[i] === b[j] || a[i] === "?" || b[j] === "?") && from(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return from(0, 0)
}

// A saved rule's pattern (OpenCode expands `~` and `$HOME` to the home folder) and the pattern as
// written.
export function samePattern(saved: string, written: string) {
  if (saved === written) return true
  const home = written.match(/^(~|\$HOME)(\/.*)?$/)
  return !!home && saved.endsWith(home[2] ?? "") && saved.length > (home[2] ?? "").length
}
