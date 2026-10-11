import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
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
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView } from "../ui/record-overlay"
import { useOverlayParams } from "../ui/overlay-nav"
import { requestError } from "./config-helpers"

// The Memory page's Memory and Settings tabs (specs/docs/feedbacks/memory/memory_spec.md §8): a project's
// three levels of short-term memory (the agent level for a chosen agent), each memory opened in the
// overlay to read, edit or delete (to Trash), MEMORY.md as text for a hand fix, and the settings for
// committing .memory folders and the prompts' index limits.

const LEVELS: OperatorMemoryLevelName[] = ["namespace", "project", "agent"]
// The overlay's record: `<level>/<file>`, `<level>/new`, or `<level>/MEMORY.md` for the index as text.
export const NEW = "new"
export const INDEX = "MEMORY.md"
const split = (record: string | undefined) => {
  const at = record?.indexOf("/") ?? -1
  if (!record || at < 0) return undefined
  return { level: record.slice(0, at) as OperatorMemoryLevelName, file: record.slice(at + 1) }
}

export function useMemoryLevels(directory: () => string | undefined, agent: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("memory-levels", directory(), agent()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.memory.levels({ directory: directory(), ...(agent() ? { agent: agent() } : {}) })
        .then((result) => result.data!),
  }))
}

function useLevelWords() {
  const language = useLanguage()
  return {
    title: (level: OperatorMemoryLevelName, levels?: OperatorMemoryLevels) =>
      level === "namespace"
        ? language.t("operator.memoryLevels.level.namespace", { name: levels?.namespace.name ?? "" })
        : level === "agent"
          ? language.t("operator.memoryLevels.level.agent", { name: levels?.agent ?? "" })
          : language.t("operator.memoryLevels.level.project"),
  }
}

// The Memory tab: the agent picker, then the three levels.
export function MemoryLevelsTab(props: {
  directory: string
  agent: string | undefined
  onAgent: (agent: string) => void
  onOpen: (record: string) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const words = useLevelWords()
  const levels = useMemoryLevels(
    () => props.directory,
    () => props.agent,
  )
  const locale = () => language.intl()

  return (
    <div class="flex flex-col gap-4" data-testid="memory-levels">
      <Show when={levels.data && !levels.data.instructions}>
        <p data-slot="operator-note">{language.t("operator.memoryLevels.instructionsElsewhere")}</p>
      </Show>
      <MemoryAgentPicker
        directory={props.directory}
        agent={levels.data?.agent ?? props.agent}
        onAgent={props.onAgent}
      />
      <For each={levels.data?.levels ?? []}>
        {(level) => (
          <section data-component="operator-panel" data-testid={`memory-level-${level.level}`}>
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <h2 data-slot="operator-panel-title">{words.title(level.level, levels.data)}</h2>
              <span class="flex gap-2">
                <ButtonV2 size="small" variant="outline" onClick={() => props.onOpen(`${level.level}/${INDEX}`)}>
                  {language.t("operator.memoryLevels.editIndex")}
                </ButtonV2>
                <ButtonV2 size="small" variant="contrast" onClick={() => props.onOpen(`${level.level}/${NEW}`)}>
                  {language.t("operator.memoryLevels.new")}
                </ButtonV2>
              </span>
            </div>
            <p data-slot="operator-note" data-testid="memory-level-size">
              <span title={level.folder}>{shortPath(level.folder)}</span> ·{" "}
              {language.t("operator.memoryLevels.size", {
                lines: formatCount(level.lines, locale()),
                maxLines: formatCount(levels.data?.limits.lines ?? 0, locale()),
                chars: formatCount(level.chars, locale()),
                maxChars: formatCount(levels.data?.limits.chars ?? 0, locale()),
              })}
            </p>
            <DataTable
              columnsKey="memory-entries"
              label={words.title(level.level, levels.data)}
              rows={level.entries}
              loading={levels.isPending}
              empty={language.t("operator.memoryLevels.empty")}
              onRowClick={(row) => props.onOpen(`${level.level}/${row.file}`)}
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
            <Show when={level.invalid.length}>
              <ul data-slot="operator-memory-flags" data-testid="memory-level-invalid">
                <For each={level.invalid}>
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
            <Show when={level.unindexed.length}>
              <ul data-slot="operator-memory-flags" data-testid="memory-level-unindexed">
                <For each={level.unindexed}>
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
      </For>
    </div>
  )
}

// A memory in the overlay: read-only, then Edit (title, description, text) or Delete (to Trash); a new
// memory opens in edit mode; MEMORY.md as text for a hand fix.
export function MemoryEntryOverlay(props: { directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const words = useLevelWords()
  const [params, setParams] = useOverlayParams<{ memory?: string; magent?: string }>()
  const agent = () => params.magent
  const levels = useMemoryLevels(() => props.directory, agent)
  const record = createMemo(() => split(params.memory))
  const level = createMemo(() => levels.data?.levels.find((item) => item.level === record()?.level))
  const creating = () => record()?.file === NEW
  const indexing = () => record()?.file === INDEX
  const entry = useQuery(() => ({
    queryKey: api.key("memory-entry", props.directory, agent(), params.memory),
    enabled: !!record() && !creating() && !indexing(),
    queryFn: () =>
      api
        .client()
        .operator.memory.entry({
          directory: props.directory,
          level: record()!.level,
          file: record()!.file,
          ...(agent() ? { agent: agent() } : {}),
        })
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
    await queryClient.invalidateQueries({ queryKey: api.key("memory-levels", props.directory) })
    await queryClient.invalidateQueries({ queryKey: api.key("memory-entry", props.directory) })
  }
  const fail = (error: unknown) => setStore("error", requestError(error))

  const save = async () => {
    const found = record()
    if (!found) return
    setStore({ busy: true, error: "" })
    const request = indexing()
      ? api.client().operator.memory.writeIndex({
          directory: props.directory,
          level: found.level,
          text: store.index,
          ...(agent() ? { agent: agent() } : {}),
        })
      : api.client().operator.memory.saveEntry({
          directory: props.directory,
          level: found.level,
          title: store.title,
          description: store.description,
          content: store.content,
          ...(creating() ? {} : { file: found.file }),
          ...(agent() ? { agent: agent() } : {}),
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
      .operator.memory.forgetEntry({
        directory: props.directory,
        level: found.level,
        file: found.file,
        ...(agent() ? { agent: agent() } : {}),
      })
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
      const found = levels.data?.levels.find((item) => item.level === name)
      return {
        id: name,
        label: words.title(name, levels.data),
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
      ? language.t("operator.memoryLevels.indexTitle", { level: words.title(record()!.level, levels.data) })
      : creating()
        ? language.t("operator.memoryLevels.newTitle", { level: words.title(record()!.level, levels.data) })
        : language.t("operator.profile.editing", { name: entry.data?.title ?? "" })

  return (
    <RecordOverlay
      title={language.t("operator.page.memory.title")}
      namespaces={[]}
      blocks={blocks()}
      block={record()?.level ?? "project"}
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

// The Settings tab: committing .memory folders (the default and each project's own choice, with its
// repository's state), and how much of each level's index prompts show.
export function MemorySettingsTab() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const settings = useQuery(() => ({
    queryKey: api.key("memory-settings"),
    queryFn: () =>
      api
        .client()
        .operator.memory.settings()
        .then((result) => result.data!),
  }))
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
      .operator.memory.saveSettings(body)
      .then((result) => queryClient.setQueryData(api.key("memory-settings"), result.data))
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  return (
    <div class="flex flex-col gap-4" data-testid="memory-settings">
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
      <section data-component="operator-panel">
        <h2 data-slot="operator-panel-title">{language.t("operator.memorySettings.projects")}</h2>
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
              cell: (row) => <ProjectMemoryCommit project={row.key} name={row.name} />,
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
    </div>
  )
}

// A project's own choice for committing its .memory folders (its record, and Memory → Settings).
export function ProjectMemoryCommit(props: { project: string; name: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const settings = useQuery(() => ({
    queryKey: api.key("memory-settings"),
    queryFn: () =>
      api
        .client()
        .operator.memory.settings()
        .then((result) => result.data!),
  }))
  const current = () => {
    const found = settings.data?.projects.find((item) => item.key === props.project)
    return found?.override === undefined ? "default" : found.override ? "on" : "off"
  }
  const choose = (choice: "default" | "on" | "off") =>
    api
      .client()
      .operator.memory.saveSettings({
        // null: back to the default (the generated client types drop it)
        project: { key: props.project, commit: (choice === "default" ? null : choice === "on") as boolean },
      })
      .then((result) => queryClient.setQueryData(api.key("memory-settings"), result.data))
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

// The agent whose memory and files the page shows (its home is its working folder).
export function MemoryAgentPicker(props: {
  directory: string
  agent: string | undefined
  onAgent: (agent: string) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const agents = useQuery(() => ({
    queryKey: api.key("agents", props.directory),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: props.directory })
        .then((result) => result.data ?? []),
  }))
  return (
    <div class="flex items-end gap-2 flex-wrap">
      <Field group label={language.t("operator.memoryLevels.agent")} hint={language.t("operator.help.memoryAgent")}>
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.memoryLevels.agent")}
          options={(agents.data ?? []).map((item) => item.name)}
          current={props.agent ?? "build"}
          onSelect={(name) => name && props.onAgent(name)}
        />
      </Field>
    </div>
  )
}
