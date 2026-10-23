import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import type { MessagePartProps } from "@opencode-ai/session-ui/message-part"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { QueueRecordById } from "../pages/agent-queue"
import { type MessageMark, messageMarkOf, pingCardOf, waited } from "./messages"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Under a user message delivered from another agent (or OpenCode, or outside), in every view: who sent it, and its
// record. The user's own words carry no mark.
export function MessageMarkView(props: { parts: () => ReadonlyArray<{ type: string; metadata?: unknown }> }) {
  const language = useLanguage()
  const dialog = useDialog()
  const mark = createMemo(() => messageMarkOf(props.parts()))
  const sender = (found: MessageMark) =>
    found.from.kind === "agent"
      ? (found.from.agent ?? "—")
      : language.t(`operator.queue.sender.${found.from.kind}` as Key)
  const open = (found: MessageMark) =>
    void dialog.push(() => (
      <Dialog size="large">
        <DialogHeader>
          <DialogTitle>{language.t("operator.queue.message")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <QueueRecordById agent={found.agent} directory={found.folder} id={found.id} />
        </DialogBody>
      </Dialog>
    ))
  return (
    <Show when={mark()}>
      {(found) => (
        <div data-component="operator-hook-marks" data-testid="message-mark">
          <div data-slot="operator-extra" data-kind="message">
            <Tag>
              {language.t(found().replyTo ? "operator.messages.mark.reply" : "operator.messages.mark.from", {
                sender: sender(found()),
              })}
            </Tag>
            <Show when={found().priority !== "normal"}>
              <span>{language.t(`operator.queue.priority.${found().priority}`)}</span>
            </Show>
            <button type="button" data-slot="operator-link" onClick={() => open(found())}>
              {language.t("operator.messages.mark.record")}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

// Under a `ping` call, in every view: what it did, its messages, and with `wait` the time it has waited, then the
// reply.
export function PingCardView(props: { part: MessagePartProps["part"] }) {
  const language = useLanguage()
  const card = createMemo(() => pingCardOf(props.part as never))
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => {
    if (card()?.status === "waiting") setNow(Date.now())
  }, 1000)
  onCleanup(() => clearInterval(timer))
  return (
    <Show when={card()}>
      {(found) => (
        <div data-component="operator-hook-marks" data-testid="ping-card">
          <div data-slot="operator-extra" data-kind="ping">
            <Tag data-warning={found().status === "refused" ? "" : undefined}>
              {language.t(`operator.ping.verb.${found().verb}` as Key)}
            </Tag>
            <Show when={found().target}>
              <span>{found().target}</span>
            </Show>
            <span data-testid="ping-status">
              {language.t(`operator.ping.status.${found().status.replace(" ", "-")}` as Key)}
            </span>
            <Show when={found().reason}>
              <span>{found().reason}</span>
            </Show>
          </div>
          <For each={found().messages ?? []}>
            {(message) => (
              <div data-slot="operator-extra" data-kind="ping-message">
                <span>{message.to}</span>
                <span>{message.reason ? `${message.status}: ${message.reason}` : message.status}</span>
                <Show when={message.id}>
                  <code>{message.id}</code>
                </Show>
              </div>
            )}
          </For>
          <Show when={found().status === "waiting" && found().wait}>
            {(wait) => (
              <div data-slot="operator-extra" data-kind="ping-waiting" data-testid="ping-waiting">
                {language.t("operator.ping.waiting", {
                  from: wait().from ?? found().target ?? "",
                  time: waited(now() - wait().since),
                })}
              </div>
            )}
          </Show>
          <Show when={found().status === "no reply" && found().wait}>
            {(wait) => (
              <div data-slot="operator-extra" data-kind="ping-no-reply">
                {language.t("operator.ping.noReply", { seconds: String(wait().timeout) })}
              </div>
            )}
          </Show>
          <Show when={found().reply}>
            {(reply) => (
              <details data-slot="operator-extra" data-kind="ping-reply" data-testid="ping-reply" open>
                <summary>
                  <Tag>{language.t("operator.ping.reply", { from: reply().from })}</Tag>
                </summary>
                <pre data-component="operator-code">{reply().text}</pre>
              </details>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
