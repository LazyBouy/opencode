import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { asList, ready, useOpenSession, useOperatorClient, usePendingPermissions } from "../data"
import { formatAgo, formatCost, formatCount, formatDateTime } from "../format"
import { PermissionRequests } from "../ui/permission-requests"
import { SessionPermissions } from "../ui/session-permissions"
import { eventSession } from "./events"
import "../operator.css"

type LiveEvent = { id: number; time: number; type: string }

// Session details for the open session tab, opened from a titlebar button (inside
// OperatorTitlebarControls, which the operator sidebar mounts), so the session page itself is unchanged.
export function SessionInspector() {
  const layout = useLayout()
  const language = useLanguage()
  const [store, setStore] = createStore({ open: false })
  const sessionID = createMemo(() => {
    const route = layout.route()
    return route.type === "session" ? route.sessionId : undefined
  })

  return (
    <Show when={sessionID()}>
      {(id) => (
        <>
          <IconButtonV2
            variant="ghost-muted"
            size="small"
            data-action="operator-inspector"
            aria-pressed={store.open}
            aria-label={language.t("operator.inspector.toggle")}
            title={language.t("operator.inspector.toggle")}
            icon={<Icon name="status" />}
            onClick={() => setStore("open", !store.open)}
          />
          <Show when={store.open}>
            <Portal>
              <InspectorPanel sessionID={id()} onClose={() => setStore("open", false)} />
            </Portal>
          </Show>
        </>
      )}
    </Show>
  )
}

function InspectorPanel(props: { sessionID: string; onClose: () => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const openSession = useOpenSession()
  const pending = usePendingPermissions()
  const [events, setEvents] = createStore({ list: [] as LiveEvent[], next: 0 })
  const locale = () => language.intl()

  const session = useQuery(() => ({
    queryKey: api.key("session", props.sessionID),
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: props.sessionID })
        .then((result) => result.data!),
    refetchInterval: 10_000,
  }))
  const children = useQuery(() => ({
    queryKey: api.key("session-children", props.sessionID),
    queryFn: () =>
      api
        .client()
        .session.children({ sessionID: props.sessionID })
        .then((result) => result.data ?? []),
    refetchInterval: 10_000,
  }))
  const asks = createMemo(() => asList(ready(pending)).filter((item) => item.request.sessionID === props.sessionID))
  const [tab, setTab] = createSignal("overview")

  // Keep the most recent events of this session, newest first.
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: unknown } | undefined
    if (!details?.type || eventSession(details.type, details.properties) !== props.sessionID) return
    setEvents({
      list: [{ id: events.next, time: Date.now(), type: details.type }, ...events.list].slice(0, 100),
      next: events.next + 1,
    })
  })
  onCleanup(stop)

  return (
    // The permission editor is a table: the panel widens while it is shown.
    <aside
      data-component="operator-inspector"
      data-wide={tab() === "permissions" ? "" : undefined}
      aria-label={language.t("operator.inspector.title")}
    >
      <header data-slot="operator-inspector-head">
        <h2 class="oc-display">{language.t("operator.inspector.title")}</h2>
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          aria-label={language.t("operator.inspector.close")}
          icon={<Icon name="close" />}
          onClick={props.onClose}
        />
      </header>
      <TabsV2 value={tab()} onChange={(value: string) => setTab(value)}>
        <TabsV2.List>
          <TabsV2.Trigger value="overview">{language.t("operator.inspector.overview")}</TabsV2.Trigger>
          <TabsV2.Trigger value="approvals">
            {language.t("operator.inspector.approvals", { count: asks().length })}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="subagents">
            {language.t("operator.inspector.subagents", { count: children.data?.length ?? 0 })}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="events">{language.t("operator.inspector.events")}</TabsV2.Trigger>
          <TabsV2.Trigger value="permissions">{language.t("operator.inspector.permissions")}</TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content value="overview">
          <Show when={session.data} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
            {(info) => (
              <dl data-component="operator-facts">
                <dt>{language.t("operator.column.title")}</dt>
                <dd>{info().title}</dd>
                <dt>{language.t("operator.column.agent")}</dt>
                <dd>{info().agent ?? "—"}</dd>
                <dt>{language.t("operator.column.model")}</dt>
                <dd>{info().model ? `${info().model!.providerID}/${info().model!.id}` : "—"}</dd>
                <dt>{language.t("operator.column.project")}</dt>
                <dd>{info().directory}</dd>
                <dt>{language.t("operator.inspector.created")}</dt>
                <dd>{formatDateTime(info().time.created, locale())}</dd>
                <dt>{language.t("operator.column.updated")}</dt>
                <dd>{formatAgo(info().time.updated, locale())}</dd>
                <dt>{language.t("operator.column.tokens")}</dt>
                <dd>
                  {language.t("operator.dashboard.tokensHint", {
                    input: formatCount(info().tokens?.input ?? 0, locale()),
                    output: formatCount(info().tokens?.output ?? 0, locale()),
                  })}
                </dd>
                <dt>{language.t("operator.column.cost")}</dt>
                <dd>{formatCost(info().cost ?? 0, locale())}</dd>
                <Show when={info().parentID}>
                  {(parent) => (
                    <>
                      <dt>{language.t("operator.inspector.parent")}</dt>
                      <dd>
                        <button type="button" data-slot="operator-link" onClick={() => openSession(parent())}>
                          {parent()}
                        </button>
                      </dd>
                    </>
                  )}
                </Show>
              </dl>
            )}
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="approvals">
          <PermissionRequests filter={{ sessionID: props.sessionID }} via="details" />
        </TabsV2.Content>
        <TabsV2.Content value="subagents">
          <Show
            when={(children.data ?? []).length > 0}
            fallback={<p data-slot="operator-note">{language.t("operator.inspector.noSubagents")}</p>}
          >
            <ul data-component="operator-list">
              <For each={children.data ?? []}>
                {(child) => (
                  <li>
                    <button type="button" data-slot="operator-link" onClick={() => openSession(child.id)}>
                      {child.title}
                    </button>
                    <span data-slot="operator-ask-age">
                      {child.agent ?? ""} · {formatAgo(child.time.updated, locale())}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="permissions">
          <Show when={tab() === "permissions"}>
            <SessionPermissions sessionID={props.sessionID} directory={session.data?.directory} />
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="events">
          <Show
            when={events.list.length > 0}
            fallback={<p data-slot="operator-note">{language.t("operator.inspector.noEvents")}</p>}
          >
            <ol data-component="operator-list" data-slot="operator-events">
              <For each={events.list}>
                {(event) => (
                  <li>
                    <code>{event.type}</code>
                    <span data-slot="operator-ask-age">{new Date(event.time).toLocaleTimeString(locale())}</span>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </TabsV2.Content>
      </TabsV2>
    </aside>
  )
}
