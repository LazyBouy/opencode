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
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(
    value,
  )
}

export function formatAgo(time: number | undefined, locale: string) {
  if (!time) return ""
  return DateTime.fromMillis(time).setLocale(locale).toRelative() ?? ""
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
