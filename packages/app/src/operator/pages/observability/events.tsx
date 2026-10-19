import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorTelemetrySpan, OperatorTelemetrySpanPage } from "@opencode-ai/sdk/v2/client"
import { useInfiniteQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../../data"
import { formatDateTime, formatAgo, shortPath } from "../../format"
import { type Column, DataTable } from "../../ui/data-table"
import type { Sort } from "../../ui/table"
import { useLiveTail } from "./live"
import { attrsOf } from "./model"
import { Cost, Status, Tokens, useDuration } from "./parts"

// The Events tab (observability_spec.md §11): every span as one stream, newest first, filtered and sorted by the
// server, with quick kind chips. A row opens its span panel; Live (§8.6) adds rows as they are written and updates
// the ones shown.

type Span = OperatorTelemetrySpan
type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
const PAGE = 100

export const KIND_CHIPS: ReadonlyArray<{ id: string; kind?: string }> = [
  { id: "all" },
  { id: "turn", kind: "turn" },
  { id: "model_call", kind: "model_call" },
  { id: "tool_call", kind: "tool_call" },
  { id: "permission_wait", kind: "permission_wait" },
  { id: "subagent", kind: "subagent" },
  { id: "retry", kind: "retry" },
  { id: "compaction", kind: "compaction" },
  { id: "helper_run", kind: "helper_run" },
  { id: "queue_item", kind: "queue_item" },
  { id: "alert", kind: "alert" },
]

export function EventsTab(props: {
  query: Record<string, string>
  sort: string | undefined
  onSort: (sort: string | undefined) => void
  kind: string | undefined
  onKind: (kind: string | undefined) => void
  live: boolean
  onOpen: (span: Span) => void
  onOpenSession: (sessionID: string) => void
  onUpdated: (time: number) => void
  empty: () => JSX.Element
  /** The columns shown (for export and saved views), and a saved view's to show. */
  onColumns?: (ids: ReadonlyArray<string>) => void
  applyColumns?: ReadonlyArray<string>
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const duration = useDuration()
  const events = useInfiniteQuery(() => ({
    queryKey: api.key("telemetry-events", props.query, props.sort),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api
        .client()
        .operator.telemetry.events(
          {
            ...props.query,
            ...(props.sort ? { sort: props.sort } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
            limit: String(PAGE),
          },
          { throwOnError: true },
        )
        .then((result) => result.data!),
    getNextPageParam: (last: OperatorTelemetrySpanPage) => last.nextCursor ?? undefined,
  }))
  createEffect(() => {
    if (events.dataUpdatedAt) props.onUpdated(events.dataUpdatedAt)
  })
  const base = createMemo(() => events.data?.pages.flatMap((page) => page.rows) ?? [])
  const [titles, setTitles] = createSignal<Record<string, string>>({})
  createEffect(() => {
    const found = Object.assign({}, ...(events.data?.pages.map((page) => page.titles ?? {}) ?? []))
    setTitles((before) => ({ ...before, ...found }))
  })
  let scroller: HTMLDivElement | undefined
  const [top, setTop] = createSignal(true)
  const live = useLiveTail<Span>({
    enabled: () => props.live,
    seq: () => events.data?.pages[0]?.seq,
    key: () => JSON.stringify([props.query, props.sort]),
    shown: () => base().map((row) => row.id),
    atTop: top,
    fetch: (after) =>
      api
        .client()
        .operator.telemetry.events({ ...props.query, after: String(after), limit: "500" }, { throwOnError: true })
        .then((result) => {
          setTitles((before) => ({ ...before, ...(result.data!.titles ?? {}) }))
          return { rows: result.data!.rows, seq: result.data!.seq }
        }),
  })
  const rows = createMemo(() => (props.live ? live.rows(base()) : base()))
  const sort = (): Sort | undefined => {
    const [column, way] = (props.sort ?? "start:desc").split(":")
    return column ? { column, direction: way === "asc" ? "asc" : "desc" } : undefined
  }
  const kindLabel = (span: Span) =>
    span.kind === "model_call" && attrsOf(span).side
      ? t("operator.obs.kind.side")
      : t(`operator.obs.kind.${span.kind}` as Key)

  const columns: Column<Span>[] = [
    {
      id: "start",
      header: t("operator.obs.col.time"),
      help: t("operator.obs.help.time"),
      value: (span) => span.start_ms,
      cell: (span) => (
        <span title={formatDateTime(span.start_ms ?? undefined, language.intl())}>
          {formatAgo(span.start_ms ?? undefined, language.intl())}
        </span>
      ),
    },
    {
      id: "kind",
      header: t("operator.obs.col.kind"),
      help: t("operator.obs.help.kind"),
      value: (span) => span.kind,
      cell: (span) => kindLabel(span),
    },
    {
      id: "name",
      header: t("operator.obs.col.name"),
      help: t("operator.obs.help.name"),
      value: (span) => span.name ?? "",
      cell: (span) => <span data-slot="operator-obs-name">{span.name}</span>,
    },
    {
      id: "status",
      header: t("operator.obs.col.status"),
      help: t("operator.obs.help.spanStatus"),
      value: (span) => span.status,
      cell: (span) => <Status status={span.status} />,
    },
    {
      id: "active",
      align: "end",
      header: t("operator.obs.col.active"),
      help: t("operator.obs.help.activeSpan"),
      value: (span) => span.active_ms,
      cell: (span) => (span.active_ms !== null ? duration(span.active_ms) : ""),
    },
    {
      id: "wait",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.wait"),
      help: t("operator.obs.help.wait"),
      value: (span) => span.wait_ms,
      cell: (span) => (span.wait_ms ? duration(span.wait_ms) : ""),
    },
    {
      id: "session",
      header: t("operator.obs.col.session"),
      help: t("operator.obs.help.eventSession"),
      cell: (span) => (
        <Show when={span.session_id}>
          {(id) => (
            <button
              type="button"
              data-slot="operator-link"
              onClick={(event) => {
                event.stopPropagation()
                props.onOpenSession(id())
              }}
            >
              {titles()[id()] ?? id()}
            </button>
          )}
        </Show>
      ),
    },
    {
      id: "agent",
      header: t("operator.obs.col.agent"),
      help: t("operator.obs.help.agent"),
      value: (span) => span.agent ?? "",
      cell: (span) => span.agent ?? "",
    },
    {
      id: "project",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.project"),
      help: t("operator.obs.help.project"),
      cell: (span) => (span.project_key ? <span title={span.project_key}>{shortPath(span.project_key)}</span> : ""),
    },
    {
      id: "model",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.model"),
      help: t("operator.obs.help.spanModel"),
      value: (span) => span.model ?? "",
      cell: (span) => span.model ?? "",
    },
    {
      id: "tool",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.tool"),
      help: t("operator.obs.help.tool"),
      value: (span) => span.tool ?? "",
      cell: (span) => span.tool ?? "",
    },
    {
      id: "http",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.http"),
      help: t("operator.obs.help.http"),
      value: (span) => span.http_status,
      cell: (span) => span.http_status ?? "",
    },
    {
      id: "attempt",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.attempt"),
      help: t("operator.obs.help.attempt"),
      cell: (span) => (span.attempts ? `${span.attempt} / ${span.attempts}` : ""),
    },
    {
      id: "ttft",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.ttft"),
      help: t("operator.obs.help.ttft"),
      value: (span) => span.ttft_ms,
      cell: (span) => (span.ttft_ms !== null ? duration(span.ttft_ms) : span.kind === "model_call" ? "—" : ""),
    },
    {
      id: "tokens",
      align: "end",
      header: t("operator.obs.col.tokens"),
      help: t("operator.obs.help.spanTokens"),
      value: (span) => span.tokens_input,
      cell: (span) => <Tokens row={span} />,
    },
    {
      id: "cost",
      align: "end",
      header: t("operator.obs.col.cost"),
      help: t("operator.obs.help.spanCost"),
      value: (span) => span.cost,
      cell: (span) => <Cost value={span.cost} />,
    },
    {
      id: "error",
      header: t("operator.obs.col.error"),
      help: t("operator.obs.help.error"),
      cell: (span) => (
        <Show when={span.error_type}>
          <span data-slot="operator-obs-error" title={span.error_message ?? ""}>
            <strong>{span.error_type}</strong>
            <Show when={span.error_message}> {span.error_message!.split("\n")[0]}</Show>
          </span>
        </Show>
      ),
    },
    {
      id: "decision",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.decision"),
      help: t("operator.obs.help.decision"),
      cell: (span) => span.decision ?? "",
    },
  ]

  return (
    <div data-component="operator-obs-events">
      <div data-slot="operator-obs-kinds" role="group" aria-label={t("operator.obs.col.kind")}>
        <For each={KIND_CHIPS}>
          {(chip) => (
            <ButtonV2
              size="small"
              variant={(props.kind ?? undefined) === chip.kind ? "contrast" : "ghost"}
              aria-pressed={(props.kind ?? undefined) === chip.kind}
              data-testid="obs-kind-chip"
              onClick={() => props.onKind(chip.kind)}
            >
              {t(`operator.obs.chip.${chip.id}` as Key)}
            </ButtonV2>
          )}
        </For>
      </div>
      <Show when={props.live && live.waiting()}>
        <button
          type="button"
          data-slot="operator-obs-new"
          data-testid="obs-new-events"
          onClick={() => {
            scroller?.scrollTo({ top: 0 })
            setTop(true)
            live.show()
          }}
        >
          {t("operator.obs.newEvents", { n: live.waiting() })}
        </button>
      </Show>
      <div role="status" aria-live="polite" data-slot="operator-sr-only">
        {props.live && live.waiting() ? t("operator.obs.newEvents", { n: live.waiting() }) : ""}
      </div>
      <Show when={events.isError}>
        <div data-slot="operator-error" role="alert">
          {String((events.error as Error | undefined)?.message ?? events.error)}
          <ButtonV2 size="small" variant="outline" onClick={() => void events.refetch()}>
            {t("operator.obs.retry")}
          </ButtonV2>
        </div>
      </Show>
      <div
        ref={scroller}
        data-slot="operator-obs-scroll"
        onScroll={(event) => setTop(event.currentTarget.scrollTop < 8)}
      >
        <DataTable<Span>
          label={t("operator.obs.tab.events")}
          rows={rows()}
          columns={columns}
          columnsKey="observability-events"
          {...(props.onColumns ? { onColumns: props.onColumns } : {})}
          {...(props.applyColumns ? { applyColumns: props.applyColumns } : {})}
          loading={events.isPending}
          empty={props.empty()}
          server={{
            sort: sort(),
            onSort: (next) => props.onSort(next ? `${next.column}:${next.direction}` : undefined),
          }}
          rowAttrs={(span) => ({
            "data-testid": "obs-event-row",
            "data-span": span.id,
            "data-status": span.status ?? undefined,
          })}
          onRowClick={(span) => props.onOpen(span)}
        />
      </div>
      <div data-slot="operator-obs-paging">
        <Show when={events.hasNextPage && !props.live}>
          <ButtonV2
            size="small"
            variant="outline"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            {t("operator.obs.loadMore")}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}
