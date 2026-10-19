import { DateTime } from "luxon"

// Number, money and time formatting shared by the operator pages.

export function formatCost(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value)
}

export function formatCount(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatAgo(time: number | undefined, locale: string) {
  if (!time) return ""
  return DateTime.fromMillis(time).setLocale(locale).toRelative() ?? ""
}

/** An age in its largest sensible unit: minutes under an hour, hours under two days, then days. */
export function ageOf(ms: number): { unit: "min" | "h" | "d"; n: number } {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return { unit: "min", n: minutes }
  const hours = Math.round(ms / 3_600_000)
  if (hours < 48) return { unit: "h", n: hours }
  return { unit: "d", n: Math.round(ms / 86_400_000) }
}

export function formatDateTime(time: number | undefined, locale: string) {
  if (!time) return ""
  return DateTime.fromMillis(time).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
}

// The last two segments of a path, enough to tell projects apart in a table.
export function shortPath(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? value : `…/${parts.slice(-2).join("/")}`
}

// Where a session ran: its project root, or its own folder for sessions outside a git project (whose
// project is the global one, rooted at "/").
export function sessionFolder(session: { directory: string; project?: { worktree: string } | null }) {
  return session.project && session.project.worktree !== "/" ? session.project.worktree : session.directory
}

export function formatBytes(value: number, locale: string) {
  const units = ["B", "KB", "MB", "GB"]
  const power = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0
  const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: power ? 1 : 0 }).format(value / 1024 ** power)
  return `${amount} ${units[power]}`
}

// The folders from a workspace root down to `path` (which is inside it), for breadcrumbs.
export function crumbs(root: string, path: string) {
  const base = root.replace(/\/+$/, "") || "/"
  const rest = path.slice(base.length).split("/").filter(Boolean)
  return [
    { name: root, path: root },
    ...rest.map((name, index) => ({ name, path: [base === "/" ? "" : base, ...rest.slice(0, index + 1)].join("/") })),
  ]
}
