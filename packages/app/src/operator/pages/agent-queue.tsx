import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "../ui/select"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorQueueItem, OperatorQueuePriority } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatDateTime } from "../format"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { RecordField, RecordView } from "../ui/record-overlay"
import { useOpenConversation } from "../session-views/conversation"
import { requestError } from "./config-helpers"

// The agent's input queue in a project: where its messages go when they name no session (its main or
// active session), a form to queue one, and its messages. A message waits until its session is idle
// and starts the session's next turn; a steering message goes in at once.

const PRIORITIES: OperatorQueuePriority[] = ["urgent", "high", "normal", "low"]
// "default": the agent's default target; "session": a session chosen below.
type Destination = "default" | "main" | "active" | "session" | "new"

export function AgentQueue(props: { agent: string; directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const dialog = useDialog()
  const locale = () => language.intl()
  const fail = (error: unknown) =>
    showToast({ title: language.t("operator.agent.actionFailed"), description: requestError(error) })

  const state = useQuery(() => ({
    queryKey: api.key("agent-session-state", props.directory, props.agent),
    queryFn: () =>
      api
        .client()
        .operator.agentSessions.state({ name: props.agent, directory: props.directory })
        .then((result) => result.data!),
  }))
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "agent", props.directory, props.agent),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ within: props.directory, agent: props.agent, limit: "100" })
        .then((result) => result.data ?? []),
  }))
  const items = useQuery(() => ({
    queryKey: api.key("agent-queue", props.directory, props.agent),
    queryFn: () =>
      api
        .client()
        .operator.queue.agent({ name: props.agent, directory: props.directory, limit: "200" })
        .then((result) => result.data ?? []),
  }))
  // Messages change as they are delivered.
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: { agent?: string } }
    if (details?.type !== "operator.queue.updated" || details.properties?.agent !== props.agent) return
    void items.refetch()
    void state.refetch()
  })
  onCleanup(stop)

  const sessionTitle = (id: string | undefined) => {
    if (!id) return "—"
    if (state.data?.main?.id === id) return state.data.main.title
    if (state.data?.active?.id === id) return state.data.active.title
    return sessions.data?.find((item) => item.id === id)?.title || id
  }

  const setTarget = (target: "main" | "active") =>
    api
      .client()
      .operator.agentSessions.setTarget(
        { name: props.agent, directory: props.directory, target },
        { throwOnError: true },
      )
      .then(() => state.refetch())
      .catch(fail)

  const [form, setForm] = createStore({
    text: "",
    destination: "default" as Destination,
    session: "",
    priority: "normal" as OperatorQueuePriority,
    steer: false,
    sending: false,
  })
  const destinationLabel = (value: Destination) =>
    value === "default"
      ? language.t("operator.queue.toDefault", {
          target: language.t(`operator.queue.target.${state.data?.target ?? "main"}`),
        })
      : language.t(`operator.queue.target.${value}`)
  const send = async () => {
    const session = form.destination === "session" ? form.session || sessions.data?.[0]?.id : undefined
    setForm("sending", true)
    await api
      .client()
      .operator.queue.send(
        {
          name: props.agent,
          directory: props.directory,
          text: form.text,
          ...(form.destination === "main" || form.destination === "active" || form.destination === "new"
            ? { target: form.destination }
            : {}),
          ...(session ? { sessionID: session } : {}),
          priority: form.priority,
          steer: form.steer,
        },
        { throwOnError: true },
      )
      .then(() => {
        setForm({ text: "", steer: false })
        return items.refetch()
      })
      .catch(fail)
    setForm("sending", false)
  }
  const cancel = (id: string) =>
    api
      .client()
      .operator.queue.cancel({ id, directory: props.directory }, { throwOnError: true })
      .then(() => items.refetch())
      .catch(fail)

  const open = (item: OperatorQueueItem) =>
    void dialog.push(() => (
      <Dialog size="large">
        <DialogHeader>
          <DialogTitle>{language.t("operator.queue.message")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <QueueRecord
            item={items.data?.find((found) => found.id === item.id) ?? item}
            sessionTitle={sessionTitle}
            onCancel={(id) => cancel(id).then(() => dialog.close())}
            answered={items.data?.find((found) => found.id === item.replyTo)}
            onOpen={(other) => {
              dialog.close()
              open(other)
            }}
          />
        </DialogBody>
      </Dialog>
    ))

  return (
    <>
      <section data-component="operator-panel" data-testid="agent-queue-settings">
        <Field group label={language.t("operator.queue.defaultTarget")} hint={language.t("operator.help.queueTarget")}>
          <SegmentedControlV2
            value={state.data?.target ?? "main"}
            class="operator-segmented-fit"
            onChange={(value) => (value === "main" || value === "active") && void setTarget(value)}
            data-testid="agent-queue-target"
          >
            <SegmentedControlItemV2 value="main">{language.t("operator.queue.target.main")}</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="active">{language.t("operator.queue.target.active")}</SegmentedControlItemV2>
          </SegmentedControlV2>
        </Field>
        <p data-slot="operator-note">
          {language.t("operator.queue.now", {
            main: state.data?.main?.title ?? language.t("operator.queue.noneYet"),
            active: state.data?.active?.title ?? language.t("operator.queue.noneYet"),
          })}
        </p>
      </section>

      <section data-component="operator-panel" data-testid="agent-queue-form">
        <Field label={language.t("operator.queue.message")} hint={language.t("operator.help.queueMessage")}>
          <TextareaV2
            rows={3}
            value={form.text}
            placeholder={language.t("operator.queue.placeholder", { agent: props.agent })}
            onInput={(event) => setForm("text", event.currentTarget.value)}
          />
        </Field>
        <div data-slot="operator-tool-controls">
          <Field group label={language.t("operator.queue.sendTo")} hint={language.t("operator.help.queueSendTo")}>
            <SelectV2<Destination>
              appearance="base"
              aria-label={language.t("operator.queue.sendTo")}
              options={["default", "main", "active", "session", "new"]}
              current={form.destination}
              label={destinationLabel}
              onSelect={(value) => value && setForm("destination", value)}
            />
          </Field>
          <Show when={form.destination === "session"}>
            <Field group label={language.t("operator.queue.session")} hint={language.t("operator.help.queueSession")}>
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.queue.session")}
                options={(sessions.data ?? []).filter((item) => !item.parentID).map((item) => item.id)}
                current={form.session || sessions.data?.[0]?.id}
                label={(id) => {
                  const found = sessions.data?.find((item) => item.id === id)
                  return found ? `${found.title || id} · ${formatAgo(found.time.updated, locale())}` : id
                }}
                onSelect={(id) => id && setForm("session", id)}
              />
            </Field>
          </Show>
          <Field group label={language.t("operator.queue.priority")} hint={language.t("operator.help.queuePriority")}>
            <SelectV2<OperatorQueuePriority>
              appearance="base"
              aria-label={language.t("operator.queue.priority")}
              options={PRIORITIES}
              current={form.priority}
              label={(value) => language.t(`operator.queue.priority.${value}`)}
              onSelect={(value) => value && setForm("priority", value)}
            />
          </Field>
          <Field group label={language.t("operator.queue.steer")} hint={language.t("operator.help.queueSteer")}>
            <CheckboxV2
              label={language.t("operator.queue.steerLabel")}
              checked={form.steer}
              onChange={(on: boolean) => setForm("steer", on)}
            />
          </Field>
        </div>
        <div class="flex justify-end">
          <ButtonV2
            size="small"
            variant="contrast"
            disabled={!form.text.trim() || form.sending || (form.destination === "session" && !sessions.data?.length)}
            onClick={() => void send()}
          >
            {form.steer ? language.t("operator.queue.sendSteer") : language.t("operator.queue.send")}
          </ButtonV2>
        </div>
      </section>

      <DataTable
        columnsKey="agent-queue"
        label={language.t("operator.agent.tab.queue")}
        rows={items.data ?? []}
        loading={items.isPending}
        empty={language.t("operator.queue.empty")}
        onRowClick={open}
        columns={[
          {
            id: "text",
            header: language.t("operator.queue.message"),
            cell: (item) => <span data-slot="operator-cell-clamp">{item.text}</span>,
          },
          {
            id: "status",
            header: language.t("operator.column.status"),
            help: language.t("operator.help.queueStatus"),
            cell: (item) => <QueueStatus item={item} />,
          },
          {
            id: "to",
            header: language.t("operator.queue.to"),
            help: language.t("operator.help.queueTo"),
            cell: (item) => (item.deliveredTo ? sessionTitle(item.deliveredTo) : targetText(language, item)),
          },
          {
            id: "lane",
            optional: true,
            header: language.t("operator.queue.lane"),
            help: language.t("operator.help.queueLane"),
            value: (item) => item.lane ?? "",
            cell: (item) => (item.lane ? language.t(`operator.queue.lane.${item.lane}`) : "—"),
          },
          {
            id: "from",
            optional: true,
            header: language.t("operator.queue.from"),
            help: language.t("operator.help.queueFrom"),
            value: (item) => item.sender.kind,
            cell: (item) => senderText(language, item),
          },
          {
            id: "correlation",
            optional: true,
            header: language.t("operator.queue.correlation"),
            help: language.t("operator.help.queueCorrelation"),
            cell: (item) => (
              <span class="inline-flex items-center gap-1">
                <code data-slot="operator-cell-clamp">{item.correlationID ?? "—"}</code>
                <Show when={item.replyTo}>
                  <Tag>{language.t("operator.queue.replyTag")}</Tag>
                </Show>
              </span>
            ),
          },
          {
            id: "priority",
            optional: true,
            header: language.t("operator.queue.priority"),
            cell: (item) => language.t(`operator.queue.priority.${item.priority}`),
            value: (item) => PRIORITIES.length - PRIORITIES.indexOf(item.priority),
          },
          {
            id: "created",
            optional: true,
            header: language.t("operator.queue.queued"),
            align: "end",
            cell: (item) => formatAgo(item.createdAt, locale()),
            value: (item) => item.createdAt,
          },
          {
            id: "actions",
            header: "",
            align: "end",
            cell: (item) => (
              <Show when={item.status === "queued" || item.status === "in memory"}>
                <ButtonV2
                  size="small"
                  variant="ghost"
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    void cancel(item.id)
                  }}
                >
                  {language.t("operator.queue.cancel")}
                </ButtonV2>
              </Show>
            ),
          },
        ]}
      />
    </>
  )
}

// Who sent it: you, an agent (of another project), OpenCode, or outside.
const senderText = (language: ReturnType<typeof useLanguage>, item: OperatorQueueItem) =>
  item.sender.kind === "agent"
    ? item.sender.project
      ? language.t("operator.queue.sender.otherProject", {
          agent: item.sender.agent ?? "",
          project: item.sender.project,
        })
      : language.t("operator.queue.sender.agent", { agent: item.sender.agent ?? "" })
    : language.t(`operator.queue.sender.${item.sender.kind}`)

const statusKey = (status: OperatorQueueItem["status"]) =>
  `operator.queue.status.${status === "in memory" ? "in-memory" : status}` as const

const targetText = (language: ReturnType<typeof useLanguage>, item: OperatorQueueItem) =>
  item.target === "session" ? (item.sessionID ?? "—") : language.t(`operator.queue.target.${item.target}`)

function QueueStatus(props: { item: OperatorQueueItem }) {
  const language = useLanguage()
  return (
    <span class="inline-flex items-center gap-1">
      <Tag
        variant={props.item.status === "delivered" ? "accent" : undefined}
        data-warning={props.item.status === "failed" ? "" : undefined}
        title={props.item.error}
      >
        {language.t(statusKey(props.item.status))}
      </Tag>
      <Show when={props.item.steer}>
        <Tag>{language.t("operator.queue.steerTag")}</Tag>
      </Show>
    </span>
  )
}

/** One message's record, by id, for links from elsewhere (a delivered message's mark in the chat). */
export function QueueRecordById(props: { agent: string; directory: string; id: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const dialog = useDialog()
  const items = useQuery(() => ({
    queryKey: api.key("agent-queue", props.directory, props.agent),
    queryFn: () =>
      api
        .client()
        .operator.queue.agent({ name: props.agent, directory: props.directory, limit: "200" })
        .then((result) => result.data ?? []),
  }))
  const [shown, setShown] = createSignal(props.id)
  const item = () => items.data?.find((found) => found.id === shown())
  const cancel = (id: string) =>
    api
      .client()
      .operator.queue.cancel({ id, directory: props.directory }, { throwOnError: true })
      .then(() => items.refetch())
      .then(() => dialog.close())
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.agent.actionFailed"), description: requestError(error) }),
      )
  return (
    <Show
      when={item()}
      fallback={
        <p data-slot="operator-note">
          {items.isLoading ? language.t("operator.queue.loading") : language.t("operator.queue.notListed")}
        </p>
      }
    >
      {(found) => (
        <QueueRecord
          item={found()}
          sessionTitle={(id) => id ?? "—"}
          onCancel={cancel}
          answered={items.data?.find((other) => other.id === found().replyTo)}
          onOpen={(other) => setShown(other.id)}
        />
      )}
    </Show>
  )
}

// One message, in its overlay.
function QueueRecord(props: {
  item: OperatorQueueItem
  sessionTitle: (id: string | undefined) => string
  onCancel: (id: string) => void
  /** The message this one answers, when it's in the list. */
  answered?: OperatorQueueItem
  onOpen: (item: OperatorQueueItem) => void
}) {
  const language = useLanguage()
  const openSession = useOpenSession()
  const navigate = useNavigate()
  const dialog = useDialog()
  const locale = () => language.intl()
  const sender = () => senderText(language, props.item)
  const openConversation = useOpenConversation()
  return (
    <RecordView
      title={<QueueStatus item={props.item} />}
      actions={
        <>
          <Show when={props.item.deliveredTo}>
            {(id) => (
              <>
                <ButtonV2
                  size="small"
                  variant="contrast"
                  onClick={() => {
                    dialog.close()
                    openSession(id())
                  }}
                >
                  {language.t("operator.queue.openSession")}
                </ButtonV2>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() => {
                    dialog.close()
                    navigate(`/operator/sessions?session=${encodeURIComponent(id())}`)
                  }}
                >
                  {language.t("operator.queue.sessionDetails")}
                </ButtonV2>
              </>
            )}
          </Show>
          <Show when={props.item.status === "queued" || props.item.status === "in memory"}>
            <ButtonV2 size="small" variant="danger" onClick={() => props.onCancel(props.item.id)}>
              {language.t("operator.queue.cancel")}
            </ButtonV2>
          </Show>
        </>
      }
    >
      <dl data-component="operator-facts" data-layout="stacked" data-testid="queue-record">
        <RecordField label={language.t("operator.queue.message")} help={language.t("operator.help.queueMessage")}>
          <pre data-component="operator-code">{props.item.text}</pre>
        </RecordField>
        <Show when={props.item.error}>
          <RecordField label={language.t("operator.queue.error")} help={language.t("operator.help.queueError")}>
            {props.item.error}
          </RecordField>
        </Show>
        <RecordField label={language.t("operator.queue.sendTo")} help={language.t("operator.help.queueSendTo")}>
          {props.item.target === "session"
            ? props.sessionTitle(props.item.sessionID)
            : language.t(`operator.queue.target.${props.item.target}`)}
        </RecordField>
        <RecordField label={language.t("operator.queue.deliveredTo")} help={language.t("operator.help.queueTo")}>
          {props.item.deliveredTo
            ? `${props.sessionTitle(props.item.deliveredTo)} · ${formatDateTime(props.item.deliveredAt, locale())}`
            : "—"}
        </RecordField>
        <RecordField label={language.t("operator.queue.priority")} help={language.t("operator.help.queuePriority")}>
          {language.t(`operator.queue.priority.${props.item.priority}`)}
        </RecordField>
        <RecordField label={language.t("operator.queue.steer")} help={language.t("operator.help.queueSteer")}>
          {props.item.steer ? language.t("operator.queue.yes") : language.t("operator.queue.no")}
        </RecordField>
        <RecordField label={language.t("operator.queue.from")} help={language.t("operator.help.queueFrom")}>
          {sender()}
        </RecordField>
        <RecordField label={language.t("operator.queue.queued")} help={language.t("operator.help.queueQueued")}>
          {formatDateTime(props.item.createdAt, locale())}
        </RecordField>
        <Show when={props.item.lane}>
          {(lane) => (
            <RecordField label={language.t("operator.queue.lane")} help={language.t("operator.help.queueLane")}>
              {language.t(`operator.queue.lane.${lane()}`)}
            </RecordField>
          )}
        </Show>
        <Show when={props.item.replyTo}>
          {(id) => (
            <RecordField label={language.t("operator.queue.replyTo")} help={language.t("operator.help.queueReplyTo")}>
              <Show when={props.answered} fallback={<code>{id()}</code>}>
                {(answered) => (
                  <button type="button" data-slot="operator-link" onClick={() => props.onOpen(answered())}>
                    {answered().text.slice(0, 80)}
                  </button>
                )}
              </Show>
            </RecordField>
          )}
        </Show>
        <Show when={props.item.correlationID}>
          <RecordField
            label={language.t("operator.queue.correlation")}
            help={language.t("operator.help.queueCorrelation")}
          >
            <button
              type="button"
              data-slot="operator-link"
              onClick={() => openConversation(props.item.correlationID!, props.item.project)}
            >
              {props.item.correlationID}
            </button>
          </RecordField>
        </Show>
        <RecordField label={language.t("operator.queue.id")} help={language.t("operator.help.queueId")}>
          {props.item.id}
        </RecordField>
      </dl>
    </RecordView>
  )
}
