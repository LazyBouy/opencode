// The back path, "how you got there" (fixes_spec.md §1.4): one crumb per history entry of an operator
// page or record, in this browser tab. A crumb's depth is its place in the tab's history (the router
// keeps it in `history.state._depth`), so going back, or a change that replaces the entry, cuts the
// trail there; a trail that starts mid-way (a pasted link, a new tab) has only the current crumb.

export type Crumb = { depth: number; url: string; label: string }

const KEY = "operator.trail"

// A URL with its query sorted, so the same page and record compare equal however it was written.
export function normalize(url: string) {
  const parsed = new URL(url, "http://local")
  const params = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  const query = new URLSearchParams(params).toString()
  return `${parsed.pathname}${query ? `?${query}` : ""}`
}

// The URL with some of its query keys left out (an overlay's), normalized.
export function without(url: string, keys: ReadonlyArray<string>) {
  const parsed = new URL(url, "http://local")
  for (const key of keys) parsed.searchParams.delete(key)
  return normalize(`${parsed.pathname}${parsed.search}`)
}

// A visit: everything at its depth or deeper goes (back, or an entry replaced), then it is added.
export function visit(trail: ReadonlyArray<Crumb>, next: Crumb): Crumb[] {
  return [...trail.filter((crumb) => crumb.depth < next.depth), { ...next, url: normalize(next.url) }]
}

// The current crumb's label, once its page or record says what it is.
export function relabel(trail: ReadonlyArray<Crumb>, url: string, label: string): Crumb[] {
  const last = trail.at(-1)
  if (!last || last.url !== normalize(url) || last.label === label) return [...trail]
  return [...trail.slice(0, -1), { ...last, label }]
}

// Where closing an overlay goes: back to the page it was opened on (the same page without the
// overlay's keys), when the crumbs since are all that overlay; otherwise nowhere (the overlay's keys
// are cleared in place).
export function closeTarget(trail: ReadonlyArray<Crumb>, keys: ReadonlyArray<string>): Crumb | undefined {
  const current = trail.at(-1)
  if (!current) return undefined
  const page = without(current.url, keys)
  const path = page.split("?")[0]
  for (let at = trail.length - 2; at >= 0; at--) {
    const crumb = trail[at]!
    if (crumb.url.split("?")[0] !== path) return undefined
    if (crumb.url === page) return crumb
    if (without(crumb.url, keys) !== page) return undefined
  }
  return undefined
}

// What the trail shows: all of it when short; else the first crumb, the hidden middle (in a menu)
// and the last two.
export function shown(trail: ReadonlyArray<Crumb>, max = 4) {
  if (trail.length <= max) return { first: [...trail], hidden: [] as Crumb[], last: [] as Crumb[] }
  return { first: trail.slice(0, 1), hidden: trail.slice(1, -2), last: trail.slice(-2) }
}

export function load(): Crumb[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown
    return Array.isArray(value)
      ? value.filter(
          (crumb): crumb is Crumb =>
            !!crumb &&
            typeof crumb.depth === "number" &&
            typeof crumb.url === "string" &&
            typeof crumb.label === "string",
        )
      : []
  } catch {
    return []
  }
}

export function save(trail: ReadonlyArray<Crumb>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(trail))
  } catch {
    // kept for this page only
  }
}
