import { useNavigate } from "@solidjs/router"
import { useQueryClient } from "@tanstack/solid-query"
import { onCleanup } from "solid-js"
import { produce } from "solid-js/store"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { useSessionArchive } from "@/pages/session/session-archive"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useConfirm } from "../ui/confirm"

// The chat's "…" → Move to Trash… (session_fixes_spec.md §1), in place of upstream's permanent Delete.
// The session page registers its handler here (through the timeline seam, which runs in the page);
// the menu item calls `trash(id)`, and falls back to upstream's Delete when no page registered one.
const handlers: Array<(sessionID: string) => Promise<void>> = []

export function trash(sessionID: string): true | undefined {
  const handler = handlers.at(-1)
  if (!handler) return undefined
  void handler(sessionID)
  return true
}

export function useChatTrash() {
  const language = useLanguage()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const archive = useSessionArchive()
  const api = useOperatorClient()
  const queryClient = useQueryClient()

  const fail = (reason: string) => {
    showToast({ variant: "error", title: language.t("operator.chatTrash.failed", { reason }) })
  }
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key() })

  const restore = (entry: string) =>
    api
      .client()
      .operator.trash.restore({ id: entry }, { throwOnError: true })
      .then(async () => {
        await refresh()
        showToast({ variant: "success", title: language.t("operator.chatTrash.restored") })
      })
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("operator.chatTrash.restoreFailed"),
          description: requestError(error),
        }),
      )

  const handler = async (sessionID: string): Promise<void> => {
    // Never silent: a session this page doesn't hold is looked up on the server.
    const session =
      sync().session.get(sessionID) ??
      (await api
        .client()
        .session.get({ sessionID })
        .then((result) => result.data)
        .catch(() => undefined))
    if (!session) return fail(language.t("operator.chatTrash.notFound"))
    const running = (sync().data.session_status?.[sessionID]?.type ?? "idle") !== "idle"
    const name = session.title || language.t("command.session.new")
    const ok = await confirm({
      title: language.t("operator.trash.moveTitle", { name: `"${name}"` }),
      description: [
        language.t("operator.trash.moveBody"),
        ...(running ? [language.t("operator.chatTrash.running")] : []),
      ].join(" "),
      confirm: language.t("operator.trash.moveConfirm"),
      danger: true,
    })
    if (!ok) return
    if (running)
      await api
        .client()
        .session.abort({ sessionID, directory: session.directory })
        .catch(() => undefined)

    const roots = (sync().data.session ?? []).filter((item) => !item.parentID && !item.time?.archived)
    const index = roots.findIndex((item) => item.id === sessionID)
    const next = index === -1 ? undefined : (roots[index + 1] ?? roots[index - 1])
    const entry = await api
      .client()
      .operator.trash.session({ sessionID, directory: session.directory }, { throwOnError: true })
      .then((result) => result.data)
      .catch((error: unknown) => {
        fail(requestError(error))
        return undefined
      })
    if (!entry) return

    // As upstream's delete: the session and its subagents' sessions leave the page, their tabs close,
    // and the chat moves to the next session (or a new one).
    const removed = new Set<string>([sessionID, ...(entry.sessions ?? [])])
    archive.navigateAfterRemoval(sessionID, session.parentID, next?.id)
    sync().set(
      produce((draft) => {
        draft.session = draft.session.filter((item) => !removed.has(item.id))
      }),
    )
    for (const id of removed) {
      sync().session.evict(id)
      serverSync().homeSessions.remove(id)
    }
    notifySessionTabsRemoved({ directory: sdk().directory, sessionIDs: [...removed] })
    await refresh()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("operator.chatTrash.moved"),
      actions: [
        { label: language.t("operator.chatTrash.undo"), onClick: () => void restore(entry.id) },
        { label: language.t("operator.chatTrash.openTrash"), onClick: () => navigate("/operator/trash") },
      ],
    })
  }

  handlers.push(handler)
  onCleanup(() => handlers.splice(handlers.indexOf(handler), 1))
}
