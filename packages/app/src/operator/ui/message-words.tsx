import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { OperatorMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { senderOf, statusSlug } from "../pages/project-inbox-model"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// How a message's sender and status read, wherever messages are shown (the Project inbox, a conversation).

/** Who sent it, in words. */
export function useSenderWord() {
  const language = useLanguage()
  // From another project than the one it went to: an inbox message's inbox, else the message's own project.
  return (message: Pick<OperatorMessage, "from" | "inbox" | "project">) => {
    const sender = senderOf(message.from, message.inbox ?? message.project)
    if (sender.kind === "agent") return language.t("operator.queue.sender.agent", { agent: sender.agent })
    if (sender.kind === "otherProject")
      return language.t("operator.queue.sender.otherProject", { agent: sender.agent, project: sender.project })
    return language.t(`operator.queue.sender.${sender.kind}` as Key)
  }
}

export function MessageStatus(props: { status: string }) {
  const language = useLanguage()
  const warning = () => props.status === "dead letter" || props.status === "failed" || props.status === "with manager"
  return (
    <Tag data-warning={warning() ? "" : undefined}>
      {language.t(`operator.messages.status.${statusSlug(props.status)}` as Key)}
    </Tag>
  )
}
