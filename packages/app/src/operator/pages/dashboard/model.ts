// The Dashboard's pure parts (dashboard_spec.md): its ranges, the links the server sends as a page and parameters,
// ages in words, which way a tile's change is worse, and the sparkline values. The page builds the words.

export const RANGES = ["24h", "7d", "14d", "30d"] as const
export type Range = (typeof RANGES)[number]
export const DEFAULT_RANGE: Range = "14d"
export const isRange = (value: unknown): value is Range => (RANGES as ReadonlyArray<unknown>).includes(value)

/** The range shown: the URL's, else the one remembered (the old `days` choice carries over), else 14 days (§4.4). */
export function rangeOf(param: string | undefined, remembered: { range?: string; days?: number }): Range {
  if (isRange(param)) return param
  if (isRange(remembered.range)) return remembered.range
  const days = `${remembered.days}d`
  return isRange(days) ? days : DEFAULT_RANGE
}

export type Link = { page: string; params: Record<string, string> }
const PATHS: Record<string, string> = {
  inbox: "/operator/inbox",
  observability: "/operator/observability",
  capabilities: "/operator/capabilities",
}

/**
 * A link the server sent (§9.1: a page and its parameters, never a URL), as a path in the app. The page's scope goes
 * along (a project everywhere, a namespace into Observability), and `extra` (a tile's range) into Observability; the
 * link's own parameters win.
 */
export function hrefOf(link: Link, scope: { ns?: string; dir?: string } = {}, extra: Record<string, string> = {}) {
  const carried = {
    ...(scope.dir ? { dir: scope.dir } : {}),
    ...(link.page === "observability" ? { ...(scope.ns && !scope.dir ? { ns: scope.ns } : {}), ...extra } : {}),
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...carried, ...link.params })) if (value) params.set(key, value)
  const query = params.toString()
  return `${PATHS[link.page] ?? "/operator"}${query ? `?${query}` : ""}`
}

export const TILES = ["turns", "turnErrors", "turnTime", "approvalWait", "rateLimits", "cost"] as const
export type TileId = (typeof TILES)[number]
export type Change = { kind: "relative" | "points" | "same" | "insufficient"; value?: number }

/** The way each tile gets worse (§6.1); Turns and Cost are neutral. */
export const WORSE: Record<TileId, "up" | undefined> = {
  turns: undefined,
  turnErrors: "up",
  turnTime: "up",
  approvalWait: "up",
  rateLimits: "up",
  cost: undefined,
}

/** The change's arrow; none for "about the same" or no comparison. */
export function arrowOf(change: Change): "up" | "down" | undefined {
  if ((change.kind !== "relative" && change.kind !== "points") || !change.value) return undefined
  return change.value > 0 ? "up" : "down"
}

/** The tone of a change (§6.2): worse is the warning tone, better the good one; neutral tiles stay neutral. */
export function toneOf(id: TileId, change: Change): "good" | "warn" | "neutral" {
  const arrow = arrowOf(change)
  if (!arrow || !WORSE[id]) return "neutral"
  return arrow === WORSE[id] ? "warn" : "good"
}

/** A sparkline's values: counts and sums read an empty step as 0; rates and percentiles leave it out. */
export function trendOf(series: ReadonlyArray<readonly [number, number | null]>, sum: boolean): number[] {
  return series.flatMap(([, value]) => (value === null ? (sum ? [0] : []) : [value]))
}

/** The strip shows at most this many items on one line, then "+N more" (§5.1). */
export const SHOWN = 6

/**
 * Runs `work` at most once per `ms` (the first call at once, the last one of a burst at the end), for refreshes on
 * live events (§4.5: at most once every 2 s).
 */
export function throttle(work: () => void, ms: number) {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    timer = undefined
    last = Date.now()
    work()
  }
  return {
    call() {
      if (timer) return
      const wait = last + ms - Date.now()
      if (wait <= 0) run()
      else timer = setTimeout(run, wait)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
