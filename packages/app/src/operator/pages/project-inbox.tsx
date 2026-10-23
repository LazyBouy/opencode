import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorInboxTarget, OperatorMessage, OperatorQueuePriority } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { ready, useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatDateTime } from "../format"
import { type Column, DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { OverlayFrame } from "../ui/overlay-frame"
import { useOverlayParams } from "../ui/overlay-nav"
import { PageHeader } from "../ui/page-header"
import { useMoveToTrash } from "../ui/confirm"
import { RecordField, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { SelectV2 } from "../ui/select"
import { requestError } from "./config-helpers"
import {
  PRIORITIES,
  recipientText,
  senderOf,
  STATUS_OF,
  statusSlug,
  type Tab,
  TABS,
  TARGET_TYPES,
  tabOf,
} from "./project-inbox-model"
import { OptionalSelect, RulesTab } from "./project-inbox-rules"
import { MessageStatus, useSenderWord } from "../ui/message-words"
import { useOpenConversation } from "../session-views/conversation"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// The Project inbox (SPEC-0023 §10.1), `/operator/project-inbox?project=<id>&dir=<folder>`: what entered a
// project's inbox (Messages), what waits for the manager (Waiting: Forward, Drop), what nothing could deliver (Dead
// letter: Forward to…, Broadcast, Route again, Delete), the ordered Rules with Test, and Settings. New message
// writes to the inbox, or straight to an agent's queue; Settings → Messaging (server-wide) is an overlay of the
// page (`?msettings=1`), so no upstream Settings file changes. A message opens in its record (`?msg=<id>`).

export type InboxPlace = { project: () => string; directory: () => string | undefined }

export default function ProjectInboxPage() {
  const language = useLanguage()
  const [search] = useSearchParams<{ project?: string; dir?: string }>()
  const [params, setParams] = useOverlayParams<{ itab?: string; msg?: string; newmsg?: string; msettings?: string }>()
  const place: InboxPlace = { project: () => search.project ?? "", directory: () => search.dir }
  const name = () => (search.dir ? search.dir.split("/").filter(Boolean).at(-1) : undefined) ?? search.project ?? ""
  const tab = () => tabOf(params.itab)
  useInboxUpdates(place)
  useRecordOverlay(
    () => !!params.msg,
    () => <MessageOverlay {...place} />,
    ["msg"],
  )
  useRecordOverlay(
    () => !!params.newmsg,
    () => <NewMessageOverlay {...place} />,
    ["newmsg"],
  )
  useRecordOverlay(
    () => !!params.msettings,
    () => <MessagingSettingsOverlay {...place} />,
    ["msettings"],
  )
  return (
    <>
      <PageHeader
        title={language.t("operator.inbox.title", { name: name() })}
        description={language.t("operator.inbox.description")}
        actions={
          <span class="flex items-center gap-2">
            <ButtonV2 size="small" variant="contrast" onClick={() => setParams({ newmsg: "1" })}>
              {language.t("operator.inbox.new")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => setParams({ msettings: "1" })}>
              {language.t("operator.messaging.settingsTitle")}
            </ButtonV2>
          </span>
        }
      />
      <Show when={place.project()} fallback={<p data-slot="operator-note">{language.t("operator.inbox.noProject")}</p>}>
        <TabsV2
          value={tab()}
          onChange={(value: string) => setParams({ itab: value === "messages" ? undefined : value })}
        >
          <TabsV2.List aria-label={language.t("operator.inbox.tabs")} data-testid="inbox-tabs">
            <For each={TABS}>
              {(id) => <TabsV2.Trigger value={id}>{language.t(`operator.inbox.tab.${id}` as Key)}</TabsV2.Trigger>}
            </For>
          </TabsV2.List>
          <For each={TABS}>
            {(id) => (
              <TabsV2.Content value={id}>
                <Show when={tab() === id}>
                  <Show
                    when={id === "rules"}
                    fallback={
                      <Show when={id === "settings"} fallback={<MessagesTab {...place} tab={id} />}>
                        <InboxSettingsTab {...place} />
                      </Show>
                    }
                  >
                    <RulesTab {...place} />
                  </Show>
                </Show>
              </TabsV2.Content>
            )}
          </For>
        </TabsV2>
      </Show>
    </>
  )
}

// The page's lists follow the inbox: a message routed, forwarded, dropped or deleted anywhere.
function useInboxUpdates(place: InboxPlace) {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const serverSdk = useServerSDK()
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string }
    if (details?.type !== "operator.inbox.updated" && details?.type !== "operator.queue.updated") return
    void queryClient.invalidateQueries({ queryKey: api.key("project-inbox", place.project()) })
    void queryClient.invalidateQueries({ queryKey: api.key("message") })
  })
  onCleanup(stop)
}

function MessagesTab(props: InboxPlace & { tab: Tab }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [, setParams] = useOverlayParams<{ msg?: string }>()
  const sender = useSenderWord()
  const [filter, setFilter] = createSignal("")
  const status = () => STATUS_OF[props.tab]
  const messages = useQuery(() => ({
    queryKey: api.key("project-inbox", props.project(), "messages", status() ?? "all"),
    queryFn: () =>
      api
        .client()
        .operator.projectInbox.messages(
          {
            project: props.project(),
            directory: props.directory(),
            ...(status() ? { status: status() } : {}),
            limit: "500",
          },
          { throwOnError: true },
        )
        .then((result) => result.data ?? []),
  }))
  const locale = () => language.intl()
  const columns: Column<OperatorMessage>[] = [
    {
      id: "time",
      header: language.t("operator.inbox.column.time"),
      value: (message) => message.createdAt,
      cell: (message) => (
        <span title={formatDateTime(message.createdAt, locale())}>{formatAgo(message.createdAt, locale())}</span>
      ),
    },
    {
      id: "from",
      header: language.t("operator.queue.from"),
      value: (message) => sender(message),
      cell: (message) => sender(message),
    },
    {
      id: "to",
      header: language.t("operator.inbox.column.requested"),
      help: language.t("operator.inbox.help.requested"),
      value: (message) => recipientText(message.to) ?? "",
      cell: (message) => recipientText(message.to) ?? "—",
    },
    {
      id: "routedTo",
      header: language.t("operator.inbox.column.routedTo"),
      cell: (message) => <span data-slot="operator-cell-clamp">{message.routedTo?.join(", ") || "—"}</span>,
    },
    {
      id: "by",
      header: language.t("operator.inbox.column.by"),
      help: language.t("operator.inbox.help.by"),
      value: (message) => message.routedBy ?? "",
      cell: (message) => message.routedBy ?? "—",
    },
    {
      id: "status",
      header: language.t("operator.inbox.column.status"),
      value: (message) => message.status,
      cell: (message) => <MessageStatus status={message.status} />,
    },
    {
      id: "text",
      optional: true,
      header: language.t("operator.queue.message"),
      cell: (message) => <span data-slot="operator-cell-clamp">{message.body.text}</span>,
    },
    {
      id: "priority",
      optional: true,
      hidden: true,
      header: language.t("operator.queue.priority"),
      value: (message) => PRIORITIES.indexOf(message.priority),
      cell: (message) => language.t(`operator.queue.priority.${message.priority}`),
    },
    {
      id: "correlation",
      optional: true,
      hidden: true,
      header: language.t("operator.queue.correlation"),
      cell: (message) => <code>{message.correlationID}</code>,
    },
  ]
  return (
    <div data-component="operator-inbox-messages" data-testid={`inbox-${props.tab}`}>
      <Show when={props.tab !== "messages"}>
        <p data-slot="operator-note">{language.t(`operator.inbox.tabHint.${props.tab}` as Key)}</p>
      </Show>
      <div data-slot="operator-toolbar">
        <TextInputV2
          type="search"
          appearance="base"
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
          placeholder={language.t("operator.inbox.search")}
          aria-label={language.t("operator.inbox.search")}
        />
      </div>
      <DataTable
        columnsKey="project-inbox"
        label={language.t(`operator.inbox.tab.${props.tab}` as Key)}
        rows={ready(messages) ?? []}
        loading={messages.isPending}
        columns={columns}
        filter={filter()}
        search={(message) => `${message.body.text} ${sender(message)} ${message.routedBy ?? ""} ${message.id}`}
        initialSort={{ column: "time", direction: "desc" }}
        empty={language.t(`operator.inbox.empty.${props.tab}` as Key)}
        onRowClick={(message) => setParams({ msg: message.id })}
        rowAttrs={(message) => ({ "data-testid": "inbox-message", "data-message": message.id })}
      />
    </div>
  )
}

// A message's record: the full text, who sent it and what it asked for, where it went, its trail, the sessions
// involved; and for one waiting or dead, the actions.
function MessageOverlay(props: InboxPlace) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const openSession = useOpenSession()
  const moveToTrash = useMoveToTrash()
  const sender = useSenderWord()
  const openConversation = useOpenConversation()
  const [params, setParams] = useOverlayParams<{ msg?: string }>()
  const message = useQuery(() => ({
    queryKey: api.key("message", params.msg),
    enabled: !!params.msg,
    queryFn: () =>
      api
        .client()
        .operator.message.get({ id: params.msg!, directory: props.directory() }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const [form, setForm] = createStore({
    forwarding: false,
    type: "agent" as OperatorInboxTarget["type"],
    id: "",
    reason: "",
    busy: false,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key() })
  const act = async (run: () => Promise<unknown>) => {
    setForm("busy", true)
    try {
      await run()
      setForm({ forwarding: false, id: "", reason: "" })
      await refresh()
    } catch (error) {
      showToast({ title: language.t("operator.inbox.actionFailed"), description: requestError(error) })
    } finally {
      setForm("busy", false)
    }
  }
  const id = () => params.msg!
  const locale = () => language.intl()
  const actionable = () => ready(message)?.status === "with manager" || ready(message)?.status === "dead letter"
  const dead = () => ready(message)?.status === "dead letter" || ready(message)?.status === "dropped"
  return (
    <OverlayFrame label={language.t("operator.inbox.record")} editing={form.forwarding}>
      <div data-component="operator-inbox-overlay">
        <Show
          when={ready(message)}
          fallback={
            <p data-slot="operator-note">
              {message.isError ? language.t("operator.inbox.missing") : language.t("common.loading")}
            </p>
          }
        >
          {(found) => (
            <RecordView
              title={<MessageStatus status={found().status} />}
              actions={
                <>
                  <Show when={found().from.session}>
                    {(session) => (
                      <ButtonV2 size="small" variant="outline" onClick={() => openSession(session())}>
                        {language.t("operator.inbox.openSender")}
                      </ButtonV2>
                    )}
                  </Show>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    onClick={() => openConversation(found().correlationID, props.directory())}
                  >
                    {language.t("operator.conversation.openButton")}
                  </ButtonV2>
                  <Show when={actionable()}>
                    <ButtonV2 size="small" variant="contrast" onClick={() => setForm("forwarding", true)}>
                      {language.t("operator.inbox.forward")}
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={form.busy}
                      onClick={() =>
                        void act(() =>
                          api
                            .client()
                            .operator.message.drop(
                              { id: id(), directory: props.directory(), reason: form.reason },
                              { throwOnError: true },
                            ),
                        )
                      }
                    >
                      {language.t("operator.inbox.drop")}
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={form.busy}
                      onClick={() =>
                        void act(() =>
                          api
                            .client()
                            .operator.message.routeAgain(
                              { id: id(), directory: props.directory() },
                              { throwOnError: true },
                            ),
                        )
                      }
                    >
                      {language.t("operator.inbox.routeAgain")}
                    </ButtonV2>
                  </Show>
                  <Show when={found().status === "dead letter"}>
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={form.busy}
                      onClick={() =>
                        void act(() =>
                          api
                            .client()
                            .operator.message.broadcast(
                              { id: id(), directory: props.directory() },
                              { throwOnError: true },
                            ),
                        )
                      }
                    >
                      {language.t("operator.inbox.broadcast")}
                    </ButtonV2>
                  </Show>
                  <Show when={dead()}>
                    <ButtonV2
                      size="small"
                      variant="danger"
                      onClick={() =>
                        void moveToTrash(found().body.text.split("\n")[0]!.slice(0, 60) || found().id, () =>
                          act(async () => {
                            await api
                              .client()
                              .operator.message.remove(
                                { id: id(), directory: props.directory() },
                                { throwOnError: true },
                              )
                            setParams({ msg: undefined })
                          }),
                        )
                      }
                    >
                      {language.t("operator.inbox.delete")}
                    </ButtonV2>
                  </Show>
                </>
              }
            >
              <Show when={form.forwarding}>
                <section data-component="operator-panel" data-testid="inbox-forward">
                  <h3 data-slot="operator-panel-title">{language.t("operator.inbox.forwardTitle")}</h3>
                  <span class="flex items-center gap-2">
                    <SelectV2<OperatorInboxTarget["type"]>
                      appearance="base"
                      aria-label={language.t("operator.inbox.field.targetType")}
                      options={TARGET_TYPES}
                      current={form.type}
                      label={(value) => language.t(`operator.inbox.recipient.${value}` as Key)}
                      onSelect={(value) => value && setForm("type", value)}
                    />
                    <TextInputV2
                      appearance="base"
                      aria-label={language.t("operator.inbox.field.recipientId")}
                      value={form.id}
                      onInput={(event) => setForm("id", event.currentTarget.value)}
                    />
                    <ButtonV2
                      size="small"
                      disabled={form.busy || !form.id.trim()}
                      onClick={() =>
                        void act(() =>
                          api
                            .client()
                            .operator.message.forward(
                              { id: id(), directory: props.directory(), to: [{ type: form.type, id: form.id.trim() }] },
                              { throwOnError: true },
                            ),
                        )
                      }
                    >
                      {language.t("operator.inbox.forwardSend")}
                    </ButtonV2>
                    <ButtonV2 size="small" variant="ghost" onClick={() => setForm("forwarding", false)}>
                      {language.t("operator.inbox.rules.cancel")}
                    </ButtonV2>
                  </span>
                </section>
              </Show>
              <Show when={actionable()}>
                <Field
                  label={language.t("operator.inbox.dropReason")}
                  hint={language.t("operator.inbox.help.dropReason")}
                >
                  <TextInputV2
                    appearance="base"
                    value={form.reason}
                    onInput={(event) => setForm("reason", event.currentTarget.value)}
                  />
                </Field>
              </Show>
              <dl data-component="operator-facts" data-layout="stacked" data-testid="inbox-record">
                <RecordField
                  label={language.t("operator.queue.message")}
                  help={language.t("operator.help.queueMessage")}
                >
                  <pre data-component="operator-code">{found().body.text}</pre>
                </RecordField>
                <RecordField label={language.t("operator.queue.from")} help={language.t("operator.help.queueFrom")}>
                  {sender(found())}
                </RecordField>
                <RecordField
                  label={language.t("operator.inbox.column.requested")}
                  help={language.t("operator.inbox.help.requested")}
                >
                  {recipientText(found().to) ?? "—"}
                </RecordField>
                <RecordField
                  label={language.t("operator.inbox.column.routedTo")}
                  help={language.t("operator.inbox.help.routedTo")}
                >
                  {found().routedTo?.join(", ") || "—"}
                </RecordField>
                <RecordField label={language.t("operator.inbox.column.by")} help={language.t("operator.inbox.help.by")}>
                  {found().routedBy ?? "—"}
                </RecordField>
                <RecordField
                  label={language.t("operator.queue.priority")}
                  help={language.t("operator.help.queuePriority")}
                >
                  {language.t(`operator.queue.priority.${found().priority}`)}
                </RecordField>
                <RecordField
                  label={language.t("operator.queue.correlation")}
                  help={language.t("operator.help.queueCorrelation")}
                >
                  <code>{found().correlationID}</code>
                </RecordField>
                <Show when={found().replyTo}>
                  <RecordField
                    label={language.t("operator.queue.replyTo")}
                    help={language.t("operator.help.queueReplyTo")}
                  >
                    <button type="button" data-slot="operator-link" onClick={() => setParams({ msg: found().replyTo })}>
                      {found().replyTo}
                    </button>
                  </RecordField>
                </Show>
                <RecordField label={language.t("operator.inbox.hops")} help={language.t("operator.inbox.help.hops")}>
                  {String(found().hops)}
                </RecordField>
                <RecordField label={language.t("operator.queue.id")} help={language.t("operator.help.queueId")}>
                  {found().id}
                </RecordField>
              </dl>
              <Show when={found().copies?.length}>
                <section data-component="operator-panel" data-testid="inbox-copies">
                  <h3 data-slot="operator-panel-title">{language.t("operator.inbox.copies")}</h3>
                  <ul data-slot="operator-plain-list">
                    <For each={found().copies}>
                      {(copy) => (
                        <li>
                          {copy.agent ?? "—"} · <MessageStatus status={copy.status} />{" "}
                          <Show when={copy.sessionID}>
                            {(session) => (
                              <button type="button" data-slot="operator-link" onClick={() => openSession(session())}>
                                {language.t("operator.queue.openSession")}
                              </button>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
              <section data-component="operator-panel" data-testid="inbox-trail">
                <h3 data-slot="operator-panel-title">{language.t("operator.inbox.trail")}</h3>
                <ol data-slot="operator-plain-list">
                  <For each={found().trail}>
                    {(step) => (
                      <li>
                        <span title={formatDateTime(step.at, locale())}>{formatAgo(step.at, locale())}</span> ·{" "}
                        <strong>{step.kind}</strong>
                        <Show when={step.detail}>: {step.detail}</Show>
                      </li>
                    )}
                  </For>
                </ol>
              </section>
            </RecordView>
          )}
        </Show>
      </div>
    </OverlayFrame>
  )
}

// New message: to the inbox (its rules, then the manager, decide), or straight to an agent's queue.
function NewMessageOverlay(props: InboxPlace) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const [, setParams] = useOverlayParams<{ newmsg?: string; msg?: string }>()
  const [form, setForm] = createStore({
    text: "",
    to: "" as "" | OperatorInboxTarget["type"],
    id: "",
    priority: "normal" as OperatorQueuePriority,
    steer: false,
    straight: false,
    busy: false,
    error: "",
  })
  const send = async () => {
    setForm({ busy: true, error: "" })
    try {
      if (form.straight && form.to === "agent") {
        await api.client().operator.queue.send(
          {
            name: form.id.trim(),
            directory: props.directory(),
            text: form.text,
            priority: form.priority,
            steer: form.steer,
          },
          { throwOnError: true },
        )
        setParams({ newmsg: undefined })
      } else {
        const entered = await api.client().operator.projectInbox.enter(
          {
            project: props.project(),
            directory: props.directory(),
            text: form.text,
            ...(form.to && form.id.trim() ? { to: { type: form.to, id: form.id.trim() } } : {}),
            priority: form.priority,
            steer: form.steer,
          },
          { throwOnError: true },
        )
        setParams({ newmsg: undefined, msg: entered.data!.id })
      }
      await queryClient.invalidateQueries({ queryKey: api.key() })
    } catch (error) {
      setForm("error", requestError(error))
    } finally {
      setForm("busy", false)
    }
  }
  return (
    <OverlayFrame label={language.t("operator.inbox.new")} editing={!!form.text}>
      <div data-component="operator-inbox-overlay">
        <section data-component="operator-panel" data-testid="inbox-new-message">
          <Field label={language.t("operator.queue.message")} hint={language.t("operator.inbox.help.newText")}>
            <TextareaV2 value={form.text} onInput={(event) => setForm("text", event.currentTarget.value)} />
          </Field>
          <Field
            label={language.t("operator.inbox.field.recipient")}
            hint={language.t("operator.inbox.help.newRecipient")}
            group
          >
            <span class="flex items-center gap-2">
              <OptionalSelect
                aria-label={language.t("operator.inbox.field.recipient")}
                options={TARGET_TYPES}
                value={form.to}
                label={(value) => language.t(`operator.inbox.recipient.${value || "none"}` as Key)}
                onSelect={(value) => setForm("to", value)}
              />
              <Show when={form.to}>
                <TextInputV2
                  appearance="base"
                  aria-label={language.t("operator.inbox.field.recipientId")}
                  value={form.id}
                  onInput={(event) => setForm("id", event.currentTarget.value)}
                />
              </Show>
            </span>
          </Field>
          <Show when={form.to === "agent"}>
            <CheckboxV2
              label={language.t("operator.inbox.straight")}
              checked={form.straight}
              onChange={(value: boolean) => setForm("straight", value)}
            />
            <p data-slot="operator-note">{language.t("operator.inbox.help.straight")}</p>
          </Show>
          <Field label={language.t("operator.queue.priority")} hint={language.t("operator.help.queuePriority")}>
            <SelectV2<OperatorQueuePriority>
              appearance="base"
              options={PRIORITIES}
              current={form.priority}
              label={(value) => language.t(`operator.queue.priority.${value}`)}
              onSelect={(value) => value && setForm("priority", value)}
            />
          </Field>
          <CheckboxV2
            label={language.t("operator.queue.steer")}
            checked={form.steer}
            onChange={(value: boolean) => setForm("steer", value)}
          />
          <div data-slot="operator-actions" class="flex gap-2">
            <ButtonV2
              size="small"
              disabled={form.busy || !form.text.trim() || (form.straight && !form.id.trim())}
              onClick={() => void send()}
            >
              {form.straight && form.to === "agent"
                ? language.t("operator.inbox.sendStraight")
                : language.t("operator.inbox.sendToInbox")}
            </ButtonV2>
          </div>
          <Show when={form.error}>
            <pre data-slot="operator-error" role="alert">
              {form.error}
            </pre>
          </Show>
        </section>
      </div>
    </OverlayFrame>
  )
}

// The inbox's settings: unmatched messages, the manager (the record's Members), the transport.
function InboxSettingsTab(props: InboxPlace) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const settings = useQuery(() => ({
    queryKey: api.key("project-inbox", props.project(), "settings"),
    queryFn: () =>
      api
        .client()
        .operator.projectInbox.settings(
          { project: props.project(), directory: props.directory() },
          { throwOnError: true },
        )
        .then((result) => result.data!),
  }))
  const setUnmatched = (unmatched: "dead-letter" | "broadcast") =>
    api
      .client()
      .operator.projectInbox.setSettings(
        { project: props.project(), directory: props.directory(), unmatched },
        { throwOnError: true },
      )
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("project-inbox", props.project()) }))
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.inbox.actionFailed"), description: requestError(error) }),
      )
  return (
    <section data-component="operator-panel" data-testid="inbox-settings">
      <Show when={ready(settings)} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
        {(found) => (
          <>
            <Field
              label={language.t("operator.inbox.unmatched")}
              hint={language.t("operator.inbox.help.unmatched")}
              group
            >
              <SegmentedControlV2
                aria-label={language.t("operator.inbox.unmatched")}
                value={found().unmatched}
                onChange={(value) => (value === "dead-letter" || value === "broadcast") && void setUnmatched(value)}
                data-testid="inbox-unmatched"
              >
                <SegmentedControlItemV2 value="dead-letter">
                  {language.t("operator.inbox.unmatched.dead-letter")}
                </SegmentedControlItemV2>
                <SegmentedControlItemV2 value="broadcast">
                  {language.t("operator.inbox.unmatched.broadcast")}
                </SegmentedControlItemV2>
              </SegmentedControlV2>
            </Field>
            <Field label={language.t("operator.inbox.manager")} hint={language.t("operator.inbox.help.manager")} group>
              <span class="flex items-center gap-2">
                {found().manager ?? language.t("operator.inbox.noManager")}
                <Show when={props.directory()}>
                  {(folder) => (
                    <button
                      type="button"
                      data-slot="operator-link"
                      onClick={() =>
                        navigate(`/operator/projects?project=${encodeURIComponent(folder())}&psec=members`)
                      }
                    >
                      {language.t("operator.inbox.openMembers")}
                    </button>
                  )}
                </Show>
              </span>
            </Field>
            <Field
              label={language.t("operator.inbox.transport")}
              hint={language.t("operator.inbox.help.transport")}
              group
            >
              <span>{language.t(`operator.inbox.transport.${found().transport}` as Key)}</span>
            </Field>
          </>
        )}
      </Show>
    </section>
  )
}

// Settings → Messaging: server-wide. The rate limits and the default wait; the backends' state.
function MessagingSettingsOverlay(props: InboxPlace) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const settings = useQuery(() => ({
    queryKey: api.key("messaging-settings"),
    queryFn: () =>
      api
        .client()
        .operator.messaging.settings({ directory: props.directory() })
        .then((result) => result.data!),
  }))
  const status = useQuery(() => ({
    queryKey: api.key("messaging-status"),
    queryFn: () =>
      api
        .client()
        .operator.messaging.status({ directory: props.directory() })
        .then((result) => result.data!),
  }))
  const [store, setStore] = createStore({ perMinute: "", perHour: "", wait: "", dirty: false, busy: false, error: "" })
  createEffect(
    on(
      () => ready(settings),
      (found) =>
        found &&
        !store.dirty &&
        setStore({ perMinute: String(found.perMinute), perHour: String(found.perHour), wait: String(found.wait) }),
    ),
  )
  const save = async () => {
    setStore({ busy: true, error: "" })
    try {
      await api.client().operator.messaging.setSettings(
        {
          directory: props.directory(),
          perMinute: Number(store.perMinute),
          perHour: Number(store.perHour),
          wait: Number(store.wait),
        },
        { throwOnError: true },
      )
      setStore("dirty", false)
      await queryClient.invalidateQueries({ queryKey: api.key("messaging-settings") })
    } catch (error) {
      setStore("error", requestError(error))
    } finally {
      setStore("busy", false)
    }
  }
  const number = (key: "perMinute" | "perHour" | "wait", label: Key, help: Key) => (
    <Field label={language.t(label)} hint={language.t(help)}>
      <TextInputV2
        appearance="base"
        inputMode="numeric"
        value={store[key]}
        onInput={(event) => setStore({ [key]: event.currentTarget.value, dirty: true })}
      />
    </Field>
  )
  const state = createMemo(() => ready(status))
  return (
    <OverlayFrame label={language.t("operator.messaging.settingsTitle")} editing={store.dirty}>
      <div data-component="operator-inbox-overlay" data-testid="messaging-settings">
        <section data-component="operator-panel">
          <h3 data-slot="operator-panel-title">{language.t("operator.messaging.limits")}</h3>
          {number("perMinute", "operator.messaging.perMinute", "operator.messaging.help.perMinute")}
          {number("perHour", "operator.messaging.perHour", "operator.messaging.help.perHour")}
          {number("wait", "operator.messaging.wait", "operator.messaging.help.wait")}
          <div data-slot="operator-actions">
            <ButtonV2 size="small" disabled={store.busy || !store.dirty} onClick={() => void save()}>
              {language.t("operator.inbox.rules.save")}
            </ButtonV2>
          </div>
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
        </section>
        <section data-component="operator-panel" data-testid="messaging-status">
          <h3 data-slot="operator-panel-title">{language.t("operator.messaging.state")}</h3>
          <Show when={state()} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
            {(found) => (
              <dl data-component="operator-facts" data-layout="stacked">
                <RecordField
                  label={language.t("operator.messaging.memoryLane")}
                  help={language.t("operator.messaging.help.memoryLane")}
                >
                  <span data-testid="messaging-memory-lane">
                    {language.t(
                      found().memoryLane.backend === "redis"
                        ? "operator.messaging.memoryLane.redis"
                        : "operator.messaging.memoryLane.state",
                      {
                        held: String(found().memoryLane.held),
                        cap: String(found().memoryLane.cap),
                      },
                    )}
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("operator.messaging.redis")}
                  help={language.t("operator.messaging.help.redis")}
                >
                  <span data-testid="messaging-redis">
                    {found().redis === "not configured"
                      ? language.t("operator.messaging.notConfigured")
                      : language.t(`operator.messaging.redis.${found().redis}` as Key, {
                          host: found().memoryLane.host ?? "",
                        })}
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("operator.messaging.rabbitmq")}
                  help={language.t("operator.messaging.help.rabbitmq")}
                >
                  <span data-testid="messaging-rabbitmq">
                    {found().rabbitmq === "not configured"
                      ? language.t("operator.messaging.notConfigured")
                      : language.t(`operator.messaging.rabbitmq.${found().rabbitmq}` as Key, {
                          host: found().rabbitmqHost ?? "",
                          outbox: String(found().outbox),
                        })}
                  </span>
                </RecordField>
                <RecordField
                  label={language.t("operator.inbox.transport")}
                  help={language.t("operator.inbox.help.transport")}
                >
                  {language.t(`operator.inbox.transport.${found().inboxTransport}` as Key)}
                </RecordField>
              </dl>
            )}
          </Show>
        </section>
      </div>
    </OverlayFrame>
  )
}
