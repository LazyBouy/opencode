import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorProject, OperatorPromptCatalog, OperatorPromptProject } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo, formatCost, formatCount } from "../format"
import { DataTable } from "../ui/data-table"
import { useFolderBrowser } from "../ui/folder-browser"
import { PageHeader } from "../ui/page-header"
import { requestError } from "./config-helpers"
import { useNamespaces, useProfileNames } from "./profile-data"
import { namespaceDefault, OPENCODE } from "./profile-model"
import { useProjectPromptDialog, useProjectSettings } from "./project-prompt"

// A project row: a project the server knows, or a folder outside git that only has prompt settings.
type Row = OperatorProject & { folder?: boolean }

// Every project the server knows. Each project has its own agents, config and sessions; global and
// built-in agents are shared by all of them. Each project is in one namespace, which holds the prompt
// profiles its agents use.
export default function ProjectsPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const browse = useFolderBrowser()
  const names = useProfileNames()
  const namespaces = useNamespaces()
  const settings = useProjectSettings()
  const editPrompt = useProjectPromptDialog()
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

  // Every namespace's catalog, for the names of the purposes and profiles projects link.
  const catalogs = useQuery(() => ({
    queryKey: api.key(
      "prompt-catalog",
      "all",
      (namespaces.data ?? []).map((item) => item.namespace.id),
    ),
    enabled: !!namespaces.data,
    queryFn: () =>
      Promise.all(
        (namespaces.data ?? []).map((item) =>
          api
            .client()
            .operator.namespace.catalog({ ns: item.namespace.id })
            .then((result) => result.data!),
        ),
      ),
  }))
  const catalogOf = (ns: string): OperatorPromptCatalog | undefined =>
    catalogs.data?.find((item) => item.namespace.id === ns)
  const settingOf = (key: string): OperatorPromptProject =>
    settings.data?.find((item) => item.key === key) ?? {
      key,
      name: key.split("/").filter(Boolean).at(-1) ?? key,
      namespace: OPENCODE,
    }
  const rows = createMemo<Row[]>(() => {
    const known = projects.data ?? []
    const worktrees = new Set(known.map((project) => project.worktree))
    // Folders outside git have prompt settings of their own but no project row.
    const folders = (settings.data ?? [])
      .filter((item) => !worktrees.has(item.key))
      .map((item) => ({
        id: item.key,
        name: item.name,
        worktree: item.key,
        global: false,
        sessions: 0,
        cost: 0,
        created: 0,
        folder: true,
      }))
    return [...known, ...folders]
  })
  const nsName = (key: string) => {
    const ns = settingOf(key).namespace
    return namespaces.data?.find((item) => item.namespace.id === ns)?.namespace.name ?? ns
  }
  const purposeName = (key: string) => {
    const setting = settingOf(key)
    if (!setting.purpose) return language.t("operator.projects.noPurpose")
    return catalogOf(setting.namespace)?.layers.find((layer) => layer.id === setting.purpose)?.name ?? setting.purpose
  }
  const profileName = (key: string) => {
    const setting = settingOf(key)
    const catalog = catalogOf(setting.namespace)
    const id = setting.defaultProfile ?? (catalog ? namespaceDefault(catalog) : undefined)
    const found = catalog?.profiles.find((profile) => profile.id === id)
    const name = found ? names.profile(found) : (id ?? "")
    return setting.defaultProfile ? name : language.t("operator.projects.namespaceDefault", { name })
  }

  const scoped = (page: string, project: OperatorProject) =>
    navigate(`/operator/${page}?dir=${encodeURIComponent(project.worktree)}`)

  // Opens the folder in this browser and loads it on the server, which records it as a project.
  const add = (directories: string[]) => {
    const conn = server.current
    if (!conn) return
    void Promise.all(
      directories.map((directory) => {
        global.ensureServerCtx(conn).projects.open(directory)
        return api
          .client()
          .project.current({ directory })
          .then((result) => {
            const worktree = result.data?.worktree
            return !worktree || worktree === "/" ? directory : worktree
          })
      }),
    )
      .then(async (keys) => {
        await queryClient.invalidateQueries({ queryKey: api.key("project-summaries") })
        await queryClient.invalidateQueries({ queryKey: api.key("projects") })
        await queryClient.invalidateQueries({ queryKey: api.key("project-settings") })
        // A new project goes to OpenCode unless another namespace is chosen.
        if ((namespaces.data ?? []).length < 2) return
        for (const key of keys) await editPrompt(settingOf(key), true)
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.projects.addFailed"), description: requestError(error) }),
      )
  }
  // Any folder in the server's workspace, including new ones created in the browser.
  const choose = async () => {
    const directory = await browse()
    if (directory) add([directory])
  }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.projects.title")}
        description={language.t("operator.page.projects.description")}
        actions={
          <ButtonV2 size="small" variant="contrast" onClick={() => void choose()}>
            {language.t("operator.projects.add")}
          </ButtonV2>
        }
      />
      <p data-slot="operator-note">{language.t("operator.projects.hint")}</p>
      <DataTable
        label={language.t("operator.page.projects.title")}
        rows={rows()}
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
                  <Show when={project.folder}>
                    <Tag>{language.t("operator.projects.folder")}</Tag>
                  </Show>
                </span>
                <span data-slot="operator-cell-clamp">
                  {project.global ? language.t("operator.projects.globalHint") : project.worktree}
                </span>
              </span>
            ),
          },
          {
            id: "namespace",
            header: language.t("operator.column.namespace"),
            value: (project) => (project.global ? "" : nsName(project.worktree)),
            cell: (project) => (project.global ? "" : nsName(project.worktree)),
          },
          {
            id: "purpose",
            header: language.t("operator.column.purpose"),
            cell: (project) =>
              project.global ? "" : <span data-slot="operator-cell-clamp">{purposeName(project.worktree)}</span>,
          },
          {
            id: "defaultProfile",
            header: language.t("operator.column.defaultProfile"),
            cell: (project) =>
              project.global ? "" : <span data-slot="operator-cell-clamp">{profileName(project.worktree)}</span>,
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
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    aria-label={language.t("operator.projects.promptFor", { name: settingOf(project.worktree).name })}
                    onClick={() => void editPrompt(settingOf(project.worktree))}
                  >
                    {language.t("operator.projects.prompt")}
                  </ButtonV2>
                </Show>
                <Show when={!project.global && !project.folder}>
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
