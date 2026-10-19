import type { OperatorDashboardTiles } from "@opencode-ai/sdk/v2/client"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { formatCost, formatCount } from "../../format"
import { type StatChange, StatTile } from "../../ui/stat-tile"
import { useDuration } from "../observability/parts"
import { arrowOf, type Change, hrefOf, type Range, type TileId, TILES, toneOf, trendOf } from "./model"

// The six tiles (dashboard_spec.md §6): traffic, errors, latency, approvals, saturation and cost over the range, each
// against the previous period of the same length (an arrow and words, the warning tone when worse), a hint line of
// numbers, a sparkline, and one link into Observability with the page's range and scope. Loading is the tiles'
// shape; no data says so ("No turns in the last 7 days"), and so does telemetry off.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Data = NonNullable<OperatorDashboardTiles["tiles"]>
type Unit = "count" | "percent" | "ms" | "usd"

const UNIT: Record<TileId, Unit> = {
  turns: "count",
  turnErrors: "percent",
  turnTime: "ms",
  approvalWait: "ms",
  rateLimits: "count",
  cost: "usd",
}
const PERCENTILE: Record<TileId, boolean> = {
  turns: false,
  turnErrors: false,
  turnTime: true,
  approvalWait: true,
  rateLimits: false,
  cost: false,
}
const LINKS: Record<TileId, Record<string, string>> = {
  turns: { tab: "sessions" },
  turnErrors: { tab: "events", kind: "turn", status: "error,interrupted" },
  turnTime: { tab: "metrics", section: "turns" },
  approvalWait: { tab: "metrics", section: "approvals" },
  rateLimits: { tab: "metrics", section: "saturation" },
  cost: { tab: "metrics", section: "tokens" },
}
// What "no data" says for each tile (sums are 0, not missing).
const EMPTY: Partial<Record<TileId, Key>> = {
  turns: "operator.dash.tile.noTurns",
  turnErrors: "operator.dash.tile.noTurns",
  turnTime: "operator.dash.tile.noTurns",
  approvalWait: "operator.dash.tile.noRequests",
}

const num = (value: number | null | undefined) => (typeof value === "number" ? value : null)

export function DashboardTiles(props: {
  data: OperatorDashboardTiles | undefined
  loading: boolean
  range: Range
  scope: { ns?: string; dir?: string }
}) {
  const language = useLanguage()
  const t = language.t
  const duration = useDuration()
  const locale = () => language.intl()
  const off = () => props.data?.enabled === false
  const tiles = () => props.data?.tiles as Data | undefined
  const percent = (value: number, digits = 1) =>
    new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: digits }).format(value / 100)
  const format = (id: TileId, value: number) => {
    const unit = UNIT[id]
    const approx = tiles()?.[id].approx && PERCENTILE[id] ? "≈ " : ""
    if (unit === "percent") return percent(value)
    if (unit === "ms") return `${approx}${duration(value)}`
    if (unit === "usd") return formatCost(value, locale())
    return formatCount(value, locale())
  }
  const previous = () => t(`operator.dash.previous.${props.range}` as Key)
  const rangeWords = () => t(`operator.dash.rangeWords.${props.range}` as Key)
  // The comparison line's short range ("14 d"); the tile's sentence has the words.
  const short = () => t(`operator.dash.rangeShort.${props.range}` as Key)
  const label = (id: TileId) => t(`operator.dash.tile.${id}` as Key)

  const amountOf = (change: Change) => {
    const size = Math.abs(change.value ?? 0)
    return change.kind === "points"
      ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(size)
      : percent(size, size < 10 ? 1 : 0)
  }
  const changeOf = (id: TileId): StatChange | undefined => {
    const tile = tiles()?.[id]
    if (!tile || num(tile.value) === null) return undefined
    const change = tile.change as Change
    const text =
      change.kind === "relative"
        ? t("operator.dash.change.relative", { amount: amountOf(change), range: short() })
        : change.kind === "points"
          ? t("operator.dash.change.points", { amount: amountOf(change), range: short() })
          : change.kind === "same"
            ? t("operator.dash.change.same")
            : t("operator.dash.change.insufficient")
    return { text, arrow: arrowOf(change), tone: toneOf(id, change) }
  }
  // The tile's full sentence (§6.2): "Turn errors 3.1%, down 0.8 percentage points from the previous 7 days".
  const sentence = (id: TileId) => {
    const tile = tiles()?.[id]
    if (off()) return t("operator.dash.sentence.none", { label: label(id), empty: t("operator.dash.tile.off") })
    if (!tile) return label(id)
    const value = num(tile.value)
    if (value === null)
      return t("operator.dash.sentence.none", {
        label: label(id),
        empty: t(EMPTY[id] ?? "operator.dash.tile.noTurns", { range: rangeWords() }),
      })
    const change = tile.change as Change
    const arrow = arrowOf(change)
    const fields = { label: label(id), value: format(id, value), amount: amountOf(change), previous: previous() }
    if (change.kind === "relative" && arrow) return t(`operator.dash.sentence.${arrow}` as Key, fields)
    if (change.kind === "points" && arrow) return t(`operator.dash.sentence.${arrow}Points` as Key, fields)
    if (change.kind === "insufficient") return t("operator.dash.sentence.insufficient", fields)
    return t("operator.dash.sentence.same", fields)
  }
  const hintOf = (id: TileId): string | undefined => {
    if (off()) return t("operator.dash.tile.off")
    const data = tiles()
    if (!data) return undefined
    const n = (value: number) => formatCount(value, locale())
    const parts: string[] = []
    if (num(data[id].value) === null && EMPTY[id]) return t(EMPTY[id]!, { range: rangeWords() })
    if (id === "turns") {
      const hint = data.turns.hint
      if (num(hint.sessions) !== null) parts.push(t("operator.dash.hint.sessions", { count: n(hint.sessions) }))
      parts.push(t("operator.dash.hint.running", { count: n(hint.running) }))
    }
    if (id === "turnErrors") {
      const hint = data.turnErrors.hint
      if (num(hint.failed) !== null) parts.push(t("operator.dash.hint.failed", { count: n(hint.failed) }))
      if (num(hint.denied) !== null) parts.push(t("operator.dash.hint.denied", { count: n(hint.denied) }))
      if (num(hint.toolErrorRate) !== null)
        parts.push(t("operator.dash.hint.toolErrors", { rate: percent(hint.toolErrorRate) }))
    }
    if (id === "turnTime") {
      const hint = data.turnTime.hint
      if (num(hint.p50) !== null) parts.push(t("operator.dash.hint.p50", { value: duration(hint.p50) }))
      parts.push(
        num(hint.ttftP95) !== null
          ? t("operator.dash.hint.ttft", { value: duration(hint.ttftP95) })
          : t("operator.dash.hint.noTtft"),
      )
    }
    if (id === "approvalWait") {
      const hint = data.approvalWait.hint
      parts.push(t("operator.dash.hint.requests", { count: n(hint.requests) }))
      if (num(hint.denied) !== null) parts.push(t("operator.dash.hint.denied", { count: n(hint.denied) }))
      parts.push(t("operator.dash.hint.waiting", { count: n(hint.waiting) }))
    }
    if (id === "rateLimits") {
      const hint = data.rateLimits.hint
      if (num(hint.retries) !== null) parts.push(t("operator.dash.hint.retries", { count: n(hint.retries) }))
      if (num(hint.contextP95) !== null)
        parts.push(t("operator.dash.hint.context", { value: percent(hint.contextP95, 0) }))
      if (num(hint.compactions) !== null)
        parts.push(t("operator.dash.hint.compactions", { count: n(hint.compactions) }))
    }
    if (id === "cost") {
      const hint = data.cost.hint
      if (num(hint.tokens) !== null) parts.push(t("operator.dash.hint.tokens", { count: n(hint.tokens) }))
      const budget = props.data?.budget
      if (budget)
        parts.push(
          t("operator.dash.hint.today", {
            today: formatCost(budget.today, locale()),
            limit: formatCost(budget.limit, locale()),
          }),
        )
    }
    return parts.join(" · ")
  }
  const trend = (id: TileId) => {
    const tile = tiles()?.[id]
    if (!tile) return undefined
    return trendOf(tile.series as Array<[number, number | null]>, !PERCENTILE[id] && UNIT[id] !== "percent")
  }
  const trendLabel = (id: TileId) => {
    const values = trend(id) ?? []
    if (values.length < 2) return label(id)
    return t("operator.dash.trend", {
      label: label(id),
      min: format(id, Math.min(...values)),
      max: format(id, Math.max(...values)),
    })
  }
  const progress = (id: TileId) => {
    const budget = props.data?.budget
    if (id !== "cost" || !budget || !budget.limit) return undefined
    const share = budget.today / budget.limit
    return {
      share,
      text: t("operator.dash.budgetShare", { percent: Math.round(share * 100) }),
      ...(share > 1 ? { tone: "warn" as const } : {}),
    }
  }

  return (
    <div data-slot="operator-dash-tiles" data-testid="dash-tiles">
      <For each={TILES}>
        {(id) => (
          <StatTile
            testId={`dash-tile-${id}`}
            label={label(id)}
            help={t(`operator.dash.help.tile.${id}` as Key)}
            loading={props.loading && !props.data}
            value={(() => {
              const value = num(tiles()?.[id].value)
              return value === null || off() ? "—" : format(id, value)
            })()}
            {...(changeOf(id) ? { change: changeOf(id)! } : {})}
            hint={hintOf(id)}
            {...(progress(id) ? { progress: progress(id)! } : {})}
            {...(off() ? {} : { trend: trend(id), trendLabel: trendLabel(id) })}
            href={hrefOf({ page: "observability", params: LINKS[id] }, props.scope, { range: props.range })}
            name={sentence(id)}
          />
        )}
      </For>
    </div>
  )
}
