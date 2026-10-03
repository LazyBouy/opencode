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
import { requestError } from "./config-helpers"

type Reply = "once" | "always" | "reject"

export default function InboxPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const openSession = useOpenSession()
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
      sessions: Object.entries(Object.groupBy(items ?? [], (item) => item.request.sessionID)).map(([sessionID, requests]) => ({
        sessionID,
        requests: requests ?? [],
      })),
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
                        <article data-component="operator-ask" data-request={item.request.id}>
                          <div data-slot="operator-ask-head">
                            <Tag variant="accent">{item.request.permission}</Tag>
                            <span data-slot="operator-ask-age">{formatAgo(item.time, language.intl())}</span>
                          </div>
                          <ul data-slot="operator-ask-patterns">
                            <For each={item.request.patterns}>{(pattern) => <li><code>{pattern}</code></li>}</For>
                          </ul>
                          <div data-slot="operator-actions">
                            <ButtonV2 size="small" variant="neutral" disabled={store.busy[item.request.id]} onClick={() => void reply(item, "reject")}>
                              {language.t("operator.inbox.reject")}
                            </ButtonV2>
                            <ButtonV2 size="small" variant="outline" disabled={store.busy[item.request.id]} onClick={() => void reply(item, "always")}>
                              {language.t("operator.inbox.always")}
                            </ButtonV2>
                            <ButtonV2 size="small" variant="contrast" disabled={store.busy[item.request.id]} onClick={() => void reply(item, "once")}>
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
