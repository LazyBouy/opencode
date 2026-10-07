import { useSearchParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorPendingPermission } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient, usePendingPermissions } from "../data"
import { formatAgo, shortPath } from "../format"
import { EmptyState } from "../ui/empty-state"
import { LiveIndicator } from "../ui/live-indicator"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { requestError } from "./config-helpers"
import { useOverlayParams } from "../ui/overlay-nav"

type Reply = "once" | "always" | "reject"

// Pending permission requests, and replying to them.
function useInbox() {
  const language = useLanguage()
  const api = useOperatorClient()
  const pending = usePendingPermissions()
  const [store, setStore] = createStore({ busy: {} as Record<string, boolean> })
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "inbox"),
    enabled: (pending.data?.length ?? 0) > 0,
    queryFn: () =>
      api
        .client()
        .operator.session.list({ limit: "200" })
        .then((result) => result.data ?? []),
  }))
  const titles = createMemo(() => new Map((sessions.data ?? []).map((session) => [session.id, session.title])))

  // Grouped project → session, oldest request first, as the server returns them.
  const groups = createMemo(() =>
    Object.entries(Object.groupBy(pending.data ?? [], (item) => item.directory)).map(([directory, items]) => ({
      directory,
      sessions: Object.entries(Object.groupBy(items ?? [], (item) => item.request.sessionID)).map(
        ([sessionID, requests]) => ({
          sessionID,
          requests: requests ?? [],
        }),
      ),
    })),
  )

  const reply = async (item: OperatorPendingPermission, answer: Reply) => {
    setStore("busy", item.request.id, true)
    await api
      .client()
      .permission.reply({ requestID: item.request.id, directory: item.directory, reply: answer })
      .then(() => pending.refetch())
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.inbox.replyFailed"), description: requestError(error) }),
      )
      .finally(() => setStore("busy", item.request.id, false))
  }
  return { pending, titles, groups, reply, busy: (id: string) => !!store.busy[id] }
}

// A request opens in the overlay (`ask`): its project's requests on the left, ‹ › through all of them.
export default function InboxPage() {
  const language = useLanguage()
  const openSession = useOpenSession()
  const { pending, titles, groups, reply, busy } = useInbox()
  const [params, setParams] = useSearchParams<{ ask?: string }>()
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
      />
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
              <h2 data-slot="operator-panel-title" title={group.directory}>
                {shortPath(group.directory)}
              </h2>
              <For each={group.sessions}>
                {(session) => (
                  <div data-component="operator-ask-group">
                    <button type="button" data-slot="operator-link" onClick={() => openSession(session.sessionID)}>
                      {titles().get(session.sessionID) ?? session.sessionID}
                    </button>
                    <For each={session.requests}>
                      {(item) => (
                        <article
                          data-component="operator-ask"
                          data-request={item.request.id}
                          onClick={(event) => {
                            if ((event.target as HTMLElement).closest("button")) return
                            // Dragging across the request selects its text to copy; only a plain click opens it.
                            if (window.getSelection()?.toString()) return
                            setParams({ ask: item.request.id })
                          }}
                        >
                          <div data-slot="operator-ask-head">
                            <Tag variant="accent">{item.request.permission}</Tag>
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
                          <div data-slot="operator-actions">
                            <ButtonV2
                              size="small"
                              variant="neutral"
                              disabled={busy(item.request.id)}
                              onClick={() => void reply(item, "reject")}
                            >
                              {language.t("operator.inbox.reject")}
                            </ButtonV2>
                            <ButtonV2
                              size="small"
                              variant="outline"
                              disabled={busy(item.request.id)}
                              onClick={() => void reply(item, "always")}
                            >
                              {language.t("operator.inbox.always")}
                            </ButtonV2>
                            <ButtonV2
                              size="small"
                              variant="contrast"
                              disabled={busy(item.request.id)}
                              onClick={() => void reply(item, "once")}
                            >
                              {language.t("operator.inbox.once")}
                            </ButtonV2>
                          </div>
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
    </>
  )
}

// The overlay a request opens in: the projects with requests on the left; the request's permission,
// patterns and session, and the replies. Once answered it leaves the list.
function AskOverlay() {
  const language = useLanguage()
  const openSession = useOpenSession()
  const { pending, titles, groups, reply, busy } = useInbox()
  const dialog = useDialog()
  const [params, setParams] = useOverlayParams<{ ask?: string }>()
  const item = createMemo(() => pending.data?.find((entry) => entry.request.id === params.ask))
  const blocks = createMemo<OverlayBlock[]>(() =>
    groups().map((group) => ({
      id: group.directory,
      label: shortPath(group.directory),
      icon: "shield",
      empty: language.t("operator.inbox.empty"),
      records: group.sessions.flatMap((session) =>
        session.requests.map((entry) => ({
          id: entry.request.id,
          label: entry.request.permission,
          detail: titles().get(session.sessionID) ?? session.sessionID,
        })),
      ),
    })),
  )
  // After a reply the request is gone: the next one opens, else the overlay closes.
  const answer = async (entry: OperatorPendingPermission, value: Reply) => {
    const order = blocks().flatMap((block) => block.records.map((record) => record.id))
    const next = order[order.indexOf(entry.request.id) + 1]
    await reply(entry, value)
    if (next) setParams({ ask: next })
    else dialog.close()
  }

  return (
    <RecordOverlay
      title={language.t("operator.page.inbox.title")}
      namespaces={[]}
      blocks={blocks()}
      block={item()?.directory ?? blocks()[0]?.id ?? ""}
      record={params.ask}
      editing={false}
      onBlock={(id) => setParams({ ask: blocks().find((block) => block.id === id)?.records[0]?.id })}
      onRecord={(_, id) => setParams({ ask: id })}
    >
      <Show when={item()} fallback={<p data-slot="operator-note">{language.t("operator.inbox.answered")}</p>}>
        {(found) => (
          <RecordView
            title={<Tag variant="accent">{found().request.permission}</Tag>}
            actions={
              <>
                <ButtonV2
                  variant="neutral"
                  disabled={busy(found().request.id)}
                  onClick={() => void answer(found(), "reject")}
                >
                  {language.t("operator.inbox.reject")}
                </ButtonV2>
                <ButtonV2
                  variant="outline"
                  disabled={busy(found().request.id)}
                  onClick={() => void answer(found(), "always")}
                >
                  {language.t("operator.inbox.always")}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  disabled={busy(found().request.id)}
                  onClick={() => void answer(found(), "once")}
                >
                  {language.t("operator.inbox.once")}
                </ButtonV2>
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.inbox.patterns")} help={language.t("operator.help.askPatterns")}>
                <ul>
                  <For each={found().request.patterns}>
                    {(pattern) => (
                      <li>
                        <code>{pattern}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </RecordField>
              <RecordField label={language.t("operator.inbox.session")} help={language.t("operator.help.askSession")}>
                <button type="button" data-slot="operator-link" onClick={() => openSession(found().request.sessionID)}>
                  {titles().get(found().request.sessionID) ?? found().request.sessionID}
                </button>
              </RecordField>
              <RecordField label={language.t("operator.inbox.project")} help={language.t("operator.help.askProject")}>
                {found().directory}
              </RecordField>
              <RecordField label={language.t("operator.inbox.asked")} help={language.t("operator.help.askAsked")}>
                {formatAgo(found().time, language.intl())}
              </RecordField>
            </dl>
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}
