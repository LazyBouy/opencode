import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorTelemetrySessionPage, OperatorTelemetrySessionRow } from "@opencode-ai/sdk/v2/client"
import { useInfiniteQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../../data"
import { formatAgo, formatDateTime, shortPath } from "../../format"
import { useOperatorProjects } from "../../project"
import { useOpenSessionView } from "../../session-views/view"
import { type Column, DataTable } from "../../ui/data-table"
import { useNamespaceScope } from "../../ui/namespace-picker"
import type { Sort } from "../../ui/table"
import { attrsOf } from "./model"
import { CacheHit, Cost, Count, Status, Tokens, useDuration } from "./parts"

// The Sessions tab (observability_spec.md §9): sessions with activity in the range, sorted and paged by the server
// (50 at a time, then Load more), top sessions unless "Include subagent sessions" (`roots=0`), whose child sessions
// sit under their parent when sorted by start. A row opens the session detail; hovering shows Open in Chats and
// Transcript.

const PAGE = 50
type Row = OperatorTelemetrySessionRow

export function SessionsTab(props: {
  query: Record<string, string>
  sort: string | undefined
  onSort: (sort: string | undefined) => void
  refresh: number | false
  onOpen: (row: Row) => void
  onUpdated: (time: number) => void
  /** The sessions shown, for the detail's ‹ ›. */
  onRows: (ids: ReadonlyArray<string>) => void
  empty: () => JSX.Element
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const projects = useOperatorProjects()
  const namespaces = useNamespaceScope()
  const duration = useDuration()
  const openView = useOpenSessionView()

  const sessions = useInfiniteQuery(() => ({
    queryKey: api.key("telemetry-sessions", props.query, props.sort),
    initialPageParam: undefined as string | undefined,
    refetchInterval: props.refresh,
    queryFn: ({ pageParam }) =>
      api
        .client()
        .operator.telemetry.sessions(
          {
            ...props.query,
            ...(props.sort ? { sort: props.sort } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
            limit: String(PAGE),
          },
          { throwOnError: true },
        )
        .then((result) => result.data!),
    getNextPageParam: (last: OperatorTelemetrySessionPage) => last.nextCursor,
  }))
  createEffect(() => {
    if (sessions.dataUpdatedAt) props.onUpdated(sessions.dataUpdatedAt)
  })
  const total = () => sessions.data?.pages[0]?.total ?? 0
  // With subagents, sorted by start: each child under its parent (when both are on the page).
  const rows = createMemo(() => {
    const list = sessions.data?.pages.flatMap((page) => page.rows) ?? []
    if (props.query.roots !== "0" || !(props.sort ?? "").startsWith("started")) return list
    const byParent = new Map<string, Row[]>()
    const ids = new Set(list.map((row) => row.id))
    for (const row of list)
      if (row.parent_id && ids.has(row.parent_id))
        byParent.set(row.parent_id, [...(byParent.get(row.parent_id) ?? []), row])
    const out: Row[] = []
    const place = (row: Row) => {
      out.push(row)
      for (const child of byParent.get(row.id) ?? []) place(child)
    }
    for (const row of list) if (!row.parent_id || !ids.has(row.parent_id)) place(row)
    return out
  })
  createEffect(() => props.onRows(rows().map((row) => row.id)))
  const depth = (row: Row) => {
    let level = 0
    let parent = row.parent_id
    const known = new Map(rows().map((item) => [item.id, item]))
    while (parent && known.has(parent) && level < 5) {
      level += 1
      parent = known.get(parent)!.parent_id
    }
    return level
  }
  const projectOf = (key: string | null) => projects().find((item) => item.directory === key)
  const sort = (): Sort | undefined => {
    const [column, way] = (props.sort ?? "lastActivity:desc").split(":")
    return column ? { column, direction: way === "asc" ? "asc" : "desc" } : undefined
  }

  const columns: Column<Row>[] = [
    {
      id: "status",
      header: t("operator.obs.col.status"),
      help: t("operator.obs.help.sessionStatus"),
      value: (row) => row.status,
      cell: (row) => <Status status={row.status} scope="session" />,
    },
    {
      id: "title",
      header: t("operator.obs.col.session"),
      help: t("operator.obs.help.session"),
      value: (row) => row.title ?? "",
      cell: (row) => (
        <span data-slot="operator-obs-session" style={{ "padding-inline-start": `${depth(row) * 16}px` }}>
          <Show when={row.kept}>
            <span title={t("operator.obs.kept")}>
              <Icon name="archive" size="small" />
            </span>
          </Show>
          <span>{row.title || row.id}</span>
          <Show when={row.trashed}>
            <Tag>{t("operator.obs.status.session.trash")}</Tag>
          </Show>
          <span data-slot="operator-obs-row-actions">
            <ButtonV2
              size="small"
              variant="ghost"
              disabled={!!row.trashed}
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                openView(row.id, "user")
              }}
            >
              {t("operator.obs.openInChats")}
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              disabled={!!row.trashed}
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                openView(row.id, "transcript")
              }}
            >
              {t("operator.obs.transcript")}
            </ButtonV2>
          </span>
        </span>
      ),
    },
    {
      id: "agent",
      header: t("operator.obs.col.agent"),
      help: t("operator.obs.help.agent"),
      value: (row) => row.agent ?? "",
      cell: (row) => (
        <span class="inline-flex items-center gap-1">
          {row.agent}
          <Show when={row.agent_type && row.agent_type !== "usual"}>
            <Tag>{t(`operator.obs.agentType.${row.agent_type}` as "operator.obs.agentType.subagent")}</Tag>
          </Show>
        </span>
      ),
    },
    {
      id: "project",
      header: t("operator.obs.col.project"),
      help: t("operator.obs.help.project"),
      cell: (row) => {
        const found = projectOf(row.project_key)
        return (
          <span title={found ? namespaces.name(found.namespace ?? "") : (row.project_key ?? "")}>
            {found?.label ?? (row.project_key ? shortPath(row.project_key) : "")}
          </span>
        )
      },
    },
    {
      id: "started",
      header: t("operator.obs.col.started"),
      help: t("operator.obs.help.started"),
      value: (row) => row.first_ms,
      cell: (row) => (
        <span title={formatDateTime(row.first_ms ?? undefined, language.intl())}>
          {formatAgo(row.first_ms ?? undefined, language.intl())}
        </span>
      ),
    },
    {
      id: "lastActivity",
      header: t("operator.obs.col.lastActivity"),
      help: t("operator.obs.help.lastActivity"),
      value: (row) => row.last_ms,
      cell: (row) => (
        <span title={formatDateTime(row.last_ms ?? undefined, language.intl())}>
          {formatAgo(row.last_ms ?? undefined, language.intl())}
        </span>
      ),
    },
    {
      id: "duration",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.duration"),
      help: t("operator.obs.help.sessionDuration"),
      value: (row) => (row.last_ms ?? 0) - (row.first_ms ?? 0),
      cell: (row) => duration((row.last_ms ?? 0) - (row.first_ms ?? 0)),
    },
    {
      id: "active",
      align: "end",
      header: t("operator.obs.col.active"),
      help: t("operator.obs.help.active"),
      value: (row) => row.active_ms,
      cell: (row) => duration(row.active_ms),
    },
    {
      id: "wait",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.wait"),
      help: t("operator.obs.help.wait"),
      value: (row) => row.wait_ms,
      cell: (row) => (row.wait_ms ? duration(row.wait_ms) : ""),
    },
    {
      id: "turns",
      align: "end",
      header: t("operator.obs.col.turns"),
      help: t("operator.obs.help.turns"),
      value: (row) => row.turns,
      cell: (row) => <Count value={row.turns} />,
    },
    {
      id: "modelCalls",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.modelCalls"),
      help: t("operator.obs.help.modelCalls"),
      value: (row) => row.model_calls,
      cell: (row) => <Count value={row.model_calls} />,
    },
    {
      id: "toolCalls",
      align: "end",
      header: t("operator.obs.col.toolCalls"),
      help: t("operator.obs.help.toolCalls"),
      value: (row) => row.tool_calls,
      cell: (row) => <Count value={row.tool_calls} />,
    },
    {
      id: "errors",
      align: "end",
      header: t("operator.obs.col.errors"),
      help: t("operator.obs.help.errors"),
      value: (row) => row.errors,
      cell: (row) => <Count value={row.errors} tone="bad" />,
    },
    {
      id: "denials",
      align: "end",
      header: t("operator.obs.col.denials"),
      help: t("operator.obs.help.denials"),
      value: (row) => row.denials,
      cell: (row) => <Count value={row.denials} />,
    },
    {
      id: "retries",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.retries"),
      help: t("operator.obs.help.retries"),
      value: (row) => row.retries,
      cell: (row) => <Count value={row.retries} />,
    },
    {
      id: "tokens",
      align: "end",
      header: t("operator.obs.col.tokens"),
      help: t("operator.obs.help.tokens"),
      value: (row) => row.tokens_input,
      cell: (row) => <Tokens row={row} />,
    },
    {
      id: "cacheHit",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.cacheHit"),
      help: t("operator.obs.help.cacheHit"),
      cell: (row) => <CacheHit row={row} />,
    },
    {
      id: "cost",
      align: "end",
      header: t("operator.obs.col.cost"),
      help: t("operator.obs.help.cost"),
      value: (row) => row.cost_total,
      cell: (row) => (
        <Cost
          value={row.cost_total}
          title={t("operator.obs.costSplit", {
            own: new Intl.NumberFormat(language.intl(), {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 4,
            }).format(row.cost),
            subagents: new Intl.NumberFormat(language.intl(), {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 4,
            }).format(Math.max(0, row.cost_total - row.cost)),
          })}
        />
      ),
    },
    {
      id: "model",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.model"),
      help: t("operator.obs.help.model"),
      value: (row) => row.model ?? "",
      cell: (row) => row.model ?? "",
    },
    {
      id: "namespace",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.namespace"),
      help: t("operator.obs.help.namespace"),
      cell: (row) => {
        const found = projectOf(row.project_key)
        return namespaces.name(found?.namespace ?? "opencode")
      },
    },
    {
      id: "subagents",
      optional: true,
      hidden: true,
      align: "end",
      header: t("operator.obs.col.subagents"),
      help: t("operator.obs.help.subagents"),
      value: (row) => row.subagents,
      cell: (row) => <Count value={row.subagents} />,
    },
    {
      id: "loop",
      optional: true,
      hidden: true,
      header: t("operator.obs.col.loop"),
      help: t("operator.obs.help.loop"),
      cell: (row) => (row.loop ? t(`operator.obs.loop.${row.loop}` as "operator.obs.loop.same-call") : ""),
    },
  ]

  return (
    <div data-component="operator-obs-sessions">
      <Show when={sessions.isError}>
        <div data-slot="operator-error" role="alert">
          {String((sessions.error as Error | undefined)?.message ?? sessions.error)}
          <ButtonV2 size="small" variant="outline" onClick={() => void sessions.refetch()}>
            {t("operator.obs.retry")}
          </ButtonV2>
        </div>
      </Show>
      <DataTable<Row>
        label={t("operator.obs.tab.sessions")}
        rows={rows()}
        columns={columns}
        columnsKey="observability-sessions"
        loading={sessions.isPending}
        empty={props.empty()}
        server={{
          sort: sort(),
          onSort: (next) => props.onSort(next ? `${next.column}:${next.direction}` : undefined),
        }}
        rowAttrs={(row) => ({ "data-testid": "obs-session-row", "data-session": row.id })}
        onRowClick={(row) => props.onOpen(row)}
      />
      <div data-slot="operator-obs-paging">
        <Show when={total()}>
          <span data-slot="operator-note">{t("operator.obs.paging", { shown: rows().length, total: total() })}</span>
        </Show>
        <Show when={sessions.hasNextPage}>
          <ButtonV2
            size="small"
            variant="outline"
            disabled={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
          >
            {t("operator.obs.loadMore")}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}

export const turnCounts = (attrs: string | null) => {
  const value = attrsOf({ attrs })
  return {
    modelCalls: Number(value.modelCalls) || 0,
    toolCalls: Number(value.toolCalls) || 0,
    retries: Number(value.retries) || 0,
    compactions: Number(value.compactions) || 0,
    errors: Number(value.errors) || 0,
  }
}
