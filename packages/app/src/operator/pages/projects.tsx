import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorProject } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { Show } from "solid-js"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo, formatCost, formatCount } from "../format"
import { DataTable } from "../ui/data-table"
import { PageHeader } from "../ui/page-header"
import { requestError } from "./config-helpers"

// Every project the server knows. Each project has its own agents, config and sessions; global and
// built-in agents are shared by all of them.
export default function ProjectsPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const pickDirectory = useDirectoryPicker()
  const locale = () => language.intl()

  const projects = useQuery(() => ({
    queryKey: api.key("project-summaries"),
    queryFn: () =>
      api
        .client()
        .operator.project.list()
        .then((result) => result.data ?? []),
    refetchInterval: 60_000,
  }))

  const scoped = (page: string, project: OperatorProject) =>
    navigate(`/operator/${page}?dir=${encodeURIComponent(project.worktree)}`)

  // Opens the folder in this browser and loads it on the server, which records it as a project.
  const add = (directories: string[]) => {
    const conn = server.current
    if (!conn) return
    void Promise.all(
      directories.map((directory) => {
        global.ensureServerCtx(conn).projects.open(directory)
        return api.client().project.current({ directory })
      }),
    )
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("project-summaries") }))
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("projects") }))
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.projects.addFailed"), description: requestError(error) }),
      )
  }
  const choose = () => {
    const conn = server.current
    if (!conn) return
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        if (Array.isArray(result)) return add(result)
        if (result) add([result])
      },
    })
  }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.projects.title")}
        description={language.t("operator.page.projects.description")}
        actions={
          <ButtonV2 size="small" variant="contrast" onClick={choose}>
            {language.t("operator.projects.add")}
          </ButtonV2>
        }
      />
      <p data-slot="operator-note">{language.t("operator.projects.hint")}</p>
      <DataTable
        label={language.t("operator.page.projects.title")}
        rows={projects.data ?? []}
        loading={projects.isPending}
        empty={language.t("operator.projects.empty")}
        columns={[
          {
            id: "name",
            header: language.t("operator.column.name"),
            value: (project) => project.name ?? project.worktree,
            cell: (project) => (
              <span class="flex flex-col">
                <span class="flex items-center gap-2">
                  {project.global
                    ? language.t("operator.projects.global")
                    : (project.name ?? project.worktree.split("/").filter(Boolean).at(-1) ?? project.worktree)}
                  <Show when={project.vcs}>{(vcs) => <Tag>{vcs()}</Tag>}</Show>
                </span>
                <span data-slot="operator-cell-clamp">
                  {project.global ? language.t("operator.projects.globalHint") : project.worktree}
                </span>
              </span>
            ),
          },
          {
            id: "sessions",
            header: language.t("operator.column.sessions"),
            align: "end",
            value: (project) => project.sessions,
            cell: (project) => formatCount(project.sessions, locale()),
          },
          {
            id: "cost",
            header: language.t("operator.column.cost"),
            align: "end",
            value: (project) => project.cost,
            cell: (project) => formatCost(project.cost, locale()),
          },
          {
            id: "lastActivity",
            header: language.t("operator.column.lastUsed"),
            align: "end",
            value: (project) => project.lastActivity,
            cell: (project) => formatAgo(project.lastActivity, locale()),
          },
          {
            id: "actions",
            header: "",
            align: "end",
            cell: (project) => (
              <span class="flex justify-end gap-1 flex-wrap">
                <Show when={!project.global}>
                  <ButtonV2 size="small" variant="ghost" onClick={() => scoped("agents", project)}>
                    {language.t("operator.page.agents.title")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost" onClick={() => scoped("config", project)}>
                    {language.t("operator.page.config.title")}
                  </ButtonV2>
                </Show>
                <ButtonV2 size="small" variant="ghost" onClick={() => scoped("sessions", project)}>
                  {language.t("operator.page.sessions.title")}
                </ButtonV2>
                <Show when={!project.global}>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    onClick={() => void tabs.newDraft({ server: server.key, directory: project.worktree })}
                  >
                    {language.t("operator.projects.newSession")}
                  </ButtonV2>
                </Show>
              </span>
            ),
          },
        ]}
      />
    </>
  )
}
