import { A } from "@solidjs/router"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { useOpenSession, useOperatorClient, usePendingPermissions, useServerStatus } from "../data"
import { formatAgo, formatCost, formatCount, shortPath } from "../format"
import { DataTable } from "../ui/data-table"
import { PageHeader } from "../ui/page-header"
import { StatTile } from "../ui/stat-tile"

const RANGES = [7, 14, 30] as const

export default function DashboardPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const openSession = useOpenSession()
  const status = useServerStatus()
  const pending = usePendingPermissions()
  const [store, setStore] = persisted(Persist.global("operator.dashboard"), createStore({ days: 14 as number }))

  const stats = useQuery(() => ({
    queryKey: api.key("stats", store.days),
    queryFn: () =>
      api
        .client()
        .operator.stats({ days: String(store.days), offset: String(-new Date().getTimezoneOffset()) })
        .then((result) => result.data!),
    refetchInterval: 60_000,
  }))
  const recent = useQuery(() => ({
    queryKey: api.key("sessions", "recent"),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ limit: "8", roots: "true" })
        .then((result) => result.data ?? []),
    refetchInterval: 30_000,
  }))

  const locale = () => language.intl()
  const range = () => stats.data?.range
  const tokens = createMemo(() => (range()?.tokens.input ?? 0) + (range()?.tokens.output ?? 0))
  const series = (pick: (day: { sessions: number; cost: number; tokens: number }) => number) =>
    stats.data?.days?.map(pick)

  return (
    <>
      <PageHeader
        title={language.t("operator.page.dashboard.title")}
        description={language.t("operator.page.dashboard.description")}
        actions={
          <SegmentedControlV2
            aria-label={language.t("operator.dashboard.range")}
            value={String(store.days)}
            onChange={(value) => value && setStore("days", Number(value))}
          >
            {RANGES.map((days) => (
              <SegmentedControlItemV2 value={String(days)}>
                {language.t("operator.dashboard.days", { count: days })}
              </SegmentedControlItemV2>
            ))}
          </SegmentedControlV2>
        }
      />

      <div data-slot="operator-tiles">
        <StatTile
          label={language.t("operator.dashboard.server")}
          value={status.data?.version ?? "—"}
          hint={
            status.data
              ? language.t("operator.dashboard.runningSince", { time: formatAgo(status.data.startedAt, locale()) })
              : undefined
          }
        />
        <StatTile
          label={language.t("operator.dashboard.activeToday")}
          value={formatCount(stats.data?.activeToday ?? 0, locale())}
          hint={language.t("operator.dashboard.activeTodayHint")}
        />
        <StatTile
          label={language.t("operator.dashboard.sessions")}
          value={formatCount(range()?.sessions ?? 0, locale())}
          hint={language.t("operator.dashboard.inRange", { count: store.days })}
          trend={series((day) => day.sessions)}
        />
        <StatTile
          label={language.t("operator.dashboard.tokens")}
          value={formatCount(tokens(), locale())}
          hint={language.t("operator.dashboard.tokensHint", {
            input: formatCount(range()?.tokens.input ?? 0, locale()),
            output: formatCount(range()?.tokens.output ?? 0, locale()),
          })}
          trend={series((day) => day.tokens)}
        />
        <StatTile
          label={language.t("operator.dashboard.cost")}
          value={formatCost(range()?.cost ?? 0, locale())}
          hint={language.t("operator.dashboard.inRange", { count: store.days })}
          trend={series((day) => day.cost)}
        />
        <StatTile
          label={language.t("operator.dashboard.approvals")}
          value={formatCount(pending.data?.length ?? 0, locale())}
          tone={(pending.data?.length ?? 0) > 0 ? "warn" : "neutral"}
          hint={<A href="/operator/inbox">{language.t("operator.dashboard.openInbox")}</A>}
        />
      </div>

      <div data-slot="operator-columns">
        <section data-component="operator-panel">
          <h2 data-slot="operator-panel-title">{language.t("operator.dashboard.recent")}</h2>
          <DataTable
            label={language.t("operator.dashboard.recent")}
            rows={recent.data ?? []}
            loading={recent.isPending}
            empty={language.t("operator.dashboard.noSessions")}
            onRowClick={(session) => openSession(session.id)}
            columns={[
              { id: "title", header: language.t("operator.column.title"), cell: (session) => session.title },
              {
                id: "project",
                header: language.t("operator.column.project"),
                cell: (session) => shortPath(session.project?.worktree ?? session.directory),
              },
              { id: "agent", header: language.t("operator.column.agent"), cell: (session) => session.agent ?? "" },
              {
                id: "updated",
                header: language.t("operator.column.updated"),
                align: "end",
                cell: (session) => formatAgo(session.time.updated, locale()),
              },
            ]}
          />
        </section>
        <section data-component="operator-panel">
          <h2 data-slot="operator-panel-title">{language.t("operator.dashboard.agents")}</h2>
          <Show when={stats.data} fallback={<div data-slot="operator-panel-empty">{language.t("common.loading")}</div>}>
            {(data) => (
              <DataTable
                label={language.t("operator.dashboard.agents")}
                rows={data().agents ?? []}
                empty={language.t("operator.dashboard.noSessions")}
                initialSort={{ column: "sessions", direction: "desc" }}
                columns={[
                  {
                    id: "agent",
                    header: language.t("operator.column.agent"),
                    cell: (row) => row.agent || language.t("operator.dashboard.noAgent"),
                    value: (row) => row.agent,
                  },
                  {
                    id: "sessions",
                    header: language.t("operator.column.sessions"),
                    align: "end",
                    cell: (row) => formatCount(row.sessions, locale()),
                    value: (row) => row.sessions,
                  },
                  {
                    id: "cost",
                    header: language.t("operator.column.cost"),
                    align: "end",
                    cell: (row) => formatCost(row.cost, locale()),
                    value: (row) => row.cost,
                  },
                  {
                    id: "lastUsed",
                    header: language.t("operator.column.lastUsed"),
                    align: "end",
                    cell: (row) => formatAgo(row.lastUsed, locale()),
                    value: (row) => row.lastUsed,
                  },
                ]}
              />
            )}
          </Show>
        </section>
      </div>
    </>
  )
}
