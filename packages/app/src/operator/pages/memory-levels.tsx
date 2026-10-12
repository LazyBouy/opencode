import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "../ui/select"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorMemoryLevel, OperatorMemoryLevelName, OperatorMemoryLevels } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatAgo, formatCount, shortPath } from "../format"
import { useOperatorProjects } from "../project"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView } from "../ui/record-overlay"
import { useOverlayParams } from "../ui/overlay-nav"
import { requestError } from "./config-helpers"
import { OPENCODE } from "./profile-model"

// The Memory page's Memory and Settings tabs (specs/docs/feedbacks/memory/memory_spec.md §8), scoped as the
// user set on 2026-10-11: the page's namespace scopes the namespace's memory; a project picked just above
// its section scopes the project's memory; an agent of that project picked just above its section scopes
// the agent's memory. Each section has its own "Edit MEMORY.md" and "New memory"; a memory opens in the
// overlay to read, edit or delete (to Trash). Settings are the namespace's (OpenCode's unless it has its
// own), with its projects' choices.

const LEVELS: OperatorMemoryLevelName[] = ["namespace", "project", "agent"]
// The overlay's record: `<level>/<file>`, `<level>/new`, or `<level>/MEMORY.md` for the index as text.
export const NEW = "new"
export const INDEX = "MEMORY.md"
const split = (record: string | undefined) => {
  const at = record?.indexOf("/") ?? -1
  if (!record || at < 0) return undefined
  return { level: record.slice(0, at) as OperatorMemoryLevelName, file: record.slice(at + 1) }
}

/** A namespace's own level (`namespace`), or a project's three levels (the agent's for `agent`). */
export function useMemoryLevels(input: {
  namespace?: () => string | undefined
  project?: () => string | undefined
  agent?: () => string | undefined
}) {
  const api = useOperatorClient()
  return useQuery(() => {
    const namespace = input.namespace?.()
    const project = input.project?.()
    const agent = input.agent?.()
    return {
      queryKey: api.key("memory-levels", namespace ? `ns:${namespace}` : project, agent),
      enabled: !!(namespace || project),
      queryFn: () =>
        api
          .client()
          .operator.memory.levels({
            ...(namespace ? { namespace } : { directory: project }),
            ...(agent ? { agent } : {}),
          })
          .then((result) => result.data!),
    }
  })
}

function useLevelTitle() {
  const language = useLanguage()
  return (level: OperatorMemoryLevelName, levels?: OperatorMemoryLevels) =>
    level === "namespace"
      ? language.t("operator.memoryLevels.level.namespace", { name: levels?.namespace.name ?? "" })
      : level === "agent"
        ? language.t("operator.memoryLevels.level.agent", { name: levels?.agent ?? "" })
        : language.t("operator.memoryLevels.level.project")
}

// One level: its folder and size against the limits, its own actions, its memories, and what is flagged.
function LevelSection(props: {
  level: OperatorMemoryLevel | undefined
  title: string
  limits: { lines: number; chars: number } | undefined
  loading: boolean
  onOpen: (record: string) => void
}) {
  const language = useLanguage()
  const locale = () => language.intl()
  return (
    <Show when={props.level}>
      {(level) => (
        <section data-component="operator-panel" data-testid={`memory-level-${level().level}`}>
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <h2 data-slot="operator-panel-title">{props.title}</h2>
            <span class="flex gap-2">
              <ButtonV2 size="small" variant="outline" onClick={() => props.onOpen(`${level().level}/${INDEX}`)}>
                {language.t("operator.memoryLevels.editIndex")}
              </ButtonV2>
              <ButtonV2 size="small" variant="contrast" onClick={() => props.onOpen(`${level().level}/${NEW}`)}>
                {language.t("operator.memoryLevels.new")}
              </ButtonV2>
            </span>
          </div>
          <p data-slot="operator-note" data-testid="memory-level-size">
            <span title={level().folder}>{shortPath(level().folder)}</span> ·{" "}
            {language.t("operator.memoryLevels.size", {
              lines: formatCount(level().lines, locale()),
              maxLines: formatCount(props.limits?.lines ?? 0, locale()),
              chars: formatCount(level().chars, locale()),
              maxChars: formatCount(props.limits?.chars ?? 0, locale()),
            })}
          </p>
          <DataTable
            columnsKey="memory-entries"
            label={props.title}
            rows={level().entries}
            loading={props.loading}
            empty={language.t("operator.memoryLevels.empty")}
            onRowClick={(row) => props.onOpen(`${level().level}/${row.file}`)}
            columns={[
              {
                id: "title",
                header: language.t("operator.memoryLevels.title"),
                value: (row) => row.title,
                cell: (row) => row.title,
              },
              {
                id: "description",
                optional: true,
                header: language.t("operator.memoryLevels.description"),
                value: (row) => row.description,
                cell: (row) => <span data-slot="operator-cell-clamp">{row.description}</span>,
              },
              {
                id: "file",
                optional: true,
                header: language.t("operator.memoryLevels.file"),
                value: (row) => row.file,
                cell: (row) => <code>{row.file}</code>,
              },
              {
                id: "updated",
                optional: true,
                header: language.t("operator.column.modified"),
                align: "end",
                value: (row) => (row.updated ? Date.parse(row.updated) : 0),
                cell: (row) => (row.updated ? formatAgo(Date.parse(row.updated), locale()) : "—"),
              },
              {
                id: "by",
                optional: true,
                header: language.t("operator.memoryLevels.by"),
                value: (row) => row.by ?? "",
                cell: (row) => row.by ?? "—",
              },
            ]}
          />
          <Show when={level().invalid.length}>
            <ul data-slot="operator-memory-flags" data-testid="memory-level-invalid">
              <For each={level().invalid}>
                {(line) => (
                  <li>
                    <Tag>{language.t("operator.memoryLevels.notEntry")}</Tag>{" "}
                    <span data-slot="operator-note">
                      {language.t("operator.memoryLevels.line", { line: line.line })}
                    </span>{" "}
                    <code>{line.text}</code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={level().unindexed.length}>
            <ul data-slot="operator-memory-flags" data-testid="memory-level-unindexed">
              <For each={level().unindexed}>
                {(file) => (
                  <li>
                    <Tag>{language.t("operator.memoryLevels.notIndexed")}</Tag> <code>{file}</code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      )}
    </Show>
  )
}

// The Memory tab: the namespace's memory; a project of the namespace, then its memory; an agent of that
// project, then its memory (with the instruction files its sessions load, where they apply).
export function MemoryLevelsTab(props: {
  namespace: string
  instructions: boolean
  projects: ReadonlyArray<string>
  project: string | undefined
  agent: string | undefined
  onProject: (project: string) => void
  onAgent: (agent: string) => void
  onOpen: (record: string) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const title = useLevelTitle()
  const projectOptions = useOperatorProjects()
  const own = useMemoryLevels({ namespace: () => props.namespace })
  const project = useMemoryLevels({ project: () => props.project, agent: () => props.agent })
  const projectName = (key: string) => projectOptions().find((item) => item.directory === key)?.label ?? shortPath(key)
  const instructions = useQuery(() => ({
    queryKey: api.key("memory", props.project, project.data?.agent),
    enabled: props.instructions && !!props.project && !!project.data?.agent,
    queryFn: () =>
      api
        .client()
        .operator.memory.overview({ directory: props.project, agent: project.data!.agent })
        .then((result) => result.data!),
  }))
  const always = () =>
    (instructions.data?.files ?? []).filter((file) => file.kind === "instructions" && file.scope === "project")

  return (
    <div class="flex flex-col gap-4" data-testid="memory-levels">
      <LevelSection
        level={own.data?.levels[0]}
        title={title("namespace", own.data)}
        limits={own.data?.limits}
        loading={own.isPending}
        onOpen={props.onOpen}
      />
      <Show
        when={props.projects.length}
        fallback={<p data-slot="operator-note">{language.t("operator.memoryLevels.noProjects")}</p>}
      >
        <Field
          group
          label={language.t("operator.memoryLevels.project")}
          hint={language.t("operator.help.memoryProject")}
        >
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.memoryLevels.project")}
            options={[...props.projects]}
            current={props.project}
            label={projectName}
            onSelect={(key) => key && props.onProject(key)}
          />
        </Field>
        <LevelSection
          level={project.data?.levels.find((item) => item.level === "project")}
          title={title("project", project.data)}
          limits={project.data?.limits}
          loading={project.isPending}
          onOpen={props.onOpen}
        />
        <MemoryAgentPicker
          directory={props.project!}
          agent={project.data?.agent ?? props.agent}
          onAgent={props.onAgent}
        />
        <LevelSection
          level={project.data?.levels.find((item) => item.level === "agent")}
          title={title("agent", project.data)}
          limits={project.data?.limits}
          loading={project.isPending}
          onOpen={props.onOpen}
        />
        <Show when={always().length}>
          <p data-slot="operator-note" data-testid="memory-agent-instructions">
            {language.t("operator.memoryLevels.agentInstructions", {
              name: project.data?.agent ?? "",
              files: always()
                .map((file) => shortPath(file.path))
                .join(", "),
            })}
          </p>
        </Show>
      </Show>
    </div>
  )
}

// A memory in the overlay: read-only, then Edit (title, description, text) or Delete (to Trash); a new
// memory opens in edit mode; MEMORY.md as text for a hand fix. The namespace's level is reached by the
// namespace; the project's and the agent's by the project (and the agent).
export function MemoryEntryOverlay(props: {
  namespace: string
  project: string | undefined
  agent: string | undefined
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const title = useLevelTitle()
  const [params, setParams] = useOverlayParams<{ memory?: string }>()
  const own = useMemoryLevels({ namespace: () => props.namespace })
  const projectLevels = useMemoryLevels({ project: () => props.project, agent: () => props.agent })
  const record = createMemo(() => split(params.memory))
  const dataOf = (level: OperatorMemoryLevelName) => (level === "namespace" ? own.data : projectLevels.data)
  const level = createMemo(() => {
    const found = record()
    return found ? dataOf(found.level)?.levels.find((item) => item.level === found.level) : undefined
  })
  // Where a level's requests go: the namespace by name, or the project (and its agent: the one picked,
  // else the one the server showed).
  const agent = () => props.agent ?? projectLevels.data?.agent
  const target = (name: OperatorMemoryLevelName) =>
    name === "namespace"
      ? { namespace: props.namespace }
      : { directory: props.project, ...(agent() ? { agent: agent()! } : {}) }
  const creating = () => record()?.file === NEW
  const indexing = () => record()?.file === INDEX
  const entry = useQuery(() => ({
    queryKey: api.key("memory-entry", props.namespace, props.project, props.agent, params.memory),
    enabled: !!record() && !creating() && !indexing(),
    queryFn: () =>
      api
        .client()
        .operator.memory.entry({ ...target(record()!.level), level: record()!.level, file: record()!.file })
        .then((result) => result.data!),
  }))
  const [store, setStore] = createStore({
    title: "",
    description: "",
    content: "",
    index: "",
    editing: false,
    busy: false,
    error: "",
  })
  const indexText = (found: OperatorMemoryLevel | undefined) =>
    [
      ...(found?.entries ?? []).map((item) => ({
        line: item.line,
        text: `- [${item.title}](${item.file}) — ${item.description}`,
      })),
      ...(found?.invalid ?? []),
    ]
      .toSorted((a, b) => a.line - b.line)
      .map((item) => item.text)
      .join("\n")
  const reset = () =>
    setStore({
      title: entry.data?.title ?? "",
      description: entry.data?.description ?? "",
      content: entry.data?.content ?? "",
      index: indexText(level()),
      editing: creating() || indexing(),
      error: "",
    })
  createEffect(on([() => params.memory, () => entry.data, () => level()], reset))
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: api.key("memory-levels") })
    await queryClient.invalidateQueries({ queryKey: api.key("memory-entry") })
  }
  const fail = (error: unknown) => setStore("error", requestError(error))

  const save = async () => {
    const found = record()
    if (!found) return
    setStore({ busy: true, error: "" })
    const request = indexing()
      ? api.client().operator.memory.writeIndex({ ...target(found.level), level: found.level, text: store.index })
      : api.client().operator.memory.saveEntry({
          ...target(found.level),
          level: found.level,
          title: store.title,
          description: store.description,
          content: store.content,
          ...(creating() ? {} : { file: found.file }),
        })
    await request
      .then(async (result) => {
        await refresh()
        const file = indexing() ? INDEX : (result.data as { file?: string } | undefined)?.file
        if (indexing()) setParams({ memory: undefined })
        else if (file) setParams({ memory: `${found.level}/${file}` })
        setStore("editing", false)
      })
      .catch(fail)
      .finally(() => setStore("busy", false))
  }
  const remove = async () => {
    const found = record()
    if (!found || !entry.data) return
    const ok = await confirm({
      title: language.t("operator.memoryLevels.deleteTitle", { name: entry.data.title }),
      description: language.t("operator.memoryLevels.deleteBody"),
      confirm: language.t("operator.trash.moveConfirm"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.memory.forgetEntry({ ...target(found.level), level: found.level, file: found.file })
      .then(async () => {
        await refresh()
        setParams({ memory: undefined })
      })
      .catch(fail)
  }
  const cancel = () => {
    if (creating() || indexing()) return setParams({ memory: undefined })
    reset()
  }

  const blocks = createMemo<OverlayBlock[]>(() =>
    LEVELS.map((name) => {
      const found = dataOf(name)?.levels.find((item) => item.level === name)
      return {
        id: name,
        label: title(name, dataOf(name)),
        icon: name === "namespace" ? "archive" : name === "project" ? "folder" : "brain",
        empty: language.t("operator.memoryLevels.empty"),
        records: (found?.entries ?? []).map((item) => ({
          id: `${name}/${item.file}`,
          label: item.title,
          detail: item.file,
        })),
      }
    }),
  )
  const formTitle = () =>
    indexing()
      ? language.t("operator.memoryLevels.indexTitle", { level: title(record()!.level, dataOf(record()!.level)) })
      : creating()
        ? language.t("operator.memoryLevels.newTitle", { level: title(record()!.level, dataOf(record()!.level)) })
        : language.t("operator.profile.editing", { name: entry.data?.title ?? "" })

  return (
    <RecordOverlay
      title={language.t("operator.page.memory.title")}
      namespaces={[]}
      blocks={blocks()}
      block={record()?.level ?? "namespace"}
      record={params.memory}
      editing={store.editing}
      onBlock={() => setParams({ memory: undefined })}
      onRecord={(_, id) => setParams({ memory: id })}
    >
      <Show when={record()}>
        <Show
          when={store.editing}
          fallback={
            <Show when={entry.data}>
              {(found) => (
                <RecordView
                  title={found().title}
                  actions={
                    <>
                      <ButtonV2 variant="contrast" onClick={() => setStore("editing", true)}>
                        {language.t("operator.profile.edit")}
                      </ButtonV2>
                      <ButtonV2 variant="danger" onClick={() => void remove()}>
                        {language.t("operator.trash.delete")}
                      </ButtonV2>
                    </>
                  }
                >
                  <dl data-component="record-fields" data-testid="memory-entry">
                    <RecordField
                      label={language.t("operator.memoryLevels.description")}
                      help={language.t("operator.help.memoryDescription")}
                    >
                      {found().description}
                    </RecordField>
                    <RecordField
                      label={language.t("operator.memoryLevels.file")}
                      help={language.t("operator.help.memoryFile")}
                    >
                      <code title={found().path}>{shortPath(found().path)}</code>
                    </RecordField>
                    <RecordField
                      label={language.t("operator.memoryLevels.written")}
                      help={language.t("operator.help.memoryWritten")}
                    >
                      {[
                        found().updated ? formatAgo(Date.parse(found().updated!), language.intl()) : "—",
                        found().by ?? "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </RecordField>
                    <RecordField
                      label={language.t("operator.memoryLevels.text")}
                      help={language.t("operator.help.memoryText")}
                    >
                      <pre data-component="operator-code">{found().content || "—"}</pre>
                    </RecordField>
                  </dl>
                  <Show when={store.error}>
                    <p data-slot="operator-error" role="alert">
                      {store.error}
                    </p>
                  </Show>
                </RecordView>
              )}
            </Show>
          }
        >
          <RecordView
            title={formTitle()}
            actions={
              <>
                <ButtonV2 variant="neutral" onClick={cancel}>
                  {language.t("common.cancel")}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  disabled={store.busy || (!indexing() && (!store.title.trim() || !store.description.trim()))}
                  onClick={() => void save()}
                >
                  {language.t("operator.config.save")}
                </ButtonV2>
              </>
            }
          >
            <div data-component="operator-form" data-testid="memory-form">
              <Show
                when={!indexing()}
                fallback={
                  <Field
                    label={language.t("operator.memoryLevels.indexText")}
                    hint={language.t("operator.help.memoryIndex")}
                  >
                    <TextareaV2
                      class="operator-editor"
                      rows={16}
                      value={store.index}
                      onInput={(event) => setStore("index", event.currentTarget.value)}
                    />
                  </Field>
                }
              >
                <Field
                  label={language.t("operator.memoryLevels.title")}
                  hint={language.t("operator.help.memoryTitle")}
                  note={language.t("operator.profile.chars", { count: store.title.length })}
                >
                  <TextInputV2
                    appearance="base"
                    value={store.title}
                    onInput={(event) => setStore("title", event.currentTarget.value)}
                  />
                </Field>
                <Field
                  label={language.t("operator.memoryLevels.description")}
                  hint={language.t("operator.help.memoryDescription")}
                  note={language.t("operator.profile.chars", { count: store.description.length })}
                >
                  <TextInputV2
                    appearance="base"
                    value={store.description}
                    onInput={(event) => setStore("description", event.currentTarget.value)}
                  />
                </Field>
                <Field label={language.t("operator.memoryLevels.text")} hint={language.t("operator.help.memoryText")}>
                  <TextareaV2
                    class="operator-editor"
                    rows={12}
                    value={store.content}
                    onInput={(event) => setStore("content", event.currentTarget.value)}
                  />
                </Field>
              </Show>
              <Show when={store.error}>
                <p data-slot="operator-error" role="alert">
                  {store.error}
                </p>
              </Show>
            </div>
          </RecordView>
        </Show>
      </Show>
    </RecordOverlay>
  )
}

function useMemorySettings(namespace: () => string) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("memory-settings", namespace()),
    queryFn: () =>
      api
        .client()
        .operator.memory.settings({ namespace: namespace() })
        .then((result) => result.data!),
  }))
}

// The Settings tab's memory part: the namespace's commit choice and index limits (OpenCode's unless it
// has its own), and its projects' choices with their repositories' state.
export function MemorySettingsTab(props: { namespace: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const settings = useMemorySettings(() => props.namespace)
  const [store, setStore] = createStore({ lines: "", chars: "", busy: false, error: "" })
  createEffect(
    on(
      () => settings.data,
      (data) => data && setStore({ lines: String(data.indexLines), chars: String(data.indexChars) }),
    ),
  )
  const save = async (body: Parameters<ReturnType<typeof api.client>["operator"]["memory"]["saveSettings"]>[0]) => {
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.memory.saveSettings({ ...body, namespace: props.namespace })
      .then(async (result) => {
        queryClient.setQueryData(api.key("memory-settings", props.namespace), result.data)
        // Other namespaces may follow OpenCode's.
        await queryClient.invalidateQueries({ queryKey: api.key("memory-settings") })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  return (
    <section data-component="operator-panel" data-testid="memory-settings">
      <h2 data-slot="operator-panel-title">{language.t("operator.memorySettings.title")}</h2>
      <Show when={props.namespace !== OPENCODE}>
        <p data-slot="operator-note" data-testid="memory-settings-scope">
          {language.t(settings.data?.own ? "operator.memorySettings.own" : "operator.memorySettings.follows")}{" "}
          <Show when={settings.data?.own}>
            <ButtonV2 size="small" variant="outline" disabled={store.busy} onClick={() => void save({ follow: true })}>
              {language.t("operator.memorySettings.useOpenCode")}
            </ButtonV2>
          </Show>
        </p>
      </Show>
      <div data-component="operator-form">
        <Field
          group
          label={language.t("operator.memorySettings.commit")}
          hint={language.t("operator.help.memoryCommit")}
        >
          <Switch
            checked={settings.data?.commit ?? false}
            disabled={store.busy}
            onChange={(commit: boolean) => void save({ commit })}
          >
            {language.t("operator.memorySettings.commitHint")}
          </Switch>
        </Field>
        <div data-slot="operator-form-row">
          <Field label={language.t("operator.memorySettings.lines")} hint={language.t("operator.help.memoryLimits")}>
            <TextInputV2
              appearance="base"
              value={store.lines}
              onInput={(event) => setStore("lines", event.currentTarget.value)}
            />
          </Field>
          <Field label={language.t("operator.memorySettings.chars")} hint={language.t("operator.help.memoryLimits")}>
            <TextInputV2
              appearance="base"
              value={store.chars}
              onInput={(event) => setStore("chars", event.currentTarget.value)}
            />
          </Field>
        </div>
        <span>
          <ButtonV2
            variant="contrast"
            disabled={
              store.busy ||
              (store.lines === String(settings.data?.indexLines) && store.chars === String(settings.data?.indexChars))
            }
            onClick={() => void save({ indexLines: Number(store.lines), indexChars: Number(store.chars) })}
          >
            {language.t("operator.config.save")}
          </ButtonV2>
        </span>
        <Show when={store.error}>
          <p data-slot="operator-error" role="alert">
            {store.error}
          </p>
        </Show>
      </div>
      <h3 data-slot="operator-panel-title">{language.t("operator.memorySettings.projects")}</h3>
      <p data-slot="operator-note">{language.t("operator.memorySettings.projectsHint")}</p>
      <DataTable
        columnsKey="memory-projects"
        label={language.t("operator.memorySettings.projects")}
        rows={settings.data?.projects ?? []}
        loading={settings.isPending}
        empty={language.t("operator.memorySettings.noProjects")}
        columns={[
          {
            id: "name",
            header: language.t("operator.column.name"),
            value: (row) => row.name,
            cell: (row) => (
              <button
                type="button"
                data-slot="operator-link"
                title={row.key}
                onClick={() => navigate(`/operator/projects?project=${encodeURIComponent(row.key)}`)}
              >
                {row.name}
              </button>
            ),
          },
          {
            id: "choice",
            header: language.t("operator.memorySettings.choice"),
            value: (row) => (row.override === undefined ? "default" : row.override ? "on" : "off"),
            cell: (row) => <ProjectMemoryCommit project={row.key} name={row.name} namespace={props.namespace} />,
          },
          {
            id: "repo",
            optional: true,
            header: language.t("operator.memorySettings.repo"),
            value: (row) => row.repo ?? "",
            cell: (row) =>
              row.repo
                ? language.t(row.excluded ? "operator.memorySettings.excluded" : "operator.memorySettings.included", {
                    repo: shortPath(row.repo),
                  })
                : language.t("operator.memorySettings.noRepo"),
          },
        ]}
      />
    </section>
  )
}

// A project's own choice for committing its .memory folders (its record, and Memory → Settings).
export function ProjectMemoryCommit(props: { project: string; name: string; namespace: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const settings = useMemorySettings(() => props.namespace)
  const current = () => {
    const found = settings.data?.projects.find((item) => item.key === props.project)
    return found?.override === undefined ? "default" : found.override ? "on" : "off"
  }
  const choose = (choice: "default" | "on" | "off") =>
    api
      .client()
      .operator.memory.saveSettings({
        namespace: props.namespace,
        // null: back to the namespace's (the generated client types drop it)
        project: { key: props.project, commit: (choice === "default" ? null : choice === "on") as boolean },
      })
      .then((result) => queryClient.setQueryData(api.key("memory-settings", props.namespace), result.data))
  return (
    <SelectV2<"default" | "on" | "off">
      appearance="base"
      aria-label={language.t("operator.memorySettings.choiceOf", { name: props.name })}
      options={["default", "on", "off"]}
      current={current()}
      label={(choice) => language.t(`operator.memorySettings.choice.${choice}` as "operator.memorySettings.choice.on")}
      onSelect={(choice) => choice && void choose(choice)}
    />
  )
}

// The agent of the project whose memory the agent section shows (its home is its working folder).
export function MemoryAgentPicker(props: {
  directory: string
  agent: string | undefined
  onAgent: (agent: string) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const agents = useQuery(() => ({
    queryKey: api.key("agents", props.directory),
    enabled: !!props.directory,
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: props.directory })
        .then((result) => result.data ?? []),
  }))
  return (
    <Field group label={language.t("operator.memoryLevels.agent")} hint={language.t("operator.help.memoryAgent")}>
      <SelectV2<string>
        appearance="base"
        aria-label={language.t("operator.memoryLevels.agent")}
        options={(agents.data ?? []).map((item) => item.name)}
        current={props.agent ?? "build"}
        onSelect={(name) => name && props.onAgent(name)}
      />
    </Field>
  )
}
