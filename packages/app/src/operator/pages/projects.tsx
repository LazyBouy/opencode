import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorProject, OperatorPromptCatalog, OperatorPromptProject } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo, formatCost, formatCount } from "../format"
import { DataTable } from "../ui/data-table"
import { useFolderBrowser } from "../ui/folder-browser"
import { NamespacePicker, useNamespaceScope } from "../ui/namespace-picker"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { requestError } from "./config-helpers"
import { useProfileNames } from "./profile-data"
import { namespaceDefault, OPENCODE } from "./profile-model"
import { RegisterProject } from "../project-gate"
import { ProjectPromptForm, useProjectSettings } from "./project-prompt"

// A project as the page lists it: a git project the server knows, or a folder outside git — a
// project once registered (it has prompt settings), else "not a project". Folders outside git that
// are not projects belong to OpenCode.
type Row = OperatorProject & { key: string; ns: string; registered: boolean }
type Params = { project?: string; block?: string; edit?: string }

function useProjectRows() {
  const language = useLanguage()
  const api = useOperatorClient()
  const names = useProfileNames()
  const scope = useNamespaceScope()
  const settings = useProjectSettings()
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
      scope.namespaces().map((item) => item.namespace.id),
    ),
    enabled: scope.namespaces().length > 0,
    queryFn: () =>
      Promise.all(
        scope.namespaces().map((item) =>
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
  const all = createMemo<Row[]>(() => {
    const registered = (settings.data ?? []).filter((item) => item.registered).map((item) => item.key)
    // A folder outside git belongs to the registered folder it is in (itself, or one above it).
    const rows = new Map<string, Row>()
    for (const project of projects.data ?? []) {
      const key = project.folder ? (registeredRoot(project.worktree, registered) ?? project.worktree) : project.worktree
      const known = !project.folder || registered.includes(key)
      const row: Row = {
        ...project,
        ...(key !== project.worktree ? { name: key.split("/").filter(Boolean).at(-1) ?? key, worktree: key } : {}),
        key,
        ns: known ? settingOf(key).namespace : OPENCODE,
        registered: known,
      }
      const same = rows.get(key)
      rows.set(
        key,
        same
          ? {
              ...same,
              sessions: same.sessions + row.sessions,
              cost: same.cost + row.cost,
              lastActivity: Math.max(same.lastActivity ?? 0, row.lastActivity ?? 0) || undefined,
            }
          : row,
      )
    }
    const listed = [...rows.values()]
    const keys = new Set(listed.map((row) => row.key))
    // Registered folders outside git where no session ran yet.
    const idle = (settings.data ?? [])
      .filter((item) => item.registered && !keys.has(item.key))
      .map((item) => ({
        id: item.key,
        name: item.name,
        worktree: item.key,
        global: false,
        folder: true,
        sessions: 0,
        cost: 0,
        created: 0,
        key: item.key,
        ns: item.namespace,
        registered: true,
      }))
    return [...listed, ...idle]
  })
  return {
    projects,
    settings,
    scope,
    settingOf,
    all,
    // The rows of the namespaces in scope.
    rows: createMemo(() => all().filter((row) => scope.all() || row.ns === scope.ns())),
    nsName: (ns: string) => scope.name(ns),
    purposeName: (row: Row) => {
      if (!row.registered) return ""
      const setting = settingOf(row.key)
      if (!setting.purpose) return language.t("operator.projects.noPurpose")
      return catalogOf(setting.namespace)?.layers.find((layer) => layer.id === setting.purpose)?.name ?? setting.purpose
    },
    profileName: (row: Row) => {
      if (!row.registered) return ""
      const setting = settingOf(row.key)
      const catalog = catalogOf(setting.namespace)
      const id = setting.defaultProfile ?? (catalog ? namespaceDefault(catalog) : undefined)
      const found = catalog?.profiles.find((profile) => profile.id === id)
      const name = found ? names.profile(found) : (id ?? "")
      return setting.defaultProfile ? name : language.t("operator.projects.namespaceDefault", { name })
    },
  }
}

// The registered folder a folder outside git is in (itself, or the nearest one above it).
function registeredRoot(folder: string, registered: ReadonlyArray<string>) {
  return registered
    .filter((key) => folder === key || folder.startsWith(key.endsWith("/") ? key : `${key}/`))
    .toSorted((a, b) => b.length - a.length)[0]
}

// A project's tags: git or no git, and "not a project" for a folder that is not one.
function ProjectTags(props: { row: Row }) {
  const language = useLanguage()
  return (
    <>
      <Show when={props.row.vcs}>{(vcs) => <Tag>{vcs()}</Tag>}</Show>
      <Show when={props.row.folder}>
        <Tag>{language.t("operator.projects.folder")}</Tag>
      </Show>
      <Show when={!props.row.registered}>
        <Tag>{language.t("operator.projects.notProject")}</Tag>
      </Show>
    </>
  )
}

// Every project of the namespaces in scope. Each project has its own agents, config and sessions;
// global and built-in agents are shared by all of them. A project opens in the overlay, with its
// details, its prompt settings (Edit) and what can be done with it.
export default function ProjectsPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const server = useServer()
  const global = useGlobal()
  const browse = useFolderBrowser()
  const data = useProjectRows()
  const locale = () => language.intl()
  const [params, setParams] = useSearchParams<Params>()
  useRecordOverlay(
    () => !!(params.project || params.block),
    () => <ProjectOverlay />,
    () => setParams({ project: undefined, block: undefined, edit: undefined }),
  )

  // Opens the folder in this browser and loads it on the server, which records it as a project.
  const add = (directory: string) => {
    const conn = server.current
    if (!conn) return
    global.ensureServerCtx(conn).projects.open(directory)
    void api
      .client()
      .project.current({ directory })
      .then(async (result) => {
        const worktree = result.data?.worktree
        const key = !worktree || worktree === "/" ? directory : worktree
        await Promise.all(
          ["project-summaries", "projects", "project-settings"].map((item) =>
            queryClient.invalidateQueries({ queryKey: api.key(item) }),
          ),
        )
        // A new project goes to OpenCode unless another namespace is chosen.
        if (data.scope.namespaces().length > 1) setParams({ project: key, block: undefined, edit: "added" })
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.projects.addFailed"), description: requestError(error) }),
      )
  }
  // Any folder in the server's workspace, including new ones created in the browser.
  const choose = async () => {
    const directory = await browse()
    if (directory) add(directory)
  }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.projects.title")}
        description={language.t("operator.page.projects.description")}
        actions={
          <span class="flex items-center gap-2">
            <NamespacePicker />
            <ButtonV2 size="small" variant="contrast" onClick={() => void choose()}>
              {language.t("operator.projects.add")}
            </ButtonV2>
          </span>
        }
      />
      <p data-slot="operator-note">{language.t("operator.projects.hint")}</p>
      <DataTable
        columnsKey="projects"
        label={language.t("operator.page.projects.title")}
        rows={data.rows()}
        loading={data.projects.isPending}
        empty={language.t("operator.projects.empty")}
        onRowClick={(row) => setParams({ project: row.key, block: undefined, edit: undefined })}
        columns={[
          {
            id: "name",
            header: language.t("operator.column.name"),
            value: (row) => row.name ?? row.worktree,
            cell: (row) => (
              <span class="flex flex-col">
                <span class="flex items-center gap-2">
                  {row.name ?? row.worktree.split("/").filter(Boolean).at(-1) ?? row.worktree}
                  <ProjectTags row={row} />
                </span>
                <span data-slot="operator-cell-clamp">{row.worktree}</span>
              </span>
            ),
          },
          {
            id: "namespace",
            optional: true,
            header: language.t("operator.column.namespace"),
            value: (row) => data.nsName(row.ns),
            cell: (row) => data.nsName(row.ns),
          },
          {
            id: "purpose",
            optional: true,
            header: language.t("operator.column.purpose"),
            cell: (row) => <span data-slot="operator-cell-clamp">{data.purposeName(row)}</span>,
          },
          {
            id: "defaultProfile",
            optional: true,
            header: language.t("operator.column.defaultProfile"),
            cell: (row) => <span data-slot="operator-cell-clamp">{data.profileName(row)}</span>,
          },
          {
            id: "sessions",
            optional: true,
            header: language.t("operator.column.sessions"),
            align: "end",
            value: (row) => row.sessions,
            cell: (row) => formatCount(row.sessions, locale()),
          },
          {
            id: "cost",
            optional: true,
            header: language.t("operator.column.cost"),
            align: "end",
            value: (row) => row.cost,
            cell: (row) => formatCost(row.cost, locale()),
          },
          {
            id: "lastActivity",
            optional: true,
            header: language.t("operator.column.lastUsed"),
            align: "end",
            value: (row) => row.lastActivity,
            cell: (row) => formatAgo(row.lastActivity, locale()),
          },
        ]}
      />
    </>
  )
}

// The overlay of Projects: the namespaces in scope on the left, a namespace's projects or one
// project on the right.
function ProjectOverlay() {
  const language = useLanguage()
  const data = useProjectRows()
  const [params, setParams] = useSearchParams<Params>()
  // Kept here, not in the project's view: a move to another namespace switches the pane (and the view
  // with it) while the edit finishes.
  const [editing, setEditing] = createSignal(params.edit === "added")
  createEffect(
    on(
      () => params.project,
      () => setEditing(params.edit === "added"),
      { defer: true },
    ),
  )
  const row = createMemo(() => data.all().find((item) => item.key === params.project))
  const block = () => row()?.ns ?? params.block ?? data.scope.scoped()[0]?.namespace.id ?? OPENCODE
  const blocks = createMemo<OverlayBlock[]>(() =>
    data.scope.scoped().map((item) => ({
      id: item.namespace.id,
      label: item.namespace.name,
      icon: "folder",
      description: item.namespace.purpose || undefined,
      empty: language.t("operator.projects.noneInNamespace"),
      records: data
        .all()
        .filter((project) => project.ns === item.namespace.id)
        .map((project) => ({
          id: project.key,
          label: project.name ?? project.worktree,
          detail: project.registered ? project.worktree : language.t("operator.projects.notProject"),
        })),
    })),
  )

  return (
    <RecordOverlay
      title={language.t("operator.page.projects.title")}
      namespaces={data.scope.namespaces()}
      blocks={blocks()}
      block={block()}
      record={params.project}
      editing={editing()}
      onBlock={(id) => setParams({ block: id, project: undefined, edit: undefined })}
      onRecord={(_, key) => setParams({ project: key, block: undefined, edit: undefined })}
    >
      <Show when={row()} fallback={<p data-slot="operator-note">{language.t("operator.projects.noSuchProject")}</p>}>
        {(found) => (
          <ProjectRecord
            row={found()}
            setting={data.settingOf(found().key)}
            purpose={data.purposeName(found())}
            profile={data.profileName(found())}
            nsName={data.nsName(found().ns)}
            added={params.edit === "added"}
            editing={editing()}
            onEditing={setEditing}
            onDone={() => {
              setEditing(false)
              setParams({ edit: undefined })
            }}
          />
        )}
      </Show>
    </RecordOverlay>
  )
}

// One project: its details, Edit for its prompt settings (Cancel or Save then), and what can be done
// with it — its agents, config and sessions, or a new session there.
function ProjectRecord(props: {
  row: Row
  setting: OperatorPromptProject
  purpose: string
  profile: string
  nsName: string
  added: boolean
  editing: boolean
  onEditing: (editing: boolean) => void
  onDone: () => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()
  const locale = () => language.intl()
  const scoped = (page: string) => navigate(`/operator/${page}?dir=${encodeURIComponent(props.row.key)}`)

  return (
    <Show
      when={!props.editing}
      fallback={<ProjectPromptForm project={props.setting} added={props.added} onDone={props.onDone} />}
    >
      <RecordView
        title={
          <>
            {props.row.name ?? props.row.worktree}
            <ProjectTags row={props.row} />
          </>
        }
        actions={
          <>
            <Show when={props.row.registered}>
              <ButtonV2 variant="contrast" onClick={() => props.onEditing(true)}>
                {language.t("operator.profile.edit")}
              </ButtonV2>
              <ButtonV2
                variant="outline"
                onClick={() => void tabs.newDraft({ server: server.key, directory: props.row.key })}
              >
                {language.t("operator.projects.newSession")}
              </ButtonV2>
              <ButtonV2 variant="neutral" onClick={() => scoped("agents")}>
                {language.t("operator.page.agents.title")}
              </ButtonV2>
              <ButtonV2 variant="neutral" onClick={() => scoped("config")}>
                {language.t("operator.page.config.title")}
              </ButtonV2>
            </Show>
            <ButtonV2 variant="neutral" onClick={() => scoped("sessions")}>
              {language.t("operator.page.sessions.title")}
            </ButtonV2>
          </>
        }
      >
        <dl data-component="record-fields">
          <RecordField
            label={language.t("operator.projects.folderLabel")}
            help={language.t("operator.help.projectFolder")}
          >
            {props.row.worktree}
          </RecordField>
          <RecordField
            label={language.t("operator.column.namespace")}
            help={language.t("operator.help.projectNamespace")}
          >
            {props.nsName}
          </RecordField>
          <Show when={props.row.registered}>
            <RecordField
              label={language.t("operator.column.purpose")}
              help={language.t("operator.projects.purposeHint")}
            >
              {props.purpose}
            </RecordField>
            <RecordField
              label={language.t("operator.column.defaultProfile")}
              help={language.t("operator.help.projectDefaultProfile")}
            >
              {props.profile}
            </RecordField>
          </Show>
          <RecordField
            label={language.t("operator.column.sessions")}
            help={language.t("operator.help.projectSessions")}
          >
            {formatCount(props.row.sessions, locale())}
          </RecordField>
          <RecordField label={language.t("operator.column.cost")} help={language.t("operator.help.projectCost")}>
            {formatCost(props.row.cost, locale())}
          </RecordField>
          <RecordField
            label={language.t("operator.column.lastUsed")}
            help={language.t("operator.help.projectLastUsed")}
          >
            {formatAgo(props.row.lastActivity, locale()) || "—"}
          </RecordField>
        </dl>
        <Show when={!props.row.registered}>
          <p data-slot="operator-note">{language.t("operator.projects.notProjectHint")}</p>
          <h3 data-slot="operator-panel-title">{language.t("operator.gate.make")}</h3>
          <RegisterProject directory={props.row.key} onDone={() => undefined} />
        </Show>
      </RecordView>
    </Show>
  )
}
