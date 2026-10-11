import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorMemoryFile, OperatorMemoryOverview } from "@opencode-ai/sdk/v2/client"
import { useQueries, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatBytes, formatCount, shortPath } from "../format"
import { useOperatorProjects } from "../project"
import { DataTable } from "../ui/data-table"
import { type OverlayBlock, RecordOverlay, RecordView } from "../ui/record-overlay"
import { useOverlayParams } from "../ui/overlay-nav"
import { StatTile } from "../ui/stat-tile"
import { requestError } from "./config-helpers"
import { useTrashItem } from "./trash"

// The Memory page's namespace-wide tabs (memory_spec.md §8; the user's scoping of 2026-10-11): Files lists
// every file OpenCode adds to prompts for the namespace's projects in one table (instruction files only
// where they apply: OpenCode's and Global's projects), Summaries their compaction summaries; the database
// itself (one for the server) is shown in Settings.

const INSTRUCTION_KINDS = ["instructions", "nested", "url"]

export type FileRow = OperatorMemoryFile & { project: string }
export type SummaryRow = OperatorMemoryOverview["summaries"][number] & { project: string }

/** Each project's overview, merged: files once each (with the first project that lists them), summaries. */
export function useNamespaceMemory(input: {
  namespace: () => string
  projects: () => ReadonlyArray<string>
  instructions: () => boolean
}) {
  const api = useOperatorClient()
  const queries = useQueries(() => ({
    queries: input.projects().map((project) => ({
      queryKey: api.key("memory", project),
      queryFn: () =>
        api
          .client()
          .operator.memory.overview({ directory: project })
          .then((result) => result.data!),
    })),
  }))
  const loaded = createMemo(() =>
    input.projects().flatMap((project, at) => (queries[at]?.data ? [{ project, data: queries[at]!.data! }] : [])),
  )
  // Prompt profile files: the namespace's own.
  const own = (file: OperatorMemoryFile) =>
    file.kind !== "profile" || file.path.includes(`/namespaces/${input.namespace()}/`)
  const files = createMemo<FileRow[]>(() => {
    const seen = new Set<string>()
    return loaded().flatMap(({ project, data }) =>
      data.files.flatMap((file) => {
        if (seen.has(file.path) || !own(file)) return []
        if (!input.instructions() && INSTRUCTION_KINDS.includes(file.kind)) return []
        seen.add(file.path)
        return [{ ...file, project }]
      }),
    )
  })
  const summaries = createMemo<SummaryRow[]>(() =>
    loaded()
      .flatMap(({ project, data }) => data.summaries.map((summary) => ({ ...summary, project })))
      .toSorted((a, b) => b.time - a.time),
  )
  const creatable = createMemo(() =>
    input.instructions()
      ? loaded().flatMap(({ project, data }) => data.creatable.map((item) => ({ ...item, project })))
      : [],
  )
  return {
    files,
    summaries,
    creatable,
    database: () => loaded()[0]?.data.database,
    pending: () => queries.some((query) => query.isPending),
  }
}

function useProjectName() {
  const projects = useOperatorProjects()
  return (key: string) => projects().find((item) => item.directory === key)?.label ?? shortPath(key)
}

export function FilesTab(props: {
  memory: ReturnType<typeof useNamespaceMemory>
  onOpen: (path: string, project: string) => void
}) {
  const language = useLanguage()
  const projectName = useProjectName()
  const locale = () => language.intl()
  return (
    <>
      <p data-slot="operator-note">{language.t("operator.memory.filesHint")}</p>
      <Show when={props.memory.creatable().length}>
        <div class="flex flex-wrap gap-2">
          <For each={props.memory.creatable()}>
            {(item) => (
              <ButtonV2 size="small" variant="outline" onClick={() => props.onOpen(item.path, item.project)}>
                {language.t(`operator.memory.create.${item.scope as "project" | "global" | "environment"}`)}
                <Show when={item.scope === "project"}> · {projectName(item.project)}</Show>
              </ButtonV2>
            )}
          </For>
        </div>
      </Show>
      <DataTable
        columnsKey="memory-files"
        label={language.t("operator.memory.filesLabel")}
        rows={props.memory.files()}
        loading={props.memory.pending()}
        empty={language.t("operator.memory.noFiles")}
        onRowClick={(row) => props.onOpen(row.path, row.project)}
        columns={[
          {
            id: "kind",
            optional: true,
            header: language.t("operator.column.kind"),
            value: (row) => row.kind,
            cell: (row) => (
              <span class="whitespace-nowrap">
                <Tag variant={row.loaded === "always" ? "accent" : "neutral"}>
                  {language.t(`operator.memory.kind.${row.kind}`)}
                </Tag>
              </span>
            ),
          },
          {
            id: "path",
            header: language.t("operator.column.location"),
            value: (row) => row.path,
            cell: (row) => (
              <span data-slot="operator-cell-clamp" title={row.path}>
                {row.kind === "url" ? row.path : shortPath(row.path)}
              </span>
            ),
          },
          {
            id: "project",
            optional: true,
            header: language.t("operator.column.project"),
            value: (row) => (row.scope === "project" ? projectName(row.project) : ""),
            cell: (row) => (row.scope === "project" ? projectName(row.project) : "—"),
          },
          {
            id: "scope",
            optional: true,
            header: language.t("operator.scope.label"),
            value: (row) => row.scope,
            cell: (row) =>
              row.scope === "namespace"
                ? language.t("operator.scope.namespaceShort")
                : language.t(`operator.scope.${row.scope}`),
          },
          {
            id: "loaded",
            optional: true,
            header: language.t("operator.memory.loadedLabel"),
            value: (row) => row.loaded,
            cell: (row) => language.t(`operator.memory.loaded.${row.loaded}`),
          },
          {
            id: "size",
            optional: true,
            header: language.t("operator.column.size"),
            align: "end",
            value: (row) => row.size,
            cell: (row) => (row.size === undefined ? "" : formatBytes(row.size, locale())),
          },
          {
            id: "modified",
            optional: true,
            header: language.t("operator.column.modified"),
            align: "end",
            value: (row) => row.modified,
            cell: (row) => formatAgo(row.modified, locale()),
          },
        ]}
      />
    </>
  )
}

export function SummariesTab(props: {
  memory: ReturnType<typeof useNamespaceMemory>
  onOpen: (session: string, project: string) => void
}) {
  const language = useLanguage()
  const projectName = useProjectName()
  const locale = () => language.intl()
  return (
    <>
      <p data-slot="operator-note">{language.t("operator.memory.summariesBody")}</p>
      <DataTable
        columnsKey="memory-summaries"
        label={language.t("operator.memory.summaries")}
        rows={props.memory.summaries()}
        loading={props.memory.pending()}
        empty={language.t("operator.memory.noSummaries")}
        onRowClick={(row) => props.onOpen(row.sessionID, row.project)}
        columns={[
          {
            id: "title",
            header: language.t("operator.column.title"),
            value: (row) => row.title,
            cell: (row) => row.title,
          },
          {
            id: "project",
            optional: true,
            header: language.t("operator.column.project"),
            value: (row) => projectName(row.project),
            cell: (row) => projectName(row.project),
          },
          {
            id: "time",
            header: language.t("operator.column.modified"),
            align: "end",
            value: (row) => row.time,
            cell: (row) => formatAgo(row.time, locale()),
          },
        ]}
      />
    </>
  )
}

/** The server's database (one for every namespace): where it is, its size and its tables. */
export function DatabaseSection(props: { database: OperatorMemoryOverview["database"] | undefined }) {
  const language = useLanguage()
  const locale = () => language.intl()
  const rows = () => props.database?.tables.reduce((total, table) => total + table.rows, 0) ?? 0
  return (
    <section data-component="operator-panel" data-testid="memory-database">
      <h2 data-slot="operator-panel-title">{language.t("operator.memory.database")}</h2>
      <p data-slot="operator-note">{language.t("operator.memory.databaseHint")}</p>
      <div data-slot="operator-tiles">
        <StatTile
          label={language.t("operator.memory.dbEngine")}
          value="SQLite"
          hint={language.t("operator.memory.dbEngineHint")}
        />
        <StatTile
          label={language.t("operator.memory.dbSize")}
          value={formatBytes(props.database?.size ?? 0, locale())}
          hint={<span title={props.database?.path}>{shortPath(props.database?.path ?? "")}</span>}
        />
        <StatTile
          label={language.t("operator.memory.dbRows")}
          value={formatCount(rows(), locale())}
          hint={language.t("operator.memory.dbTables", { count: props.database?.tables.length ?? 0 })}
        />
      </div>
      <DataTable
        columnsKey="memory-tables"
        label={language.t("operator.memory.tables")}
        rows={props.database?.tables ?? []}
        loading={!props.database}
        initialSort={{ column: "rows", direction: "desc" }}
        columns={[
          {
            id: "name",
            header: language.t("operator.column.name"),
            value: (row) => row.name,
            cell: (row) => <code>{row.name}</code>,
          },
          {
            id: "rows",
            optional: true,
            header: language.t("operator.memory.rows"),
            align: "end",
            value: (row) => row.rows,
            cell: (row) => formatCount(row.rows, locale()),
          },
        ]}
      />
    </section>
  )
}

// The overlay a file or a compaction summary opens in: files and summaries on the left. A file shows
// read-only, with Edit (Cancel or Save then) when it can be written; a new file opens in edit mode.
export function MemoryOverlay(props: { memory: ReturnType<typeof useNamespaceMemory> }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const openSession = useOpenSession()
  const [params, setParams] = useOverlayParams<{ file?: string; fproject?: string; summary?: string }>()
  const [store, setStore] = createStore({ text: "", saved: "", error: "", busy: false, editing: false })
  const locale = () => language.intl()
  const directory = () => params.fproject
  const trash = useTrashItem(directory)
  const selected = createMemo(() => props.memory.files().find((file) => file.path === params.file))
  const creating = createMemo(() => props.memory.creatable().find((item) => item.path === params.file))
  const summary = createMemo(() => props.memory.summaries().find((item) => item.sessionID === params.summary))
  const [file, setFile] = createStore({ text: undefined as string | undefined })
  createEffect(
    on([() => params.file, () => params.fproject, () => selected()?.editable], async () => {
      setFile("text", undefined)
      if (!params.file || !selected()?.editable) return
      const text = await api
        .client()
        .operator.memory.read({ directory: directory(), path: params.file })
        .then((result) => result.data?.text ?? "")
        .catch(() => "")
      setFile("text", text)
    }),
  )
  createEffect(
    on([() => params.file, () => file.text], () => {
      const text = creating() ? "" : (file.text ?? "")
      setStore({ text, saved: text, error: "", editing: !!creating() })
    }),
  )
  const blocks = createMemo<OverlayBlock[]>(() => [
    {
      id: "files",
      label: language.t("operator.memory.filesLabel"),
      icon: "open-file",
      empty: language.t("operator.memory.noFiles"),
      records: props.memory.files().map((item) => ({
        id: item.path,
        label: item.kind === "url" ? item.path : shortPath(item.path),
        detail: language.t(`operator.memory.kind.${item.kind}`),
      })),
    },
    {
      id: "summaries",
      label: language.t("operator.memory.summaries"),
      icon: "archive",
      empty: language.t("operator.memory.noSummaries"),
      records: props.memory.summaries().map((item) => ({
        id: item.sessionID,
        label: item.title,
        detail: formatAgo(item.time, locale()),
      })),
    },
  ])

  const save = async () => {
    const path = params.file
    if (!path) return
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.memory.write({ directory: directory(), path, text: store.text })
      .then(async () => {
        showToast({ title: language.t("operator.memory.saved"), description: shortPath(path) })
        setStore({ saved: store.text, editing: false })
        await queryClient.invalidateQueries({ queryKey: api.key("memory") })
        await queryClient.invalidateQueries({ queryKey: api.key("prompt-preview") })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  const cancel = () => {
    if (creating()) return setParams({ file: undefined, fproject: undefined })
    setStore({ text: store.saved, editing: false, error: "" })
  }
  const projectOf = (block: string, id: string) =>
    block === "summaries"
      ? props.memory.summaries().find((item) => item.sessionID === id)?.project
      : props.memory.files().find((item) => item.path === id)?.project

  return (
    <RecordOverlay
      title={language.t("operator.page.memory.title")}
      namespaces={[]}
      blocks={blocks()}
      block={params.summary ? "summaries" : "files"}
      record={params.file ?? params.summary}
      editing={store.editing}
      onBlock={(id) =>
        setParams({
          file: undefined,
          fproject: undefined,
          summary: undefined,
          tab: id === "summaries" ? "summaries" : "files",
        })
      }
      onRecord={(block, id) =>
        block === "summaries"
          ? setParams({ summary: id, file: undefined, fproject: undefined })
          : setParams({ file: id, fproject: projectOf(block, id), summary: undefined })
      }
    >
      <Show when={params.file}>
        <RecordView
          title={
            <span title={params.file}>
              {creating() ? language.t("operator.memory.new", { path: params.file! }) : shortPath(params.file!)}
            </span>
          }
          actions={
            <Show
              when={store.editing}
              fallback={
                <Show when={selected()?.editable}>
                  <ButtonV2 variant="contrast" onClick={() => setStore("editing", true)}>
                    {language.t("operator.profile.edit")}
                  </ButtonV2>
                  <ButtonV2
                    variant="danger"
                    onClick={() =>
                      void trash("memory", params.file!, shortPath(params.file!), () =>
                        setParams({ file: undefined, fproject: undefined }),
                      )
                    }
                  >
                    {language.t("operator.trash.delete")}
                  </ButtonV2>
                </Show>
              }
            >
              <ButtonV2 variant="neutral" onClick={cancel}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                disabled={store.busy || (!creating() && store.text === store.saved)}
                onClick={() => void save()}
              >
                {language.t("operator.config.save")}
              </ButtonV2>
            </Show>
          }
        >
          <Show when={selected()}>
            {(current) => (
              <p data-slot="operator-note">
                {language.t(`operator.memory.kindHint.${current().kind}`)} ·{" "}
                {language.t(`operator.memory.loaded.${current().loaded}`)}
              </p>
            )}
          </Show>
          <Show
            when={store.editing}
            fallback={
              <Show when={selected()?.editable} fallback={<p data-slot="operator-note">{params.file}</p>}>
                <pre data-component="operator-code">{store.saved || "—"}</pre>
              </Show>
            }
          >
            <TextareaV2
              class="operator-editor"
              rows={18}
              aria-label={language.t("operator.prompts.text")}
              value={store.text}
              onInput={(event) => setStore("text", event.currentTarget.value)}
            />
          </Show>
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
        </RecordView>
      </Show>
      <Show when={summary()}>
        {(found) => (
          <RecordView
            title={found().title}
            actions={
              <ButtonV2 variant="outline" onClick={() => openSession(found().sessionID)}>
                {language.t("operator.memory.openSession")}
              </ButtonV2>
            }
          >
            <p data-slot="operator-note">{formatAgo(found().time, locale())}</p>
            <pre data-component="operator-code">{found().text}</pre>
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}
