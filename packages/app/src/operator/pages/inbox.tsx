import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { createMemo, For, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorNotification } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { asList, ready, useOperatorClient, usePendingPermissions } from "../data"
import { formatAgo, shortPath } from "../format"
import { type Column, DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { LiveIndicator } from "../ui/live-indicator"
import { PageHeader } from "../ui/page-header"
import { DecidedRequests } from "../ui/permission-requests"
import { type OverlayBlock, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { ReplyCard } from "../ui/reply-card"
import { closeTopOverlay, useOverlayParams } from "../ui/overlay-nav"
import { needsAttention, useFiringAlerts } from "../alert-badge"
import { eventsLink, FiringList } from "./observability/alerts"

// Pending permission requests, grouped project → session, oldest first (as the server returns them).
function useInbox() {
  const pending = usePendingPermissions()
  const items = () => asList(ready(pending))
  const groups = createMemo(() =>
    Object.entries(Object.groupBy(items(), (item) => item.project?.key ?? item.directory)).map(([project, list]) => ({
      project,
      sessions: Object.entries(Object.groupBy(list ?? [], (item) => item.request.sessionID)).map(
        ([sessionID, requests]) => ({ sessionID, requests: requests ?? [] }),
      ),
    })),
  )
  return { pending, items, groups }
}

// The overview of every waiting request across projects (fixes_spec.md §3.3); a request opens its
// reply card in the overlay (`ask`). Decided lists recent decisions from every session.
export default function InboxPage() {
  const language = useLanguage()
  const { pending, groups } = useInbox()
  const notes = useNotes()
  const alerts = useFiringAlerts()
  const [params, setParams] = useSearchParams<{ ask?: string; itab?: string }>()
  useRecordOverlay(
    () => !!params.ask,
    () => <AskOverlay />,
    ["ask"],
  )

  return (
    <>
      <PageHeader
        title={language.t("operator.page.inbox.title")}
        description={language.t("operator.page.inbox.description")}
        actions={<LiveIndicator live={!pending.isError} />}
      >
        <SegmentedControlV2
          class="operator-segmented-fit"
          value={TABS.includes(params.itab ?? "") ? params.itab! : "waiting"}
          onChange={(value) =>
            value && setParams({ itab: TABS.includes(value) ? value : undefined }, { replace: true })
          }
          aria-label={language.t("operator.requests.title")}
        >
          <SegmentedControlItemV2 value="waiting">{language.t("operator.requests.waiting")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="decided">{language.t("operator.requests.decided")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="notes">
            {language.t("operator.notes.tab", { count: notes.data?.length ?? 0 })}
          </SegmentedControlItemV2>
          <SegmentedControlItemV2 value="alerts">
            {language.t("operator.inbox.alertsTab", { count: needsAttention(ready(alerts) ?? []).length })}
          </SegmentedControlItemV2>
        </SegmentedControlV2>
      </PageHeader>
      <Show when={params.itab === "notes"}>
        <HelperNotes />
      </Show>
      <Show when={params.itab === "alerts"}>
        <InboxAlerts />
      </Show>
      <Show when={params.itab !== "notes" && params.itab !== "alerts"}>
        <Show when={params.itab !== "decided"} fallback={<DecidedRequests filter={{}} />}>
          <Show
            when={groups().length > 0}
            fallback={
              <EmptyState
                icon="shield"
                title={pending.isPending ? language.t("common.loading") : language.t("operator.inbox.empty")}
                description={pending.isPending ? undefined : language.t("operator.inbox.emptyHint")}
              />
            }
          >
            <For each={groups()}>
              {(group) => (
                <section data-component="operator-panel">
                  <h2 data-slot="operator-panel-title" title={group.project}>
                    {shortPath(group.project)}
                  </h2>
                  <For each={group.sessions}>
                    {(session) => (
                      <div data-component="operator-ask-group">
                        <span data-slot="operator-note">
                          {session.requests[0]?.session?.title ?? session.sessionID}
                        </span>
                        <For each={session.requests}>
                          {(item) => (
                            <article
                              data-component="operator-ask"
                              data-request={item.request.id}
                              onClick={() => {
                                // Dragging across the request selects its text to copy; only a plain click opens it.
                                if (window.getSelection()?.toString()) return
                                setParams({ ask: item.request.id })
                              }}
                            >
                              <div data-slot="operator-ask-head">
                                <Tag variant="accent">{item.request.permission}</Tag>
                                <Show when={item.session?.agent}>{(agent) => <Tag>{agent()}</Tag>}</Show>
                                <span data-slot="operator-ask-age">{formatAgo(item.time, language.intl())}</span>
                              </div>
                              <ul data-slot="operator-ask-patterns">
                                <For each={item.request.patterns}>
                                  {(pattern) => (
                                    <li>
                                      <code>{pattern}</code>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </article>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </Show>
    </>
  )
}

const TABS = ["waiting", "decided", "notes", "alerts"]

// The overlay a request opens in: the projects with requests on the left; the request's reply card.
// Once answered it leaves the list: the next one opens, else the overlay closes.
function AskOverlay() {
  const language = useLanguage()
  const { items, groups } = useInbox()
  const [params, setParams] = useOverlayParams<{ ask?: string }>()
  const item = createMemo(() => items().find((entry) => entry.request.id === params.ask))
  const blocks = createMemo<OverlayBlock[]>(() =>
    groups().map((group) => ({
      id: group.project,
      label: shortPath(group.project),
      icon: "shield",
      empty: language.t("operator.inbox.empty"),
      records: group.sessions.flatMap((session) =>
        session.requests.map((entry) => ({
          id: entry.request.id,
          label: entry.request.permission,
          detail: entry.session?.title ?? session.sessionID,
        })),
      ),
    })),
  )
  const next = () => {
    const order = blocks().flatMap((block) => block.records.map((record) => record.id))
    const following = order[order.indexOf(params.ask ?? "") + 1]
    if (following) setParams({ ask: following })
    else closeTopOverlay()
  }

  return (
    <RecordOverlay
      title={language.t("operator.page.inbox.title")}
      namespaces={[]}
      blocks={blocks()}
      block={item()?.project?.key ?? item()?.directory ?? blocks()[0]?.id ?? ""}
      record={params.ask}
      editing={false}
      onBlock={(id) => setParams({ ask: blocks().find((block) => block.id === id)?.records[0]?.id })}
      onRecord={(_, id) => setParams({ ask: id })}
    >
      <Show when={item()} fallback={<p data-slot="operator-note">{language.t("operator.inbox.answered")}</p>}>
        {(found) => (
          <RecordView title={<Tag variant="accent">{found().request.permission}</Tag>}>
            <ReplyCard item={found()} via="inbox" onDecided={next} />
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}

// Helpers' notes (agent_types_spec.md §4.6: the notify system action), newest first; Dismiss removes one.
function useNotes() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("notifications"),
    refetchInterval: 30_000,
    queryFn: () =>
      api
        .client()
        .operator.notification.list()
        .then((result) => result.data ?? []),
  }))
}

function HelperNotes() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const notes = useNotes()
  const dismiss = (id: string) =>
    api
      .client()
      .operator.notification.dismiss({ id })
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("notifications") }))
  const columns: Column<OperatorNotification>[] = [
    {
      id: "time",
      header: language.t("operator.notes.time"),
      value: (note) => note.time,
      cell: (note) => formatAgo(note.time, language.intl()),
    },
    {
      id: "helper",
      header: language.t("operator.notes.helper"),
      value: (note) => note.helper,
      cell: (note) => `${note.helper} · ${note.namespace}`,
    },
    {
      id: "project",
      header: language.t("operator.column.project"),
      value: (note) => note.project,
      cell: (note) => (note.project ? shortPath(note.project) : "—"),
    },
    { id: "message", header: language.t("operator.notes.message"), cell: (note) => note.message },
    {
      id: "dismiss",
      header: "",
      cell: (note) => (
        <ButtonV2
          size="small"
          variant="outline"
          onClick={(event: MouseEvent) => {
            event.stopPropagation()
            void dismiss(note.id)
          }}
        >
          {language.t("operator.notes.dismiss")}
        </ButtonV2>
      ),
    },
  ]
  return (
    <DataTable
      label={language.t("operator.notes.title")}
      rows={notes.data ?? []}
      columns={columns}
      loading={notes.isPending}
      empty={language.t("operator.notes.empty")}
      initialSort={{ column: "time", direction: "desc" }}
    />
  )
}

// Firing alerts (observability_spec.md §14.5), under an "Alerts" heading, with Acknowledge; View events opens them in
// Observability.
function InboxAlerts() {
  const language = useLanguage()
  const navigate = useNavigate()
  const alerts = useFiringAlerts()
  return (
    <section data-component="operator-panel" data-testid="inbox-alerts">
      <h2 data-slot="operator-panel-title">{language.t("operator.inbox.alerts")}</h2>
      <Show
        when={ready(alerts)?.length}
        fallback={<p data-slot="operator-note">{language.t("operator.obs.alerts.noneFiring")}</p>}
      >
        <FiringList
          events={ready(alerts)!}
          onEvents={(event) => {
            const link = eventsLink(event)
            const query = new URLSearchParams({
              tab: "events",
              ...link.filter,
              from: String(link.from),
              to: String(link.to),
            })
            navigate(`/operator/observability?${query}`)
          }}
        />
      </Show>
    </section>
  )
}
