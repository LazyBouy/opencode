import { useParams } from "@solidjs/router"
import { onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"

type Refused = { sessionID: string; messageID: string; hook: string; reason?: string; message: string; text?: string }

// A prompt.submitted hook refused a message (SPEC-0022 §8.1): the server didn't save it and says so with
// `operator.hook.refused` (the composer sends with prompt_async, which has answered by then). The page takes the
// message back out of the conversation, puts its text back in the composer (unless something new was typed there)
// and shows "Refused by hook <name>: <reason>".
export function useHookRefusals() {
  const params = useParams<{ id?: string }>()
  const language = useLanguage()
  const prompt = usePrompt()
  const sync = useSync()
  const serverSync = useServerSync()
  const serverSdk = useServerSDK()
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as unknown as { type?: string; properties?: Refused }
    const refused = details?.type === "operator.hook.refused" ? details.properties : undefined
    if (!refused || refused.sessionID !== params.id) return
    serverSync().session.optimistic.remove({ sessionID: refused.sessionID, messageID: refused.messageID })
    sync().set("session_status", refused.sessionID, { type: "idle" })
    const typed = prompt.current().some((part) => part.type !== "text" || part.content.trim())
    if (refused.text && !typed)
      prompt.set([{ type: "text", content: refused.text, start: 0, end: refused.text.length }], refused.text.length)
    showToast({ variant: "error", title: language.t("operator.hooks.refused"), description: refused.message })
  })
  onCleanup(stop)
}
