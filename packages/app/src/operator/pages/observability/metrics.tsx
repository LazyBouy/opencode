import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorTelemetryMetric } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../../data"
import { formatCount, shortPath } from "../../format"
import { BarList } from "../../ui/charts/bar-list"
import { ChartFrame } from "../../ui/charts/chart-frame"
import { ChartTable } from "../../ui/charts/chart-table"
import { Histogram } from "../../ui/charts/histogram"
import { isoLocal } from "../../ui/charts/model"
import type { Tone } from "../../ui/charts/theme"
import { type ChartSeries, TimeChart } from "../../ui/charts/time-chart"
import { type Column, DataTable } from "../../ui/data-table"
import { FieldHelp } from "../../ui/field-help"
import { SelectV2 } from "../../ui/select"
import { useDuration } from "./parts"

// The Metrics tab (observability_spec.md §12): fixed, curated charts in seven collapsible sections, each with its
// Group by (top 5 + Other) and Compare (the previous period, dashed). A chart has (i), its unit, the source note
// ("From events" or "From hourly totals (≈)"), "Show as table" with CSV; a click on a point opens Events filtered to
// that step and series, and dragging zooms the page's range. Charts load when they scroll into view.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Metric = OperatorTelemetryMetric
type Mode = "lines" | "area" | "bars" | "histogram" | "table"
type Chart = { metric: string; mode: Mode; max?: number; whole?: boolean; threshold?: number; wide?: boolean }

export const SECTIONS: ReadonlyArray<{ id: string; groups: ReadonlyArray<string>; charts: ReadonlyArray<Chart> }> = [
  {
    id: "turns",
    groups: ["agent", "project", "model"],
    charts: [
      { metric: "turns", mode: "bars" },
      { metric: "turn_error_rate", mode: "lines" },
      { metric: "turn_active", mode: "lines" },
      { metric: "turn_wait", mode: "lines" },
    ],
  },
  {
    id: "calls",
    groups: ["model", "provider", "agent", "kind"],
    charts: [
      { metric: "calls", mode: "bars" },
      { metric: "call_errors", mode: "lines" },
      { metric: "retries", mode: "bars" },
      { metric: "call_duration", mode: "lines" },
      { metric: "ttft", mode: "lines" },
      { metric: "output_speed", mode: "lines" },
    ],
  },
  {
    id: "tokens",
    groups: ["model", "project", "agent"],
    charts: [
      { metric: "tokens", mode: "area" },
      { metric: "cache_hit", mode: "lines", max: 100 },
      { metric: "cost", mode: "bars" },
      { metric: "cost_per_turn", mode: "lines" },
      { metric: "cost_billed", mode: "lines" },
    ],
  },
  {
    id: "tools",
    groups: [],
    charts: [
      { metric: "tool_calls", mode: "bars" },
      { metric: "tool_errors", mode: "lines" },
      { metric: "tool_table", mode: "table", wide: true },
    ],
  },
  {
    id: "approvals",
    groups: [],
    charts: [
      { metric: "approvals", mode: "bars" },
      { metric: "approval_wait", mode: "lines" },
      { metric: "approval_pending", mode: "lines" },
      { metric: "approval_oldest", mode: "lines" },
      { metric: "approval_table", mode: "table", wide: true },
    ],
  },
  {
    id: "agents",
    groups: ["agent"],
    charts: [
      { metric: "calls_per_turn", mode: "histogram" },
      { metric: "tools_per_turn", mode: "histogram" },
      { metric: "loops", mode: "bars" },
      { metric: "subagents", mode: "bars" },
      { metric: "helpers", mode: "bars" },
      { metric: "helper_cost", mode: "bars" },
    ],
  },
  {
    id: "saturation",
    groups: [],
    charts: [
      { metric: "rate_limits", mode: "bars" },
      { metric: "context_used", mode: "lines", threshold: 80 },
      { metric: "compactions", mode: "bars" },
      { metric: "queue", mode: "lines" },
      { metric: "queue_oldest", mode: "lines" },
      { metric: "queue_wait", mode: "lines" },
      { metric: "mcp", mode: "area" },
      { metric: "mcp_errors", mode: "lines" },
      { metric: "running", mode: "lines" },
    ],
  },
]

/** Series names with words (en.ts operator.obs.metrics.series.*); other keys are values, shown as they are. */
export const SERIES_WORDS = [
  "turns",
  "errors",
  "denied",
  "ok_p50",
  "ok_p95",
  "failed_p50",
  "failed_p95",
  "p50",
  "p95",
  "calls",
  "http_429",
  "retries_exhausted",
  "retries",
  "input",
  "cache_read",
  "cache_write",
  "output",
  "reasoning",
  "cache_hit",
  "cost",
  "billed",
  "estimated",
  "tools",
  "denials",
  "requests",
  "pending",
  "oldest",
  "loops",
  "subagents",
  "helpers",
  "compactions",
  "depth",
  "servers",
  "running",
  "waiting",
] as const
const SPAN_STATUSES = new Set(["running", "ok", "error", "denied", "cancelled", "interrupted"])
const DECISIONS = new Set(["allow", "allow-session", "allow-agent", "deny", "cancelled"])
const DANGER = new Set([
  "error",
  "errors",
  "failed_p50",
  "failed_p95",
  "http_429",
  "retries_exhausted",
  "deny",
  "failed",
])
const WARNING = new Set(["denied", "denials", "interrupted", "needs_auth"])
const MUTED = new Set(["cancelled", "disabled"])
const SUCCESS = new Set(["ok", "allow", "connected"])
const toneOf = (key: string): Tone | undefined =>
  DANGER.has(key)
    ? "danger"
    : WARNING.has(key)
      ? "warning"
      : MUTED.has(key)
        ? "muted"
        : SUCCESS.has(key)
          ? "success"
          : undefined

/** Formats values by unit (§12.1): whole counts, durations in ms / s / min, $ with at most 4 significant digits, % with one decimal. */
export function useUnitFormat() {
  const language = useLanguage()
  const duration = useDuration()
  return (unit: string) =>
    (value: number): string => {
      const locale = language.intl()
      if (unit === "ms") return duration(value) || "0"
      if (unit === "percent")
        return new Intl.NumberFormat(locale, {
          style: "percent",
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(value / 100)
      if (unit === "usd")
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumSignificantDigits: 4,
        }).format(value)
      if (unit === "tps")
        return language.t("operator.obs.tokensPerSecond", {
          n: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value),
        })
      return formatCount(value, locale)
    }
}

export function MetricsTab(props: {
  query: Record<string, string>
  refresh: number | false
  rangeLabel: string
  groups: Record<string, string>
  onGroup: (section: string, key: string | undefined) => void
  compare: ReadonlyArray<string>
  onCompare: (section: string, on: boolean) => void
  closed: ReadonlyArray<string>
  onToggle: (section: string) => void
  focus?: string
  eventsDays: number
  /** Context limits by "provider/model", for Context used. */
  limits: Record<string, number>
  onEvents: (filter: Record<string, string>, from: number, to: number) => void
  onZoom: (from: number, to: number) => void
}) {
  const t = useLanguage().t
  onMount(() => {
    if (!props.focus) return
    requestAnimationFrame(() =>
      document.getElementById(`obs-section-${props.focus}`)?.scrollIntoView({ block: "start" }),
    )
  })
  return (
    <div data-component="operator-obs-metrics">
      <For each={SECTIONS}>
        {(section) => {
          const open = () => !props.closed.includes(section.id) || props.focus === section.id
          return (
            <section data-slot="operator-obs-section" id={`obs-section-${section.id}`} data-testid="obs-section">
              <header>
                <ButtonV2
                  size="small"
                  variant="ghost"
                  aria-expanded={open()}
                  aria-controls={`obs-section-body-${section.id}`}
                  onClick={() => props.onToggle(section.id)}
                >
                  <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
                  <h3>{t(`operator.obs.metrics.section.${section.id}` as Key)}</h3>
                </ButtonV2>
                <FieldHelp
                  field={t(`operator.obs.metrics.section.${section.id}` as Key)}
                  text={t(`operator.obs.metrics.sectionHelp.${section.id}` as Key)}
                />
                <Show when={section.groups.length}>
                  <span class="inline-flex items-center gap-1">
                    <SelectV2<string>
                      appearance="base"
                      aria-label={t("operator.obs.metrics.groupBy")}
                      options={["", ...section.groups]}
                      current={props.groups[section.id] ?? ""}
                      label={(key) =>
                        key
                          ? t("operator.obs.metrics.groupByValue", {
                              name: t(`operator.obs.metrics.group.${key}` as Key),
                            })
                          : t("operator.obs.metrics.noGroup")
                      }
                      onSelect={(key) => props.onGroup(section.id, key || undefined)}
                    />
                    <FieldHelp field={t("operator.obs.metrics.groupBy")} text={t("operator.obs.help.groupBy")} />
                  </span>
                </Show>
                <span class="inline-flex items-center">
                  <CheckboxV2
                    label={t("operator.obs.metrics.compare")}
                    checked={props.compare.includes(section.id)}
                    onChange={(checked: boolean) => props.onCompare(section.id, checked)}
                  />
                  <FieldHelp field={t("operator.obs.metrics.compare")} text={t("operator.obs.help.compare")} />
                </span>
              </header>
              <Show when={open()}>
                <div data-slot="operator-obs-charts" id={`obs-section-body-${section.id}`}>
                  <For each={section.charts}>
                    {(chart) => (
                      <MetricChart
                        chart={chart}
                        query={props.query}
                        refresh={props.refresh}
                        rangeLabel={props.rangeLabel}
                        groupBy={props.groups[section.id]}
                        compare={props.compare.includes(section.id)}
                        eventsDays={props.eventsDays}
                        limits={props.limits}
                        onEvents={props.onEvents}
                        onZoom={props.onZoom}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </section>
          )
        }}
      </For>
    </div>
  )
}

const SAMPLES = new Set(["approval_pending", "approval_oldest", "queue", "queue_oldest", "mcp", "running"])
const SUMS = new Set(["count", "usd", "tokens"])

function MetricChart(props: {
  chart: Chart
  query: Record<string, string>
  refresh: number | false
  rangeLabel: string
  groupBy: string | undefined
  compare: boolean
  eventsDays: number
  limits: Record<string, number>
  onEvents: (filter: Record<string, string>, from: number, to: number) => void
  onZoom: (from: number, to: number) => void
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const unitFormat = useUnitFormat()
  const [asTable, setAsTable] = createSignal(false)
  // Charts load once they scroll into view.
  const [seen, setSeen] = createSignal(false)
  let frame: HTMLDivElement | undefined
  onMount(() => {
    if (!frame || typeof IntersectionObserver === "undefined") return setSeen(true)
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setSeen(true)
        observer.disconnect()
      },
      { rootMargin: "200px" },
    )
    observer.observe(frame)
    onCleanup(() => observer.disconnect())
  })
  const params = () => ({
    ...props.query,
    metric: props.chart.metric,
    ...(props.groupBy ? { groupBy: props.groupBy } : {}),
  })
  const metric = useQuery(() => ({
    queryKey: api.key("telemetry-metric", params()),
    enabled: seen(),
    refetchInterval: props.refresh,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.metrics(params(), { throwOnError: true })
        .then((result) => result.data!),
  }))
  const result = () => ready(metric)
  // The previous period of the same length, on the same step (§12.1).
  const previous = useQuery(() => {
    const found = result()
    const length = found ? found.to - found.from : 0
    const { range: _range, ...rest } = params() as Record<string, string>
    const query = { ...rest, from: String((found?.from ?? 0) - length), to: String(found?.from ?? 0) }
    return {
      queryKey: api.key("telemetry-metric-previous", query, found?.step),
      enabled: props.compare && !!found && props.chart.mode !== "table" && props.chart.mode !== "histogram",
      queryFn: () =>
        api
          .client()
          .operator.telemetry.metrics(
            { ...query, metric: props.chart.metric, step: String(found!.step) },
            { throwOnError: true },
          )
          .then((answer) => answer.data!),
    }
  })

  const title = () => t(`operator.obs.metrics.chart.${props.chart.metric}` as Key)
  const help = () => t(`operator.obs.metrics.help.${props.chart.metric}` as Key)
  // Context used is shown as a share of each model's context (where its limit is known).
  const context = () => props.chart.metric === "context_used"
  const unit = () => (context() ? "percent" : (result()?.unit ?? "count"))
  const format = () => unitFormat(unit())
  const labelOf = (key: string, found: Metric, line: boolean | undefined) => {
    if (key === "Other") return t("operator.obs.metrics.other")
    if (!found.split || line)
      return (SERIES_WORDS as ReadonlyArray<string>).includes(key)
        ? t(`operator.obs.metrics.series.${key}` as Key)
        : key
    if (!key) return "—"
    if (found.split === "status" && !SAMPLES.has(props.chart.metric) && SPAN_STATUSES.has(key))
      return t(`operator.obs.status.span.${key}` as Key)
    if (found.split === "decision" && DECISIONS.has(key)) return t(`operator.obs.metrics.decision.${key}` as Key)
    if (found.split === "project") return shortPath(key)
    if (found.split === "providerModel") return key.slice(key.indexOf("/") + 1)
    return key
  }
  const unknownLimits = createMemo(() =>
    context() ? (result()?.series ?? []).filter((series) => !props.limits[series.key]).map((series) => series.key) : [],
  )
  const series = createMemo<ChartSeries[]>(() => {
    const found = result()
    if (!found) return []
    return found.series
      .filter((item) => !context() || props.limits[item.key])
      .map((item) => {
        const values = (item.points as Array<Array<number | null>>).map((point) => point[1] ?? null)
        const limit = context() ? props.limits[item.key]! : undefined
        return {
          key: item.key,
          label: labelOf(item.key, found, item.line),
          values: limit ? values.map((value) => (value === null ? null : (value / limit) * 100)) : values,
          ...(toneOf(item.key) ? { tone: toneOf(item.key)! } : {}),
          ...(item.line ? { line: true } : {}),
        }
      })
  })
  const times = () => (result()?.series[0]?.points ?? []).map((point) => point[0] as number)
  const compare = createMemo(() => {
    const before = props.compare ? ready(previous) : undefined
    if (!before) return undefined
    const lines = before.series.map((item) =>
      (item.points as Array<Array<number | null>>).map((point) => point[1] ?? null),
    )
    if (props.chart.mode === "lines") {
      const byKey = new Map(before.series.map((item, index) => [item.key, lines[index]!]))
      return series().map((item) => byKey.get(item.key) ?? [])
    }
    // Stacked: the previous period's total.
    const stacked = before.series.filter((item) => !item.line).map((item) => before.series.indexOf(item))
    return [times().map((_, at) => stacked.reduce((sum, index) => sum + (lines[index]?.[at] ?? 0), 0))]
  })
  const has = () =>
    series().some((item) => item.values.some((value) => value !== null && (value !== 0 || !SUMS.has(unit()))))
  const empty = () => {
    const found = result()
    if (!found) return undefined
    if (found.note === "needs-events") return t("operator.obs.metrics.needsEvents", { days: props.eventsDays })
    if (found.note === "needs-recording") return t("operator.obs.noRecording")
    if (props.chart.mode === "table") return found.table?.length ? undefined : t(emptyKey(found.kind))
    if (context() && !series().length && unknownLimits().length) return t("operator.obs.metrics.noLimits")
    return has()
      ? undefined
      : SAMPLES.has(props.chart.metric)
        ? t("operator.obs.metrics.empty.samples")
        : t(emptyKey(found.kind))
  }
  const note = (): JSX.Element | undefined => {
    const found = result()
    if (!found) return undefined
    const ignored = (found.ignored ?? []).map((name) =>
      name === "groupBy" ? t("operator.obs.metrics.groupBy") : t(`operator.obs.filter.${name}` as Key),
    )
    return (
      <>
        <span>
          {found.source === "totals" ? t("operator.obs.metrics.fromTotals") : t("operator.obs.metrics.fromEvents")}
        </span>
        <Show when={ignored.length}>
          <span> · {t("operator.obs.metrics.ignored", { names: ignored.join(", ") })}</span>
        </Show>
        <Show when={unknownLimits().length && series().length}>
          <span> · {t("operator.obs.metrics.unknownLimits", { models: unknownLimits().join(", ") })}</span>
        </Show>
      </>
    )
  }
  const formatTime = (time: number) =>
    DateTime.fromMillis(time)
      .setLocale(language.intl())
      .toLocaleString({ ...DateTime.DATETIME_MED_WITH_SECONDS, timeZoneName: "short" })
  // The accessible name: e.g. "Model calls, Last 24 hours: 1,204".
  const summary = () => {
    const total = SUMS.has(unit())
      ? series()
          .filter((item) => !item.line)
          .reduce((sum, item) => sum + item.values.reduce<number>((acc, value) => acc + (value ?? 0), 0), 0)
      : undefined
    return total !== undefined
      ? `${title()}, ${props.rangeLabel}: ${format()(total)}`
      : `${title()}, ${props.rangeLabel}`
  }
  const openPoint = (index: number, time: number) => {
    const found = result()
    if (!found) return
    const picked =
      index >= 0 ? found.series[found.series.findIndex((item) => item.key === series()[index]?.key)] : undefined
    props.onEvents({ ...(found.kind ? { kind: found.kind } : {}), ...(picked?.filter ?? {}) }, time, time + found.step)
  }
  const table = () => {
    const found = result()
    if (!found) return <></>
    if (props.chart.mode === "histogram")
      return (
        <ChartTable
          label={title()}
          filename={props.chart.metric}
          header={[t("operator.obs.metrics.bucket"), ...series().map((item) => item.label)]}
          rows={(found.buckets ?? []).map((bucket, at) => [
            bucket,
            ...series().map((item) => format()(item.values[at] ?? 0)),
          ])}
          raw={(found.buckets ?? []).map((bucket, at) => [bucket, ...series().map((item) => item.values[at] ?? null)])}
        />
      )
    return (
      <ChartTable
        label={title()}
        filename={props.chart.metric}
        header={[t("operator.obs.metrics.time"), ...series().map((item) => item.label)]}
        rows={times().map((time, at) => [
          formatTime(time),
          ...series().map((item) => (item.values[at] === null ? "" : format()(item.values[at]!))),
        ])}
        raw={times().map((time, at) => [isoLocal(time), ...series().map((item) => item.values[at] ?? null)])}
      />
    )
  }

  return (
    <div ref={frame} data-slot="operator-obs-chart-cell" data-wide={props.chart.wide ? "" : undefined}>
      <ChartFrame
        id={props.chart.metric}
        title={title()}
        help={help()}
        unit={t(`operator.obs.metrics.unit.${unit()}` as Key)}
        note={note()}
        loading={!seen() || metric.isPending}
        {...(metric.isError ? { error: String((metric.error as Error | undefined)?.message ?? metric.error) } : {})}
        onRetry={() => void metric.refetch()}
        {...(empty() ? { empty: empty()! } : {})}
        {...(props.chart.mode === "table" ? {} : { table })}
        asTable={asTable()}
        onAsTable={setAsTable}
        wide={props.chart.wide}
      >
        <Show when={result()}>
          {(found) => (
            <Show
              when={props.chart.mode === "table"}
              fallback={
                <Show
                  when={props.chart.mode === "histogram"}
                  fallback={
                    <>
                      <TimeChart
                        times={times()}
                        step={found().step}
                        from={found().from}
                        to={found().to}
                        series={series()}
                        mode={props.chart.mode as "lines" | "area" | "bars"}
                        {...(compare()
                          ? { compare: compare()!, compareLabel: t("operator.obs.metrics.previous") }
                          : {})}
                        {...(props.chart.threshold !== undefined ? { threshold: props.chart.threshold } : {})}
                        {...(props.chart.max !== undefined ? { max: props.chart.max } : {})}
                        format={format()}
                        formatTime={formatTime}
                        label={summary()}
                        onPoint={openPoint}
                        onZoom={props.onZoom}
                      />
                      <Show when={found().split && SUMS.has(unit()) && props.groupBy}>
                        <BarList
                          label={t("operator.obs.metrics.totals", { name: title() })}
                          rows={series()
                            .filter((item) => !item.line)
                            .map((item) => ({
                              key: item.key,
                              label: item.label,
                              value: item.values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
                              display: format()(item.values.reduce<number>((sum, value) => sum + (value ?? 0), 0)),
                              ...(item.tone ? { tone: item.tone } : {}),
                              ...(item.key === "Other" ? { members: found().other } : {}),
                            }))}
                          membersLabel={(count) => t("operator.obs.metrics.otherMembers", { n: count })}
                          onOpen={(row) => {
                            const picked = found().series.find((item) => item.key === row.key)
                            props.onEvents(
                              { ...(found().kind ? { kind: found().kind! } : {}), ...(picked?.filter ?? {}) },
                              found().from,
                              found().to,
                            )
                          }}
                        />
                      </Show>
                    </>
                  }
                >
                  <Histogram
                    buckets={found().buckets ?? []}
                    series={series()}
                    format={format()}
                    label={summary()}
                    barLabel={(bucket, item, value) =>
                      t("operator.obs.metrics.barLabel", {
                        bucket,
                        series: item.label,
                        n: formatCount(value, language.intl()),
                      })
                    }
                  />
                </Show>
              }
            >
              <Show
                when={props.chart.metric === "tool_table"}
                fallback={
                  <ApprovalTable
                    rows={found().table ?? []}
                    onOpen={() => props.onEvents({ kind: "permission_wait" }, found().from, found().to)}
                  />
                }
              >
                <ToolTable
                  rows={found().table ?? []}
                  onOpen={(row) =>
                    props.onEvents(
                      { kind: "tool_call", ...(row.mcp ? { mcp: String(row.tool) } : { tool: String(row.tool) }) },
                      found().from,
                      found().to,
                    )
                  }
                />
              </Show>
            </Show>
          )}
        </Show>
      </ChartFrame>
    </div>
  )
}

const emptyKey = (kind: string | undefined) => `operator.obs.metrics.empty.${kind ?? "any"}` as Key

type Row = Record<string, string | number | null>

function ToolTable(props: { rows: ReadonlyArray<Row>; onOpen: (row: Row) => void }) {
  const language = useLanguage()
  const t = language.t
  const duration = useDuration()
  const unit = useUnitFormat()
  const n = (value: unknown) => formatCount(Number(value ?? 0), language.intl())
  const columns: Column<Row>[] = [
    {
      id: "tool",
      header: t("operator.obs.col.tool"),
      help: t("operator.obs.help.tableTool"),
      value: (row) => row.tool,
      cell: (row) =>
        row.mcp ? t("operator.obs.metrics.mcpServer", { name: String(row.tool) }) : String(row.tool) || "—",
    },
    {
      id: "calls",
      align: "end",
      header: t("operator.obs.metrics.col.calls"),
      help: t("operator.obs.help.tableCalls"),
      value: (row) => row.calls,
      cell: (row) => n(row.calls),
    },
    {
      id: "errors",
      align: "end",
      header: t("operator.obs.metrics.col.errors"),
      help: t("operator.obs.help.tableErrors"),
      value: (row) => row.errors,
      cell: (row) => n(row.errors),
    },
    {
      id: "error_rate",
      align: "end",
      header: t("operator.obs.metrics.col.errorRate"),
      help: t("operator.obs.help.tableErrorRate"),
      value: (row) => row.error_rate,
      cell: (row) => unit("percent")(Number(row.error_rate ?? 0)),
    },
    {
      id: "denials",
      align: "end",
      header: t("operator.obs.metrics.col.denials"),
      help: t("operator.obs.help.tableDenials"),
      value: (row) => row.denials,
      cell: (row) => n(row.denials),
    },
    {
      id: "p50",
      align: "end",
      header: t("operator.obs.metrics.col.p50"),
      help: t("operator.obs.help.tableP50"),
      value: (row) => row.p50,
      cell: (row) => (row.p50 === null ? "" : duration(Number(row.p50))),
    },
    {
      id: "p95",
      align: "end",
      header: t("operator.obs.metrics.col.p95"),
      help: t("operator.obs.help.tableP95"),
      value: (row) => row.p95,
      cell: (row) => (row.p95 === null ? "" : duration(Number(row.p95))),
    },
    {
      id: "wait",
      align: "end",
      optional: true,
      header: t("operator.obs.metrics.col.wait"),
      help: t("operator.obs.help.tableWait"),
      value: (row) => row.wait,
      cell: (row) => duration(Number(row.wait ?? 0)),
    },
  ]
  return (
    <DataTable<Row>
      label={t("operator.obs.metrics.chart.tool_table")}
      rows={props.rows}
      columns={columns}
      columnsKey="observability-tool-table"
      initialSort={{ column: "calls", direction: "desc" }}
      search={(row) => String(row.tool ?? "")}
      onRowClick={props.onOpen}
      rowAttrs={() => ({ "data-testid": "obs-tool-row" })}
    />
  )
}

function ApprovalTable(props: { rows: ReadonlyArray<Row>; onOpen: (row: Row) => void }) {
  const language = useLanguage()
  const t = language.t
  const duration = useDuration()
  const unit = useUnitFormat()
  const columns: Column<Row>[] = [
    {
      id: "permission",
      header: t("operator.obs.metrics.col.permission"),
      help: t("operator.obs.help.tablePermission"),
      value: (row) => row.permission,
      cell: (row) => String(row.permission) || "—",
    },
    {
      id: "requests",
      align: "end",
      header: t("operator.obs.metrics.col.requests"),
      help: t("operator.obs.help.tableRequests"),
      value: (row) => row.requests,
      cell: (row) => formatCount(Number(row.requests ?? 0), language.intl()),
    },
    {
      id: "allowed",
      align: "end",
      header: t("operator.obs.metrics.col.allowed"),
      help: t("operator.obs.help.tableAllowed"),
      value: (row) => row.allowed,
      cell: (row) => unit("percent")(Number(row.allowed ?? 0)),
    },
    {
      id: "p95",
      align: "end",
      header: t("operator.obs.metrics.col.p95Wait"),
      help: t("operator.obs.help.tableP95Wait"),
      value: (row) => row.p95,
      cell: (row) => (row.p95 === null ? "" : duration(Number(row.p95))),
    },
    {
      id: "decided_by",
      header: t("operator.obs.metrics.col.decidedBy"),
      help: t("operator.obs.help.tableDecidedBy"),
      value: (row) => row.decided_by,
      cell: (row) => String(row.decided_by ?? ""),
    },
  ]
  return (
    <DataTable<Row>
      label={t("operator.obs.metrics.chart.approval_table")}
      rows={props.rows}
      columns={columns}
      columnsKey="observability-approval-table"
      initialSort={{ column: "requests", direction: "desc" }}
      search={(row) => String(row.permission ?? "")}
      onRowClick={props.onOpen}
    />
  )
}
