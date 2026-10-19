import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import type { OperatorTelemetryMetric } from "@opencode-ai/sdk/v2/client"
import { A, useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import { createMemo, createSignal, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../../data"
import { formatCost, formatCount, shortPath } from "../../format"
import { ChartFrame } from "../../ui/charts/chart-frame"
import { ChartTable } from "../../ui/charts/chart-table"
import { isoLocal } from "../../ui/charts/model"
import { type ChartSeries, TimeChart } from "../../ui/charts/time-chart"
import { FieldHelp } from "../../ui/field-help"
import { SelectV2 } from "../../ui/select"
import { SERIES_WORDS, toneOf, useUnitFormat } from "../observability/metrics"
import { hrefOf } from "./model"

// The two charts (dashboard_spec.md §7), with Observability's chart components and the Metrics tab's steps for the
// range: Activity (turns per step by outcome, each with its pattern, the legend with totals) and Spend (Cost by model,
// project or agent, top 5 + Other, or Tokens by type, never one mixed total). With a daily budget the Cost view of 7
// to 30 days steps by day and draws the budget (the user's choice, 2026-10-19: the Metrics steps are never a day on
// these ranges). Each has (i), its unit, "Show as table"; a click opens Events for that step, filtered as the chart
// is; dragging zooms the page's range. uPlot loads with the charts, after the strip and tiles.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Metric = OperatorTelemetryMetric
export type SpendView = "cost" | "tokens"
export type SpendBy = "model" | "project" | "agent"
const DAY = 86_400_000
const REFRESH = 60_000
// Outcomes bottom to top (§7.1).
const OUTCOMES = ["ok", "error", "denied", "cancelled", "interrupted", "running"]
const BY: ReadonlyArray<SpendBy> = ["model", "project", "agent"]
// Lower than Observability's charts, so the page fits one screen (§3).
const HEIGHT = 160

type ChartProps = {
  /** The range (`range`, or `from` and `to`) and scope, as the API takes them. */
  query: Record<string, string>
  scope: { ns?: string; dir?: string }
  rangeLabel: string
  /** Known whether telemetry is on (the strip or the tiles answered): the charts ask only then. */
  known: boolean
  off: boolean
  onZoom: (from: number, to: number) => void
}

function useMetric(props: ChartProps, params: () => Record<string, string>) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("telemetry-metric", { ...props.query, ...params() }),
    enabled: props.known && !props.off,
    refetchInterval: REFRESH,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.metrics({ ...props.query, ...params() } as never, { throwOnError: true })
        .then((result) => result.data!),
  }))
}

function useChartParts(props: ChartProps) {
  const language = useLanguage()
  const navigate = useNavigate()
  const formatTime = (time: number) =>
    DateTime.fromMillis(time).setLocale(language.intl()).toLocaleString(DateTime.DATETIME_MED)
  const times = (found: Metric | undefined) => (found?.series[0]?.points ?? []).map((point) => point[0] as number)
  const valuesOf = (item: Metric["series"][number]) =>
    (item.points as Array<Array<number | null>>).map((point) => point[1] ?? null)
  // A click on a step: Observability's Events for that step and series, in the page's scope.
  const open = (found: Metric | undefined, series: ReadonlyArray<ChartSeries>, index: number, time: number) => {
    if (!found) return
    const picked = index >= 0 ? found.series.find((item) => item.key === series[index]?.key) : undefined
    navigate(
      hrefOf(
        {
          page: "observability",
          params: {
            tab: "events",
            ...(found.kind ? { kind: found.kind } : {}),
            ...((picked?.filter ?? {}) as Record<string, string>),
            from: String(time),
            to: String(time + found.step),
          },
        },
        props.scope,
      ),
    )
  }
  const table = (
    title: string,
    id: string,
    found: Metric | undefined,
    series: ReadonlyArray<ChartSeries>,
    format: (value: number) => string,
  ) => (
    <ChartTable
      label={title}
      filename={`dashboard-${id}`}
      header={[language.t("operator.obs.metrics.time"), ...series.map((item) => item.label)]}
      rows={times(found).map((time, at) => [
        formatTime(time),
        ...series.map((item) => (item.values[at] === null ? "" : format(item.values[at]!))),
      ])}
      raw={times(found).map((time, at) => [isoLocal(time), ...series.map((item) => item.values[at] ?? null)])}
    />
  )
  const total = (series: ReadonlyArray<ChartSeries>) =>
    series.reduce((sum, item) => sum + item.values.reduce<number>((acc, value) => acc + (value ?? 0), 0), 0)
  return { formatTime, times, valuesOf, open, table, total }
}

/** Activity (§7.1): turns started per step, stacked by how they ended. */
export function ActivityChart(props: ChartProps) {
  const language = useLanguage()
  const t = language.t
  const parts = useChartParts(props)
  const [asTable, setAsTable] = createSignal(false)
  const metric = useMetric(props, () => ({ metric: "turns" }))
  const found = () => ready(metric)
  const series = createMemo<ChartSeries[]>(() => {
    const result = found()
    if (!result) return []
    const order = (key: string) => (OUTCOMES.includes(key) ? OUTCOMES.indexOf(key) : OUTCOMES.length)
    return result.series
      .toSorted((a, b) => order(a.key) - order(b.key))
      .map((item) => {
        const values = parts.valuesOf(item)
        const sum = values.reduce<number>((acc, value) => acc + (value ?? 0), 0)
        const word = OUTCOMES.includes(item.key) ? t(`operator.obs.status.span.${item.key}` as Key) : item.key || "—"
        return {
          key: item.key,
          label: t("operator.dash.chart.legendTotal", { label: word, total: formatCount(sum, language.intl()) }),
          values,
          ...(toneOf(item.key) ? { tone: toneOf(item.key)! } : {}),
        }
      })
  })
  const format = (value: number) => formatCount(value, language.intl())
  const title = () => t("operator.dash.chart.activity")
  const empty = () => (found() && !parts.total(series()) ? t("operator.dash.chart.noTurns") : undefined)
  return (
    <Frame off={props.off} id="activity">
      <ChartFrame
        id="dash-activity"
        level={2}
        title={title()}
        help={t("operator.dash.help.activity")}
        unit={t("operator.obs.metrics.unit.count")}
        loading={metric.isPending}
        {...(metric.isError ? { error: String((metric.error as Error | undefined)?.message ?? metric.error) } : {})}
        onRetry={() => void metric.refetch()}
        {...(empty() ? { empty: empty()! } : {})}
        table={() => parts.table(title(), "activity", found(), series(), format)}
        asTable={asTable()}
        onAsTable={setAsTable}
      >
        <Show when={found()}>
          {(result) => (
            <TimeChart
              times={parts.times(result())}
              step={result().step}
              from={result().from}
              to={result().to}
              series={series()}
              mode="bars"
              height={HEIGHT}
              format={format}
              formatTime={parts.formatTime}
              label={`${title()}, ${props.rangeLabel}: ${format(parts.total(series()))}`}
              onPoint={(index, time) => parts.open(result(), series(), index, time)}
              onZoom={props.onZoom}
            />
          )}
        </Show>
      </ChartFrame>
    </Frame>
  )
}

/** Spend (§7.2): Cost by model, project or agent (top 5 + Other), or Tokens by type. */
export function SpendChart(
  props: ChartProps & {
    view: SpendView
    by: SpendBy
    onView: (view: SpendView) => void
    onBy: (by: SpendBy) => void
    /** The daily budget, if one is set. */
    budget: number | null
    /** A preset of 7 days or more (a day per step can carry the budget). */
    days: boolean
  },
) {
  const language = useLanguage()
  const t = language.t
  const parts = useChartParts(props)
  const unitFormat = useUnitFormat()
  const [asTable, setAsTable] = createSignal(false)
  const daily = () => props.view === "cost" && props.budget !== null && props.days
  const metric = useMetric(props, () =>
    props.view === "tokens"
      ? { metric: "tokens" }
      : { metric: "cost", groupBy: props.by, ...(daily() ? { step: String(DAY) } : {}) },
  )
  const found = () => ready(metric)
  const series = createMemo<ChartSeries[]>(() => {
    const result = found()
    if (!result) return []
    return result.series.map((item) => {
      const label =
        item.key === "Other"
          ? t("operator.obs.metrics.other")
          : props.view === "tokens" && (SERIES_WORDS as ReadonlyArray<string>).includes(item.key)
            ? t(`operator.obs.metrics.series.${item.key}` as Key)
            : result.split === "project"
              ? shortPath(item.key)
              : item.key || "—"
      return { key: item.key, label, values: parts.valuesOf(item), ...(item.line ? { line: true } : {}) }
    })
  })
  const format = () => unitFormat(props.view === "tokens" ? "tokens" : "usd")
  const title = () => t("operator.dash.chart.spend")
  const empty = () => (found() && !parts.total(series()) ? t("operator.dash.chart.noSpend") : undefined)
  // The budget line: only on a day per step.
  const threshold = () => (daily() && found()?.step === DAY ? props.budget! : undefined)
  const actions = (
    <span class="inline-flex flex-wrap items-center gap-2" data-slot="operator-dash-chart-actions">
      <SegmentedControlV2
        aria-label={t("operator.dash.spend.view")}
        value={props.view}
        onChange={(value) => value && props.onView(value as SpendView)}
        data-testid="dash-spend-view"
      >
        <SegmentedControlItemV2 value="cost">{t("operator.dash.spend.cost")}</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="tokens">{t("operator.dash.spend.tokens")}</SegmentedControlItemV2>
      </SegmentedControlV2>
      <Show when={props.view === "cost"}>
        <span class="inline-flex items-center gap-1" data-testid="dash-spend-by">
          <SelectV2<SpendBy>
            appearance="base"
            aria-label={t("operator.dash.spend.by")}
            options={[...BY]}
            current={props.by}
            label={(key) =>
              t("operator.obs.metrics.groupByValue", { name: t(`operator.obs.metrics.group.${key}` as Key) })
            }
            onSelect={(key) => key && props.onBy(key)}
          />
          <FieldHelp field={t("operator.dash.spend.by")} text={t("operator.dash.help.spendBy")} />
        </span>
      </Show>
    </span>
  )
  return (
    <Frame off={props.off} id="spend">
      <ChartFrame
        id="dash-spend"
        level={2}
        title={title()}
        help={props.view === "tokens" ? t("operator.dash.help.spendTokens") : t("operator.dash.help.spendCost")}
        unit={t(`operator.obs.metrics.unit.${props.view === "tokens" ? "tokens" : "usd"}` as Key)}
        actions={actions}
        {...(threshold() !== undefined
          ? {
              note: (
                <span data-testid="dash-budget-note">
                  {t("operator.dash.budgetLine", { amount: formatCost(threshold()!, language.intl()) })}
                </span>
              ),
            }
          : {})}
        loading={metric.isPending}
        {...(metric.isError ? { error: String((metric.error as Error | undefined)?.message ?? metric.error) } : {})}
        onRetry={() => void metric.refetch()}
        {...(empty() ? { empty: empty()! } : {})}
        table={() => parts.table(title(), `spend-${props.view}`, found(), series(), format())}
        asTable={asTable()}
        onAsTable={setAsTable}
      >
        <Show when={found()}>
          {(result) => (
            <TimeChart
              times={parts.times(result())}
              step={result().step}
              from={result().from}
              to={result().to}
              series={series()}
              mode={props.view === "tokens" ? "area" : "bars"}
              height={HEIGHT}
              {...(threshold() !== undefined ? { threshold: threshold()! } : {})}
              format={format()}
              formatTime={parts.formatTime}
              label={`${title()}, ${props.rangeLabel}: ${format()(parts.total(series().filter((item) => !item.line)))}`}
              onPoint={(index, time) => parts.open(result(), series(), index, time)}
              onZoom={props.onZoom}
            />
          )}
        </Show>
      </ChartFrame>
    </Frame>
  )
}

/** A chart's place in the grid; telemetry off says so (§9.3). */
function Frame(props: { off: boolean; id: string; children: JSX.Element }) {
  const t = useLanguage().t
  return (
    <div data-slot="operator-dash-chart" data-testid={`dash-chart-${props.id}`}>
      <Show
        when={!props.off}
        fallback={
          <section data-component="operator-chart-frame" aria-labelledby={`dash-chart-${props.id}-off`}>
            <header>
              <h2 id={`dash-chart-${props.id}-off`}>
                {props.id === "activity" ? t("operator.dash.chart.activity") : t("operator.dash.chart.spend")}
              </h2>
            </header>
            <div data-slot="operator-panel-empty" data-testid="dash-telemetry-off">
              <span>{t("operator.dash.tile.off")}</span>{" "}
              <A href="/operator/observability?settings=1" data-slot="operator-link">
                {t("operator.dash.openSettings")}
              </A>
            </div>
          </section>
        }
      >
        {props.children}
      </Show>
    </div>
  )
}
