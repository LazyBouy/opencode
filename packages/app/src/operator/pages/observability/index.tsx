import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorTelemetrySessionRow } from "@opencode-ai/sdk/v2/client"
import { useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { ready, useOperatorClient } from "../../data"
import { formatCount, formatDateTime } from "../../format"
import { OPENCODE } from "../profile-model"
import { useOperatorScope } from "../../scope"
import { EmptyState } from "../../ui/empty-state"
import { FieldHelp } from "../../ui/field-help"
import { NamespacePicker, useNamespaceScope } from "../../ui/namespace-picker"
import { PageHeader } from "../../ui/page-header"
import { useRecordOverlay } from "../../ui/record-overlay"
import { LiveIndicator } from "../../ui/live-indicator"
import { OverlayFrame } from "../../ui/overlay-frame"
import { useOverlayParams } from "../../ui/overlay-nav"
import { ScopePicker } from "../../ui/scope-picker"
import { TimeRange } from "../../ui/time-range"
import { chips, filterOf, groupsOf, isTab, type Params, rangeOf, rangeQuery, reach, type Tab } from "./model"
import { EventsTab } from "./events"
import { LogsTab } from "./logs"
import { MetricsTab } from "./metrics"
import { SessionDetail, SpanPanel } from "./session-detail"
import { SessionsTab } from "./sessions"
import "./observability.css"

// Observability (observability_spec.md §8): "what exactly happened, when, and why?" across sessions. One time range
// and one scope for the whole page; the URL is the state (§8.4), so links can be shared, Back works and the Dashboard
// links in. Tabs: Sessions, Events, Metrics and Logs (Alerts comes with its phase). A session opens in its detail
// over the tab.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
const BUILT: ReadonlyArray<Tab> = ["sessions", "events", "metrics", "logs"]
const REFRESH = 30_000

export default function ObservabilityPage() {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams<Record<string, string>>()
  const scope = useOperatorScope()
  const namespaces = useNamespaceScope()
  const [prefs, setPrefs] = persisted(
    Persist.global("operator.observability"),
    createStore({ range: "24h", facets: true, closed: [] as string[] }),
  )
  const tab = (): Tab => (isTab(params.tab) && BUILT.includes(params.tab) ? params.tab : "sessions")
  const range = () => rangeOf(params as Params, prefs.range)
  const relative = () => range().from === undefined
  const ns = () => (params.ns && params.ns !== "*" ? params.ns : undefined)
  // What every tab asks the server: the range, the scope and the filters in the URL.
  const query = createMemo(() => {
    const filter = filterOf(params as Params)
    const dir = scope.directory()
    return {
      ...filter,
      ...rangeQuery(range()),
      ...(dir ? { dir } : {}),
      ...(ns() && !dir ? { ns: ns()! } : {}),
    }
  })
  const setRange = (value: { range?: string; from?: number; to?: number }) => {
    if (value.range) setPrefs("range", value.range)
    setParams({
      range: value.range,
      from: value.from !== undefined ? String(value.from) : undefined,
      to: value.to !== undefined ? String(value.to) : undefined,
    })
  }

  // Refresh: every 30 s for relative ranges while the tab is visible (TanStack pauses in the background).
  const refresh = () => (relative() ? REFRESH : (false as const))
  const [updated, setUpdated] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())
  const timer = setInterval(() => setClock(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const age = () => (updated() ? Math.max(0, Math.round((clock() - updated()) / 1000)) : undefined)

  // Building history: a banner while it runs (§5.11).
  const backfill = useQuery(() => ({
    queryKey: api.key("telemetry-backfill"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.backfillStatus()
        .then((result) => result.data!),
    refetchInterval: (state) => (state.state.data?.state === "running" ? 2000 : 60_000),
  }))
  const storage = useQuery(() => ({
    queryKey: api.key("telemetry-storage"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.storage()
        .then((result) => result.data!),
    staleTime: 60_000,
  }))
  const eventsDays = () => ready(storage)?.eventsDays ?? 30
  const beyond = () => reach(range(), clock(), eventsDays()).beyond

  // The session detail, over the tab (§10); ‹ › move through the sessions listed.
  const [listed, setListed] = createSignal<ReadonlyArray<string>>([])
  useRecordOverlay(
    () => !!params.session,
    () => <SessionDetail records={listed} />,
    ["session", "turn", "span"],
  )
  const open = (row: OperatorTelemetrySessionRow) => setParams({ session: row.id, turn: undefined, span: undefined })
  const openSession = (id: string) => setParams({ session: id, turn: undefined, span: undefined, ev: undefined })
  // A span from Events or a log line opens in its own overlay, with Open session (§11.1).
  useRecordOverlay(
    () => !!params.ev,
    () => (
      <SpanOverlay
        onOpenAt={(span) =>
          setParams({
            ev: undefined,
            session: span.session_id ?? undefined,
            turn: span.turn_id ?? undefined,
            span: span.id,
          })
        }
      />
    ),
    ["ev"],
  )
  // Live (§8.6): Events and Logs, with a relative range ending now.
  const live = () => params.live === "1" && relative()
  // The Logs tab's own filters: the lowest level, service, text and session.
  const logsQuery = createMemo(() => ({
    ...rangeQuery(range()),
    ...(params.level ? { level: params.level } : { level: "warn" }),
    ...(params.service ? { service: params.service } : {}),
    ...(params.q ? { q: params.q } : {}),
    ...(params.inSession ? { session: params.inSession } : {}),
  }))
  const logsNote = () => {
    const found = ready(storage)
    if (!found) return undefined
    return t("operator.obs.logsNote", {
      levels: t(`operator.obs.levelsKept.${found.logLevel}` as Key),
      since: found.oldestLog ? formatDateTime(found.oldestLog, language.intl()) : t("operator.obs.logsNoneYet"),
      path: found.logPath,
    })
  }

  // Metrics (§12): Group by and Compare per section in the URL; collapsed sections per viewer.
  const groups = () => groupsOf(params.by)
  const compared = () => (params.compare ?? "").split(",").filter(Boolean)
  const setGroup = (section: string, key: string | undefined) => {
    const next = { ...groups(), [section]: key }
    const value = Object.entries(next)
      .filter(([, item]) => item)
      .map(([name, item]) => `${name}:${item}`)
      .join(",")
    setParams({ by: value || undefined })
  }
  const setCompare = (section: string, on: boolean) => {
    const next = on ? [...new Set([...compared(), section])] : compared().filter((item) => item !== section)
    setParams({ compare: next.join(",") || undefined })
  }
  const toggleSection = (section: string) =>
    setPrefs("closed", (closed) =>
      closed.includes(section) ? closed.filter((item) => item !== section) : [...closed, section],
    )
  // Context used is a share of each model's context: the limits from the providers of the project in scope (or the
  // namespace's default project).
  const limitsDir = () =>
    scope.directory() ??
    namespaces.namespaces().find((item) => item.namespace.id === (ns() ?? OPENCODE))?.defaultProject ??
    namespaces.namespaces()[0]?.defaultProject
  const providers = useQuery(() => ({
    queryKey: api.key("providers", limitsDir()),
    enabled: tab() === "metrics",
    staleTime: 5 * 60_000,
    queryFn: () =>
      api
        .client()
        .config.providers(limitsDir() ? { directory: limitsDir() } : {})
        .then((result) => result.data!),
  }))
  const limits = createMemo(() =>
    Object.fromEntries(
      (ready(providers)?.providers ?? []).flatMap((provider) =>
        Object.values(provider.models)
          .filter((model) => model.limit?.context)
          .map((model) => [`${provider.id}/${model.id}`, model.limit.context]),
      ),
    ),
  )
  // A point opens Events filtered to its step and series; a project filter is the page's scope.
  const toEvents = (filter: Record<string, string>, from: number, to: number) => {
    const { dir, session, ...rest } = filter
    if (dir) scope.setDirectory(dir)
    setParams({
      tab: "events",
      ...rest,
      ...(session ? { inSession: session } : {}),
      from: String(from),
      to: String(to),
      range: undefined,
      sort: undefined,
      live: undefined,
      section: undefined,
    })
  }
  const [zoomedFrom, setZoomedFrom] = createSignal<{ range?: string; from?: number; to?: number }>()
  const zoom = (from: number, to: number) => {
    if (!zoomedFrom()) setZoomedFrom(range())
    setRange({ from, to })
  }
  const rangeLabel = () =>
    range().range
      ? t(`operator.timeRange.${range().range}` as Key)
      : t("operator.timeRange.customShown", {
          from: formatDateTime(range().from, language.intl()),
          to: formatDateTime(range().to, language.intl()),
        })

  const setFilter = (key: string, value: string | undefined) => setParams({ [key]: value || undefined })
  const [search, setSearch] = createSignal(params.q ?? "")
  createEffect(
    on(
      () => params.q,
      (value) => setSearch(value ?? ""),
    ),
  )
  let typing: ReturnType<typeof setTimeout> | undefined
  const onSearch = (value: string) => {
    setSearch(value)
    clearTimeout(typing)
    typing = setTimeout(() => setFilter("q", value.trim()), 300)
  }
  const active = () => chips(params as Params)

  // What an empty tab says, and what to do next (§8.7).
  const emptyState = (): { description: string; action?: JSX.Element } => {
    const progress = ready(backfill)
    if (progress?.state === "running")
      return {
        description: t("operator.obs.empty.building", {
          percent: progress.total ? Math.round((progress.done / progress.total) * 100) : 0,
        }),
      }
    if (active().length || params.q || params.inSession || params.level || params.service)
      return {
        description: t(`operator.obs.empty.noMatch.${tab()}` as Key, {
          range: t(`operator.timeRange.${range().range ?? "custom"}` as Key),
        }),
        action: (
          <span class="inline-flex flex-wrap items-center gap-2">
            <ButtonV2 size="small" variant="outline" onClick={() => clearFilters()}>
              {t("operator.obs.clearFilters")}
            </ButtonV2>
            <ButtonV2 size="small" variant="outline" onClick={() => setRange({ range: "7d" })}>
              {t("operator.timeRange.7d")}
            </ButtonV2>
          </span>
        ),
      }
    return { description: t("operator.obs.empty.nothing") }
  }
  const clearFilters = () =>
    setParams(
      Object.fromEntries([
        ...active().map((chip) => [chip.key, undefined]),
        ["q", undefined],
        ["inSession", undefined],
        ["level", undefined],
        ["service", undefined],
      ]),
    )

  return (
    <>
      <PageHeader
        title={t("operator.page.observability.title")}
        description={t("operator.page.observability.description")}
        actions={
          <span class="inline-flex items-center gap-2" data-testid="obs-updated">
            <ButtonV2
              size="small"
              variant="ghost"
              aria-label={t("operator.obs.refresh")}
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: api.key(
                    tab() === "metrics"
                      ? "telemetry-metric"
                      : tab() === "sessions"
                        ? "telemetry-sessions"
                        : `telemetry-${tab()}`,
                  ),
                })
              }
            >
              <Icon name="reset" size="small" />
            </ButtonV2>
            <Show when={age() !== undefined}>
              <span data-slot="operator-note">{t("operator.obs.updated", { seconds: age()! })}</span>
            </Show>
          </span>
        }
      >
        <div class="flex flex-wrap items-center gap-3">
          <NamespacePicker
            current={params.ns ?? "*"}
            onChange={(id) => {
              if (id !== "*" && scope.directory()) scope.setDirectory(undefined)
            }}
          />
          <ScopePicker all namespace={params.ns ?? "*"} />
          <TimeRange
            value={range()}
            onChange={(value) => {
              setZoomedFrom(undefined)
              setRange(value)
            }}
            {...(zoomedFrom() ? { zoomedFrom: zoomedFrom()! } : {})}
            onResetZoom={() => {
              const before = zoomedFrom()
              setZoomedFrom(undefined)
              if (before) setRange(before)
            }}
          />
        </div>
      </PageHeader>
      <Show when={ready(backfill)?.state === "running"}>
        <div data-slot="operator-obs-banner" role="status" data-testid="obs-backfill">
          {t("operator.obs.building", {
            done: formatCount(ready(backfill)!.done, language.intl()),
            total: formatCount(ready(backfill)!.total, language.intl()),
          })}
        </div>
      </Show>
      <SegmentedControlV2
        class="operator-segmented-fit"
        value={tab()}
        onChange={(value) => value && setParams({ tab: value === "sessions" ? undefined : value })}
        aria-label={t("operator.page.observability.title")}
      >
        <For each={BUILT}>
          {(item) => (
            <SegmentedControlItemV2 value={item}>{t(`operator.obs.tab.${item}` as Key)}</SegmentedControlItemV2>
          )}
        </For>
      </SegmentedControlV2>
      <div data-slot="operator-obs-filterbar">
        <For each={active()}>
          {(chip) => (
            <Tag data-testid="obs-chip">
              <span>
                {t(`operator.obs.filter.${chip.key}` as Key)}: {chip.value}
              </span>
              <button
                type="button"
                data-slot="operator-obs-chip-remove"
                aria-label={t("operator.obs.removeFilter", { name: t(`operator.obs.filter.${chip.key}` as Key) })}
                onClick={() => setFilter(chip.key, undefined)}
              >
                ×
              </button>
            </Tag>
          )}
        </For>
        <TextInputV2
          appearance="base"
          type="search"
          aria-label={t("operator.obs.search")}
          placeholder={t("operator.obs.searchPlaceholder")}
          value={search()}
          onInput={(event) => onSearch(event.currentTarget.value)}
        />
        <Show when={params.inSession}>
          <Tag data-testid="obs-chip">
            <span>
              {t("operator.obs.filter.session")}: {params.inSession}
            </span>
            <button
              type="button"
              data-slot="operator-obs-chip-remove"
              aria-label={t("operator.obs.removeFilter", { name: t("operator.obs.filter.session") })}
              onClick={() => setFilter("inSession", undefined)}
            >
              ×
            </button>
          </Tag>
        </Show>
        <Show when={tab() === "events" || tab() === "logs"}>
          <span class="inline-flex items-center gap-2" data-testid="obs-live">
            <CheckboxV2
              label={t("operator.obs.live")}
              checked={live()}
              disabled={!relative()}
              onChange={(checked: boolean) => setFilter("live", checked ? "1" : undefined)}
            />
            <FieldHelp
              field={t("operator.obs.live")}
              text={t(relative() ? "operator.obs.help.live" : "operator.obs.help.liveCustom")}
            />
            <Show when={live()}>
              <LiveIndicator live={true} />
            </Show>
          </span>
        </Show>
        <Show when={tab() === "sessions"}>
          <span class="inline-flex items-center">
            <CheckboxV2
              label={t("operator.obs.includeSubagents")}
              checked={params.roots === "0"}
              onChange={(checked: boolean) => setFilter("roots", checked ? "0" : undefined)}
            />
            <FieldHelp field={t("operator.obs.includeSubagents")} text={t("operator.obs.help.includeSubagents")} />
          </span>
        </Show>
      </div>
      <Show when={beyond()}>
        <p data-slot="operator-note" data-testid="obs-beyond">
          {t("operator.obs.beyond", { days: eventsDays() })}
        </p>
      </Show>
      <div data-component="operator-obs-layout" data-facets={prefs.facets ? "" : undefined}>
        <Facets
          scope={tab() === "logs" ? "logs" : tab() === "events" || tab() === "metrics" ? "events" : "sessions"}
          fields={FACET_FIELDS[tab()]}
          query={tab() === "logs" ? logsQuery() : query()}
          open={prefs.facets}
          onToggle={() => setPrefs("facets", !prefs.facets)}
          onPick={(key, value) => setFilter(key, value)}
          current={params as Params}
        />
        <div data-slot="operator-obs-content">
          <Show when={tab() === "sessions"}>
            <SessionsTab
              query={query()}
              sort={params.sort}
              onSort={(sort) => setParams({ sort })}
              refresh={refresh()}
              onOpen={open}
              onUpdated={(time) => setUpdated(time)}
              onRows={setListed}
              empty={() => {
                const state = emptyState()
                return (
                  <EmptyState
                    icon="eye"
                    title={t("operator.obs.tab.sessions")}
                    description={state.description}
                    action={state.action}
                  />
                )
              }}
            />
          </Show>
          <Show when={tab() === "events"}>
            <EventsTab
              query={query()}
              sort={params.sort}
              onSort={(sort) => setParams({ sort })}
              kind={params.kind}
              onKind={(kind) => setFilter("kind", kind)}
              live={live()}
              onOpen={(span) => setParams({ ev: span.id })}
              onOpenSession={openSession}
              onUpdated={(time) => setUpdated(time)}
              empty={() => {
                const state = emptyState()
                return (
                  <EmptyState
                    icon="eye"
                    title={t("operator.obs.tab.events")}
                    description={state.description}
                    action={state.action}
                  />
                )
              }}
            />
          </Show>
          <Show when={tab() === "metrics"}>
            <MetricsTab
              query={query()}
              refresh={refresh()}
              rangeLabel={rangeLabel()}
              groups={groups()}
              onGroup={setGroup}
              compare={compared()}
              onCompare={setCompare}
              closed={prefs.closed}
              onToggle={toggleSection}
              {...(params.section ? { focus: params.section } : {})}
              eventsDays={eventsDays()}
              limits={limits()}
              onEvents={toEvents}
              onZoom={zoom}
            />
          </Show>
          <Show when={tab() === "logs"}>
            <LogsTab
              query={logsQuery()}
              level={params.level}
              onLevel={(level) => setFilter("level", level)}
              live={live()}
              onOpenSession={openSession}
              onUpdated={(time) => setUpdated(time)}
              note={logsNote()}
              empty={() => {
                const state = emptyState()
                return (
                  <EmptyState
                    icon="eye"
                    title={t("operator.obs.tab.logs")}
                    description={state.description}
                    action={state.action}
                  />
                )
              }}
            />
          </Show>
        </div>
      </div>
    </>
  )
}

const FACET_FIELDS: Record<string, ReadonlyArray<string>> = {
  sessions: ["sessionStatus", "agent", "agentType", "model", "dir"],
  events: ["kind", "status", "agent", "model", "tool", "errorType", "dir"],
  metrics: ["agent", "model", "provider", "tool", "status", "dir"],
  logs: ["level", "service"],
}

/** The facet panel (§8.1): each field's top values with counts under the filter; a value picks it. */
function Facets(props: {
  scope: "sessions" | "events" | "logs"
  fields: ReadonlyArray<string> | undefined
  query: Record<string, string>
  open: boolean
  onToggle: () => void
  onPick: (key: string, value: string | undefined) => void
  current: Params
}) {
  const language = useLanguage()
  const t = language.t
  return (
    <aside data-slot="operator-obs-facets" aria-label={t("operator.obs.facets")} data-testid="obs-facets">
      <ButtonV2 size="small" variant="ghost" aria-expanded={props.open} onClick={() => props.onToggle()}>
        <Icon name={props.open ? "chevron-left" : "chevron-right"} size="small" />
        {t("operator.obs.facets")}
      </ButtonV2>
      <Show when={props.open}>
        <For each={props.fields ?? []}>
          {(field) => (
            <Facet
              scope={props.scope}
              field={field}
              query={props.query}
              current={props.current}
              onPick={props.onPick}
            />
          )}
        </For>
      </Show>
    </aside>
  )
}

function Facet(props: {
  scope: string
  field: string
  query: Record<string, string>
  current: Params
  onPick: (key: string, value: string | undefined) => void
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const [more, setMore] = createSignal(false)
  const values = useQuery(() => ({
    queryKey: api.key("telemetry-facet", props.scope, props.field, props.query),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.facets({
          ...props.query,
          scope: props.scope as "sessions" | "events" | "logs",
          field: props.field,
        })
        .then((result) => result.data ?? []),
  }))
  const list = () => ready(values) ?? []
  const chosen = () => {
    const value = props.current[props.field]
    return (Array.isArray(value) ? value[0] : value)?.split(",") ?? []
  }
  const label = (value: string) =>
    props.field === "sessionStatus"
      ? t(`operator.obs.status.session.${value}` as Key)
      : props.field === "status"
        ? t(`operator.obs.status.span.${value}` as Key)
        : props.field === "kind"
          ? t(`operator.obs.kind.${value}` as Key)
          : props.field === "level"
            ? t(`operator.obs.level.${value.toLowerCase()}` as Key)
            : props.field === "agentType"
              ? t(`operator.obs.agentType.${value}` as Key)
              : props.field === "dir"
                ? (value.split("/").filter(Boolean).at(-1) ?? value)
                : value
  return (
    <section data-slot="operator-obs-facet" data-field={props.field}>
      <h4>{t(`operator.obs.filter.${props.field}` as Key)}</h4>
      <Show when={list().length} fallback={<p data-slot="operator-note">{t("operator.obs.facetEmpty")}</p>}>
        <ul>
          <For each={more() ? list() : list().slice(0, 10)}>
            {(item) => (
              <li>
                <button
                  type="button"
                  data-selected={chosen().includes(item.value) ? "" : undefined}
                  title={item.value}
                  onClick={() => {
                    const has = chosen().includes(item.value)
                    const next = has ? chosen().filter((value) => value !== item.value) : [...chosen(), item.value]
                    props.onPick(props.field, next.join(",") || undefined)
                  }}
                >
                  <span>{label(item.value)}</span>
                  <span data-slot="operator-note">{formatCount(item.count, language.intl())}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={list().length > 10 && !more()}>
          <ButtonV2 size="small" variant="ghost" onClick={() => setMore(true)}>
            {t("operator.obs.showMore")}
          </ButtonV2>
        </Show>
      </Show>
    </section>
  )
}

/** One span, from Events (`ev`): its panel, with Open session at that span. */
function SpanOverlay(props: { onOpenAt: (span: import("@opencode-ai/sdk/v2/client").OperatorTelemetrySpan) => void }) {
  const api = useOperatorClient()
  const [params, setParams] = useOverlayParams<{ ev?: string; session?: string }>()
  const span = useQuery(() => ({
    queryKey: api.key("telemetry-span", params.ev),
    enabled: !!params.ev,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.span({ id: params.ev! }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  return (
    <OverlayFrame label={ready(span)?.span.name ?? params.ev} editing={false}>
      <div data-component="operator-obs-detail">
        <SpanPanel
          detail={ready(span)}
          loading={span.isPending}
          onClose={() => setParams({ ev: undefined })}
          onOpenSession={(id) => setParams({ ev: undefined, session: id })}
          onOpenAt={props.onOpenAt}
        />
      </div>
    </OverlayFrame>
  )
}
