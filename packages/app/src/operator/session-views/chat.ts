import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useOperatorProjects } from "../project"
import { rememberedProject } from "../scope"

const OPENCODE = "opencode"

// Chat (the first item of the operator sidebar): the default agent's main session in the default
// project, made the first time. The default project is the one chosen last on the operator pages
// (while it is a project), else the first project in the OpenCode namespace, else the first project.
export function useOpenDefaultChat() {
  const api = useOperatorClient()
  const language = useLanguage()
  const navigate = useNavigate()
  const openSession = useOpenSession()
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
