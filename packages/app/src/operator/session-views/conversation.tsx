import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import type { OperatorConversation, OperatorMessage } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatDateTime } from "../format"
import { MessageStatus, useSenderWord } from "../ui/message-words"

// A conversation (SPEC-0023, the user's request of 2026-10-23): every message sharing a correlation id, oldest
// first, across every session it went between: who sent each from which session, where it went, and what happened
// to it; and the sessions, each opened from here. Opened from a message's mark in the chat, a ping call's card, and
// a message's record (Queue tab, Project inbox).

export function useOpenConversation() {
  const dialog = useDialog()
  const language = useLanguage()
  return (correlationID: string, directory?: string) =>
    void dialog.push(() => (
      <Dialog size="large">
        <DialogHeader>
          <DialogTitle>{language.t("operator.conversation.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ConversationView correlationID={correlationID} directory={directory} />
        </DialogBody>
      </Dialog>
    ))
}

type Session = OperatorConversation["sessions"][number]

export function ConversationView(props: { correlationID: string; directory?: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const dialog = useDialog()
  const openSession = useOpenSession()
  const sender = useSenderWord()
  const conversation = useQuery(() => ({
    queryKey: api.key("conversation", props.correlationID),
    queryFn: () =>
      api
        .client()
        .operator.conversation.get(
          { correlationID: props.correlationID, directory: props.directory },
          { throwOnError: true },
        )
        .then((result) => result.data!),
  }))
  const sessions = createMemo(() => new Map((ready(conversation)?.sessions ?? []).map((item) => [item.id, item])))
  const locale = () => language.intl()
  const open = (session: Session) => {
    dialog.close()
    openSession(session.id)
  }
  const sessionLink = (id: string | undefined) => {
    const found = id ? sessions().get(id) : undefined
    if (!found) return null
    return (
      <button
        type="button"
        data-slot="operator-link"
        disabled={!found.exists}
        title={found.id}
        onClick={() => open(found)}
      >
        {found.title ?? found.id}
      </button>
    )
  }
  // Where it went: the Project inbox, or an agent (and the session it reached).
  const recipient = (message: OperatorMessage) =>
    message.inbox && !message.sessionID ? (
      <span>
        {language.t("operator.conversation.inbox")}
        <Show when={message.routedTo?.length}> → {message.routedTo!.join(", ")}</Show>
      </span>
    ) : (
      <span>
        {message.agent ?? "—"} <Show when={message.sessionID}>{sessionLink(message.sessionID)}</Show>
      </span>
    )
  return (
    <div data-component="operator-conversation" data-testid="conversation">
      <p data-slot="operator-note">
        {language.t("operator.conversation.hint")} <code>{props.correlationID}</code>
      </p>
      <Show
        when={ready(conversation)}
        fallback={
          <p data-slot="operator-note">
            {conversation.isError ? language.t("operator.conversation.failed") : language.t("common.loading")}
          </p>
        }
      >
        {(found) => (
          <>
            <section data-component="operator-panel" data-testid="conversation-sessions">
              <h3 data-slot="operator-panel-title">{language.t("operator.conversation.sessions")}</h3>
              <Show
                when={found().sessions.length}
                fallback={<p data-slot="operator-note">{language.t("operator.conversation.noSessions")}</p>}
              >
                <ul data-slot="operator-plain-list">
                  <For each={found().sessions}>
                    {(session) => (
                      <li>
                        <strong>{session.agent ?? "—"}</strong> · {session.title ?? session.id}{" "}
                        <Show
                          when={session.exists}
                          fallback={
                            <span data-slot="operator-note">{language.t("operator.conversation.deleted")}</span>
                          }
                        >
                          <ButtonV2 size="small" variant="ghost" onClick={() => open(session)}>
                            {language.t("operator.conversation.open")}
                          </ButtonV2>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
            <Show
              when={found().messages.length}
              fallback={<p data-slot="operator-note">{language.t("operator.conversation.empty")}</p>}
            >
              <ol data-component="operator-conversation-list">
                <For each={found().messages}>
                  {(message) => (
                    <li data-testid="conversation-message" data-message={message.id}>
                      <div data-slot="operator-conversation-head">
                        <span title={formatDateTime(message.createdAt, locale())}>
                          {formatAgo(message.createdAt, locale())}
                        </span>
                        <strong>{sender(message)}</strong>
                        <Show when={message.from.session}>{sessionLink(message.from.session)}</Show>
                        <span>→</span>
                        {recipient(message)}
                        <MessageStatus status={message.status} />
                        <Show when={message.replyTo}>
                          <span data-slot="operator-note">
                            {language.t("operator.conversation.answers", { id: message.replyTo! })}
                          </span>
                        </Show>
                      </div>
                      <pre data-component="operator-code">{message.body.text}</pre>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
