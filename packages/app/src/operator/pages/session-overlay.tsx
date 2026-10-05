import { useSearchParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { GlobalSession, Part } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatCost, formatCount } from "../format"
import { useMoveToTrash } from "../ui/confirm"
import { DetailOverlay } from "../ui/detail-overlay"
import { RecordField, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { requestError } from "./config-helpers"

export const SESSION_TABS = ["conversation", "details", "subagents"] as const

// Opens a session (`session` in the URL; `stab` its section) in the overlay. `rows` are the page's
// sessions, in order, for ‹ ›.
export function useSessionOverlay(rows: () => ReadonlyArray<Pick<GlobalSession, "id" | "directory">>) {
  const [params, setParams] = useSearchParams<{ session?: string; stab?: string }>()
  useRecordOverlay(
    () => !!params.session,
    () => <SessionOverlay rows={rows} />,
    () => setParams({ session: undefined, stab: undefined }),
  )
  return (id: string) => setParams({ session: id })
}

// A session in the overlay: its conversation (with a prompt box to continue it), its details and its
// subagents' sessions on the left. Maximize opens the full session page, with review, files and
// terminal. Built by the fork: upstream's session page belongs to its route.
function SessionOverlay(props: { rows: () => ReadonlyArray<Pick<GlobalSession, "id" | "directory">> }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const openSession = useOpenSession()
  const dialog = useDialog()
  const moveToTrash = useMoveToTrash()
  const [params, setParams] = useSearchParams<{ session?: string; stab?: string }>()
  const id = () => params.session ?? ""
  const tab = () =>
    SESSION_TABS.includes(params.stab as (typeof SESSION_TABS)[number]) ? params.stab! : "conversation"
  const directory = () => props.rows().find((row) => row.id === id())?.directory
  const session = useQuery(() => ({
    queryKey: api.key("session", id()),
    enabled: !!id(),
    // Shown at once, not held back (suspended) while a missing session is retried.
    retry: false,
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: id(), directory: directory() })
        .then((result) => result.data),
  }))
  const folder = () => session.data?.directory ?? directory()
  const messages = useQuery(() => ({
    queryKey: api.key("session-messages", id()),
    enabled: !!id() && tab() === "conversation" && !!folder(),
    retry: false,
    // The conversation follows a running session.
    refetchInterval: 3000,
    queryFn: () =>
      api
        .client()
        .session.messages({ sessionID: id(), directory: folder(), limit: 200 })
        .then((result) => result.data ?? []),
  }))
  const children = useQuery(() => ({
    queryKey: api.key("session-children", id()),
    enabled: !!id() && tab() === "subagents" && !!folder(),
    retry: false,
    queryFn: () =>
      api
        .client()
        .session.children({ sessionID: id(), directory: folder() })
        .then((result) => result.data ?? []),
  }))
  const [store, setStore] = createStore({ text: "", busy: false })
  const locale = () => language.intl()
  const sections = createMemo(() =>
    [
      { id: "conversation", icon: "bubble-5" as const },
      { id: "details", icon: "eye" as const },
      { id: "subagents", icon: "subagent" as const },
    ].map((item) => ({
      ...item,
      label: language.t(`operator.sessionView.${item.id}` as "operator.sessionView.conversation"),
    })),
  )

  const send = async () => {
    const text = store.text.trim()
    if (!text) return
    setStore("busy", true)
    await api
      .client()
      .session.promptAsync(
        {
          sessionID: id(),
          directory: folder(),
          ...(session.data?.agent ? { agent: session.data.agent } : {}),
          parts: [{ type: "text", text }],
        },
        { throwOnError: true },
      )
      .then(async () => {
        setStore("text", "")
        await queryClient.invalidateQueries({ queryKey: api.key("session-messages", id()) })
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.sessionView.sendFailed"), description: requestError(error) }),
      )
      .finally(() => setStore("busy", false))
  }
  const remove = () =>
    moveToTrash(session.data?.title ?? id(), () =>
      api
        .client()
        .operator.trash.session({ sessionID: id() }, { throwOnError: true })
        .then(async () => {
          showToast({ title: language.t("operator.trash.moved", { name: session.data?.title ?? id() }) })
          dialog.close()
          await queryClient.invalidateQueries({ queryKey: api.key() })
        })
        .catch((error: unknown) =>
          showToast({ title: language.t("operator.trash.failed"), description: requestError(error) }),
        ),
    )

  return (
    <DetailOverlay
      title={session.data?.title ?? ""}
      sections={sections()}
      section={tab()}
      records={props.rows().map((row) => row.id)}
      record={id()}
      actions={
        <ButtonV2 size="small" variant="outline" onClick={() => openSession(id())}>
          {language.t("operator.sessionView.maximize")}
        </ButtonV2>
      }
      onSection={(section) => setParams({ stab: section })}
      onRecord={(next) => setParams({ session: next })}
    >
      <RecordView
        title={
          <>
            {session.data?.title ?? id()}
            <Show when={session.data?.agent}>{(agent) => <Tag>{agent()}</Tag>}</Show>
            <Show when={session.data?.time?.archived}>
              <Tag>{language.t("operator.sessionView.archived")}</Tag>
            </Show>
          </>
        }
        actions={
          <ButtonV2 variant="danger" onClick={() => void remove()}>
            {language.t("operator.trash.delete")}
          </ButtonV2>
        }
      >
        <Switch>
          <Match when={tab() === "conversation"}>
            <div data-component="operator-conversation">
              <For
                each={messages.data ?? []}
                fallback={
                  <p data-slot="operator-note">
                    {messages.isPending ? language.t("common.loading") : language.t("operator.sessionView.empty")}
                  </p>
                }
              >
                {(message) => (
                  <article data-slot="operator-message" data-role={message.info.role}>
                    <header data-slot="operator-message-head">
                      <strong>
                        {message.info.role === "user"
                          ? language.t("operator.sessionView.you")
                          : (message.info as { agent?: string }).agent || language.t("operator.sessionView.assistant")}
                      </strong>
                      <span data-slot="operator-note">{formatAgo(message.info.time?.created, locale())}</span>
                    </header>
                    <For each={message.parts}>{(part) => <MessagePart part={part} />}</For>
                  </article>
                )}
              </For>
              <div data-component="operator-form">
                <TextareaV2
                  rows={3}
                  aria-label={language.t("operator.sessionView.prompt")}
                  placeholder={language.t("operator.sessionView.promptPlaceholder")}
                  value={store.text}
                  onInput={(event) => setStore("text", event.currentTarget.value)}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send()
                  }}
                />
                <div data-slot="operator-actions">
                  <ButtonV2 variant="contrast" disabled={store.busy || !store.text.trim()} onClick={() => void send()}>
                    {language.t("operator.sessionView.send")}
                  </ButtonV2>
                </div>
              </div>
            </div>
          </Match>
          <Match when={tab() === "details"}>
            <Show when={session.data?.id ? session.data : undefined}>
              {(found) => (
                <dl data-component="record-fields">
                  <RecordField
                    label={language.t("operator.column.agent")}
                    help={language.t("operator.help.sessionViewAgent")}
                  >
                    {found().agent ?? "—"}
                  </RecordField>
                  <RecordField
                    label={language.t("operator.column.model")}
                    help={language.t("operator.help.sessionViewModel")}
                  >
                    {found().model ? `${found().model!.providerID}/${found().model!.id}` : "—"}
                  </RecordField>
                  <RecordField
                    label={language.t("operator.projects.folderLabel")}
                    help={language.t("operator.help.sessionViewFolder")}
                  >
                    {found().directory}
                  </RecordField>
                  <RecordField
                    label={language.t("operator.column.cost")}
                    help={language.t("operator.help.sessionViewCost")}
                  >
                    {formatCost(found().cost ?? 0, locale())}
                  </RecordField>
                  <RecordField
                    label={language.t("operator.sessionView.tokens")}
                    help={language.t("operator.help.sessionViewTokens")}
                  >
                    {language.t("operator.sessionView.tokensValue", {
                      input: formatCount(found().tokens?.input ?? 0, locale()),
                      output: formatCount(found().tokens?.output ?? 0, locale()),
                    })}
                  </RecordField>
                  <RecordField
                    label={language.t("operator.sessionView.started")}
                    help={language.t("operator.help.sessionViewStarted")}
                  >
                    {formatAgo(found().time?.created, locale())}
                  </RecordField>
                  <RecordField
                    label={language.t("operator.column.updated")}
                    help={language.t("operator.help.sessionViewUpdated")}
                  >
                    {formatAgo(found().time?.updated, locale())}
                  </RecordField>
                </dl>
              )}
            </Show>
          </Match>
          <Match when={tab() === "subagents"}>
            <For
              each={children.data ?? []}
              fallback={<p data-slot="operator-note">{language.t("operator.sessionView.noSubagents")}</p>}
            >
              {(child) => (
                <button
                  type="button"
                  data-slot="record-overlay-item"
                  onClick={() => setParams({ session: child.id, stab: "conversation" })}
                >
                  <span data-slot="record-overlay-item-label">{child.title}</span>
                  <span data-slot="record-overlay-item-detail">
                    {child.agent ?? ""} · {formatAgo(child.time?.updated, locale())}
                  </span>
                </button>
              )}
            </For>
          </Match>
        </Switch>
      </RecordView>
    </DetailOverlay>
  )
}

// One part of a message: text (as Markdown), the model's reasoning (folded), a tool call (its tool,
// title and status), or a file.
function MessagePart(props: { part: Part }) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.part.type === "text" && !(props.part as { synthetic?: boolean }).synthetic && props.part}>
        {(part) => <Markdown text={(part() as { text: string }).text} cacheKey={part().id} />}
      </Match>
      <Match when={props.part.type === "reasoning" && props.part}>
        {(part) => (
          <details data-slot="operator-details">
            <summary>{language.t("operator.sessionView.reasoning")}</summary>
            <pre data-component="operator-code">{(part() as { text: string }).text}</pre>
          </details>
        )}
      </Match>
      <Match when={props.part.type === "tool" && props.part}>
        {(part) => {
          const tool = part() as Extract<Part, { type: "tool" }>
          return (
            <p data-slot="operator-tool-call">
              <code>{tool.tool}</code>
              <Show when={"title" in tool.state && tool.state.title}>{(title) => <span> · {title()}</span>}</Show>
              <Tag>{language.t(`operator.sessionView.tool.${tool.state.status}`)}</Tag>
            </p>
          )
        }}
      </Match>
      <Match when={props.part.type === "file" && props.part}>
        {(part) => (
          <p data-slot="operator-note">
            {(part() as { filename?: string; url?: string }).filename ?? (part() as { url?: string }).url}
          </p>
        )}
      </Match>
    </Switch>
  )
}
