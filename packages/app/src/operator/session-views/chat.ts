import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { tabHref, useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useOperatorProjects } from "../project"
import { rememberedProject } from "../scope"

const OPENCODE = "opencode"

// The chat window's address used last (a session or a new session's tab), so Chats returns to it.
const LAST = "opencode.operator.lastChat"
let last: string | undefined
const readLast = () => {
  if (last !== undefined) return last
  try {
    last = localStorage.getItem(LAST) ?? ""
  } catch {
    last = ""
  }
  return last
}

// Remembers the chat tab being shown (the sidebar calls it on every navigation).
export function rememberChat(href: string) {
  if (!/\/session\/|^\/new-session/.test(href) || href === readLast()) return
  last = href
  try {
    localStorage.setItem(LAST, href)
  } catch {
    // kept for this window only
  }
}

// Whether a page is the chat window (a session, or a new session's tab).
export const isChatPage = (pathname: string) => /\/session\//.test(pathname) || pathname.startsWith("/new-session")

// Chats (the first item of the operator sidebar): the chat window with its open tabs, at the tab used
// last. With no tab open, the default agent's main session in the default project, made the first
// time. The default project is the one chosen last on the operator pages (while it is a project), else
// the first project in the OpenCode namespace, else the first project.
export function useOpenDefaultChat() {
  const api = useOperatorClient()
  const language = useLanguage()
  const navigate = useNavigate()
  const openSession = useOpenSession()
  const tabs = useTabs()
  const projects = useOperatorProjects()
  const settings = useQuery(() => ({
    queryKey: api.key("project-settings"),
    queryFn: () =>
      api
        .client()
        .operator.projectSettings.list()
        .then((result) => result.data ?? []),
  }))
  const namespaceOf = (directory: string) =>
    settings.data?.find((item) => item.key === directory)?.namespace ?? OPENCODE
  return async () => {
    if (tabs.store.length) {
      const remembered = readLast()
      tabs.select(tabs.store.find((tab) => remembered && remembered.startsWith(tabHref(tab))) ?? tabs.store.at(-1)!)
      return
    }
    const list = projects()
    const remembered = rememberedProject()
    const directory =
      (remembered && list.some((item) => item.directory === remembered) ? remembered : undefined) ??
      list.find((item) => namespaceOf(item.directory) === OPENCODE)?.directory ??
      list[0]?.directory
    if (!directory) return navigate("/")
    await api
      .client()
      .operator.agentSessions.mainSession({ directory }, { throwOnError: true })
      .then((result) => openSession(result.data.session.id))
      .catch((error: unknown) => {
        showToast({ title: language.t("operator.chat.failed"), description: requestError(error) })
        navigate("/")
      })
  }
}
