import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import type { OperatorDashboardItem, OperatorPendingPermission } from "@opencode-ai/sdk/v2/client"
import { useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { Persist, persisted } from "@/utils/persist"
import { asList, ready, useOperatorClient } from "../../data"
import { useOperatorScope } from "../../scope"
import { FieldHelp } from "../../ui/field-help"
import { NamespacePicker } from "../../ui/namespace-picker"
import { PageHeader } from "../../ui/page-header"
import { ScopePicker } from "../../ui/scope-picker"
import { ServerChip, useServerHealth } from "../../ui/server-chip"
import { useSessionOverlay } from "../session-overlay"
import { AttentionStrip } from "./attention"
import { ActivityChart, type SpendBy, SpendChart, type SpendView } from "./charts"
import { RANGES, type Range, rangeOf, throttle } from "./model"
import { AgentsPanel, RecentSessions, RunningNow, ToolsPanel } from "./panels"
import { DashboardTiles } from "./tiles"
import "../observability/observability.css"
import "./dashboard.css"

// The Dashboard (dashboard_spec.md): "is everything all right, and what needs me?" on one screen. The operator
// console's home page. One range (24 h to 30 d, in the URL) and one scope (namespace and project, in the URL) for the
// whole page; the attention strip and Running now always show now. It shows; Observability investigates: every number
// links there, filtered. The strip and Running now are live (approval, status and telemetry events, at most once
// every 2 s, and every 30 s); tiles and panels refresh every 60 s; hidden, the page pauses and catches up when shown.
// Six requests on load: attention (with Running now), tiles, the two charts, recent sessions, and the breakdowns.

const LIVE = 30_000
const SLOW = 60_000
const BURST = 2_000
const LIVE_EVENTS = new Set(["permission.asked", "permission.replied", "session.status", "operator.telemetry.written"])
const CRITICAL_WAIT = 30 * 60_000

export default function DashboardPage() {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const sdk = useServerSDK()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams<{ range?: string; ns?: string; from?: string; to?: string }>()
  const scope = useOperatorScope()
  const [prefs, setPrefs] = persisted(
    Persist.global("operator.dashboard"),
    createStore({ days: 14 as number, range: "" as string, spend: "cost" as SpendView, by: "model" as SpendBy }),
  )
  const range = (): Range => rangeOf(params.range, prefs)
  // A zoom on a chart: a custom range in the URL (from, to) until Reset (§7).
  const custom = () => {
    const from = Number(params.from)
    const to = Number(params.to)
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : undefined
  }
  const setRange = (value: Range) => {
    setPrefs("range", value)
    setParams({ range: value, from: undefined, to: undefined })
  }
  const zoom = (from: number, to: number) => setParams({ from: String(from), to: String(to) })
  // The range as the API takes it, and as links carry it.
  const rangeParams = (): Record<string, string> => {
    const found = custom()
    return found ? { from: String(found.from), to: String(found.to) } : { range: range() }
  }
  const words = () => (custom() ? ("custom" as const) : range())
  const rangeLabel = () => {
    const found = custom()
    if (!found) return t(`operator.timeRange.${range()}`)
    const at = (time: number) =>
      DateTime.fromMillis(time).setLocale(language.intl()).toLocaleString(DateTime.DATETIME_SHORT)
    return t("operator.timeRange.customShown", { from: at(found.from), to: at(found.to) })
  }
  const ns = () => (params.ns && params.ns !== "*" ? params.ns : undefined)
  // The scope as the API takes it: a project, else a namespace, else everything.
  const scoped = createMemo((): { ns?: string; dir?: string } => {
    const dir = scope.directory()
    if (dir) return { dir }
    return ns() ? { ns: ns()! } : {}
  })
  const health = useServerHealth()

  const attention = useQuery(() => ({
    queryKey: api.key("telemetry-attention", scoped()),
    refetchInterval: LIVE,
    retry: 1,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.attention(scoped(), { throwOnError: true })
        .then((result) => result.data!),
  }))
  const tiles = useQuery(() => ({
    queryKey: api.key("telemetry-tiles", rangeParams(), scoped()),
    refetchInterval: SLOW,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.tiles({ ...rangeParams(), ...scoped() }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  // Telemetry off (§9.3): only what doesn't need history.
  const off = () => ready(attention)?.telemetry.enabled === false || ready(tiles)?.enabled === false
  const breakdown = useQuery(() => ({
    queryKey: api.key("telemetry-breakdown", rangeParams(), scoped()),
    refetchInterval: SLOW,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.breakdown(
          { by: "agent,tool", ...rangeParams(), limit: "8", ...scoped() },
          { throwOnError: true },
        )
        .then((result) => result.data!),
  }))
  const recent = useQuery(() => ({
    queryKey: api.key("telemetry-sessions", "dashboard", scoped()),
    refetchInterval: SLOW,
    enabled: !off(),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.sessions(
          { ...scoped(), range: "365d", sort: "lastActivity:desc", limit: "8" },
          { throwOnError: true },
        )
        .then((result) => result.data!),
  }))
  const plain = useQuery(() => ({
    queryKey: api.key("sessions", "recent", scoped()),
    refetchInterval: SLOW,
    enabled: off(),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ limit: "8", roots: "true", ...(scoped().dir ? { directory: scoped().dir } : {}) })
        .then((result) => asList(result.data)),
  }))
  const pending = useQuery(() => ({
    queryKey: api.key("permission"),
    refetchInterval: LIVE,
    enabled: off(),
    queryFn: () =>
      api
        .client()
        .operator.permission.pending()
        .then((result) => asList(result.data)),
  }))

  // Live (§4.5): the strip and Running now on approval, status and telemetry events, at most once every 2 s.
  const [hidden, setHidden] = createSignal(document.visibilityState === "hidden")
  const live = throttle(() => {
    void attention.refetch()
    if (off()) void pending.refetch()
  }, BURST)
  const stop = sdk().event.listen((event) => {
    const type = (event.details as { type?: string } | undefined)?.type
    if (type && LIVE_EVENTS.has(type) && !hidden()) live.call()
  })
  const all = [
    "telemetry-attention",
    "telemetry-tiles",
    "telemetry-metric",
    "telemetry-breakdown",
    "telemetry-sessions",
    "sessions",
    "permission",
  ]
  const refreshAll = () => {
    for (const key of all) void queryClient.invalidateQueries({ queryKey: api.key(key) })
    health.check()
  }
  // Hidden: intervals pause (TanStack Query); shown again: one refresh of everything.
  const onVisibility = () => {
    const now = document.visibilityState === "hidden"
    if (hidden() && !now) refreshAll()
    setHidden(now)
  }
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => {
    stop()
    live.cancel()
    document.removeEventListener("visibilitychange", onVisibility)
  })

  // "Updated 20 s ago": the oldest block's age.
  const [clock, setClock] = createSignal(Date.now())
  const timer = setInterval(() => setClock(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const updated = () => {
    const times = [attention, tiles, breakdown, off() ? plain : recent]
      .map((query) => query.dataUpdatedAt)
      .filter((time) => time > 0)
    return times.length ? Math.max(0, Math.round((clock() - Math.min(...times)) / 1000)) : undefined
  }

  // Approvals without telemetry: from the pending list, in scope (§9.3).
  const items = createMemo((): ReadonlyArray<OperatorDashboardItem> | undefined => {
    const found = ready(attention)
    if (!found) return undefined
    if (found.telemetry.enabled) return found.items
    const dir = scoped().dir
    const namespace = scoped().ns
    const waits = (ready(pending) ?? []).filter(
      (item: OperatorPendingPermission) =>
        (!dir || item.project?.key === dir || item.directory === dir) &&
        (!namespace || item.project?.namespace === namespace),
    )
    if (!waits.length) return found.items
    const oldest = waits.reduce((first, item) => (item.time < first.time ? item : first))
    const age = Date.now() - oldest.time
    return [
      {
        kind: "approvals",
        severity: age > CRITICAL_WAIT ? "critical" : "warning",
        count: waits.length,
        worst: { ageMs: age },
        alert: false,
        link: { page: "inbox", params: waits.length === 1 ? { ask: oldest.request.id } : {} },
      },
      ...found.items,
    ]
  })
  const backfill = () => {
    const found = ready(attention)?.telemetry.backfill
    return found && found.total ? found.done / found.total : found ? 0 : undefined
  }

  // A session row opens the session overlay (§8.1, §8.2), as rows did before.
  const sessionRows = createMemo(() => [
    ...(ready(attention)?.runningNow.rows ?? []).map((row) => ({ id: row.id, directory: row.directory ?? "" })),
    ...(ready(recent)?.rows ?? []).map((row) => ({ id: row.id, directory: row.directory ?? "" })),
    ...(ready(plain) ?? []).map((row) => ({ id: row.id, directory: row.directory })),
  ])
  const openOverlay = useSessionOverlay(sessionRows)
  const showRunning = () => {
    const heading = document.getElementById("dash-running-title")
    heading?.scrollIntoView({ block: "nearest" })
    heading?.focus()
  }

  return (
    <>
      <PageHeader
        title={t("operator.page.dashboard.title")}
        description={t("operator.page.dashboard.description")}
        actions={
          <span class="inline-flex flex-wrap items-center gap-2">
            <ServerChip health={health} />
            <NamespacePicker
              current={params.ns ?? "*"}
              onChange={(id) => {
                if (id !== "*" && scope.directory()) scope.setDirectory(undefined)
              }}
            />
            <ScopePicker all namespace={params.ns ?? "*"} />
          </span>
        }
      >
        <div class="flex flex-wrap items-center gap-3" data-slot="operator-dash-controls">
          <span class="inline-flex items-center gap-1">
            <SegmentedControlV2
              aria-label={t("operator.dash.range")}
              value={custom() ? null : range()}
              onChange={(value) => value && setRange(value as Range)}
              data-testid="dash-range"
            >
              <For each={RANGES}>
                {(item) => (
                  <SegmentedControlItemV2 value={item} aria-label={t(`operator.dash.rangeWords.${item}`)}>
                    {t(`operator.dash.rangeShort.${item}`)}
                  </SegmentedControlItemV2>
                )}
              </For>
            </SegmentedControlV2>
            <FieldHelp field={t("operator.dash.range")} text={t("operator.dash.help.range")} />
          </span>
          <Show when={custom()}>
            <span class="inline-flex items-center gap-2" data-testid="dash-custom-range">
              <span data-slot="operator-note">{rangeLabel()}</span>
              <ButtonV2 size="small" variant="outline" onClick={() => setRange(range())}>
                {t("operator.dash.resetZoom")}
              </ButtonV2>
            </span>
          </Show>
          <span class="inline-flex items-center gap-2" data-testid="dash-updated">
            <ButtonV2 size="small" variant="ghost" aria-label={t("operator.dash.refresh")} onClick={refreshAll}>
              <Icon name="reset" size="small" />
            </ButtonV2>
            <Show when={updated() !== undefined}>
              <span data-slot="operator-note">{t("operator.obs.updated", { seconds: updated()! })}</span>
            </Show>
          </span>
        </div>
      </PageHeader>

      <div data-component="operator-dash" data-testid="dash">
        <AttentionStrip
          items={items()}
          running={ready(attention)?.running}
          loading={attention.isPending}
          unreachable={health.state() === "notResponding" || (attention.isError && !attention.data)}
          onRetry={() => {
            health.check()
            void attention.refetch()
          }}
          building={backfill()}
          scope={scoped()}
          onShowRunning={showRunning}
        />
        <DashboardTiles
          data={ready(tiles)}
          loading={tiles.isPending}
          words={words()}
          extra={rangeParams()}
          scope={scoped()}
        />
        <ActivityChart
          query={{ ...rangeParams(), ...scoped() }}
          scope={scoped()}
          rangeLabel={rangeLabel()}
          known={!!ready(attention) || !!ready(tiles)}
          off={off()}
          onZoom={zoom}
        />
        <SpendChart
          query={{ ...rangeParams(), ...scoped() }}
          scope={scoped()}
          rangeLabel={rangeLabel()}
          known={!!ready(attention) || !!ready(tiles)}
          off={off()}
          onZoom={zoom}
          view={prefs.spend === "tokens" ? "tokens" : "cost"}
          by={(["model", "project", "agent"] as const).find((item) => item === prefs.by) ?? "model"}
          onView={(view) => setPrefs("spend", view)}
          onBy={(by) => setPrefs("by", by)}
          budget={ready(tiles)?.budget?.limit ?? null}
          days={!custom() && range() !== "24h"}
        />
        <RunningNow
          rows={ready(attention)?.runningNow.rows}
          total={ready(attention)?.runningNow.total ?? 0}
          loading={attention.isPending}
          off={off()}
          now={clock()}
          scope={scoped()}
          onOpen={(row) => openOverlay(row.id)}
        />
        <RecentSessions
          rows={ready(recent)?.rows}
          plain={ready(plain)}
          loading={off() ? plain.isPending : recent.isPending}
          off={off()}
          scope={scoped()}
          onOpen={openOverlay}
        />
        <AgentsPanel
          group={ready(breakdown)?.groups.agent}
          loading={breakdown.isPending}
          off={off()}
          scope={scoped()}
          extra={rangeParams()}
        />
        <ToolsPanel
          group={ready(breakdown)?.groups.tool}
          loading={breakdown.isPending}
          off={off()}
          scope={scoped()}
          extra={rangeParams()}
        />
      </div>
    </>
  )
}
