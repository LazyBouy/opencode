import { useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorMemoryFile } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatBytes, formatCount, shortPath } from "../format"
import { useScopedProject } from "../project"
import { DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { useTrashItem } from "./trash"
import { ScopePicker } from "../ui/scope-picker"
import { StatTile } from "../ui/stat-tile"
import { requestError } from "./config-helpers"
import { useOverlayParams } from "../ui/overlay-nav"

// What OpenCode keeps for a project: its files and database, read for the page and its overlay.
function useMemory(directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("memory", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.memory.overview({ directory: directory() })
        .then((result) => result.data!),
  }))
}

// What OpenCode keeps for a project: the files it adds to prompts, and its database of sessions,
// messages and compaction summaries. A file or summary opens in the overlay.
export default function MemoryPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const directory = useScopedProject()
  const [params, setParams] = useSearchParams<{ tab?: string; file?: string; summary?: string }>()
  const locale = () => language.intl()
  const memory = useMemory(directory)
  // A file (or a compaction summary) opens in the overlay.
  useRecordOverlay(
    () => !!(params.file || params.summary),
    () => <MemoryOverlay />,
    ["file", "summary"],
  )

  const loaded = (file: OperatorMemoryFile) => language.t(`operator.memory.loaded.${file.loaded}`)
  const totalRows = createMemo(() =>
    (memory.data?.database.tables ?? []).reduce((total, table) => total + table.rows, 0),
  )

  return (
    <>
      <PageHeader
        title={language.t("operator.page.memory.title")}
        description={language.t("operator.page.memory.description")}
        actions={<ScopePicker />}
      />
      <Show
        when={directory()}
        fallback={
          <EmptyState
            icon="archive"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        <TabsV2 value={params.tab === "database" ? "database" : "files"} onChange={(tab: string) => setParams({ tab })}>
          <TabsV2.List>
            <TabsV2.Trigger value="files">
              {language.t("operator.memory.tab.files", { count: memory.data?.files.length ?? 0 })}
            </TabsV2.Trigger>
            <TabsV2.Trigger value="database">{language.t("operator.memory.tab.database")}</TabsV2.Trigger>
          </TabsV2.List>

          <TabsV2.Content value="files">
            <p data-slot="operator-note">{language.t("operator.memory.filesHint")}</p>
            <Show when={memory.data?.creatable.length}>
              <div class="flex flex-wrap gap-2">
                <For each={memory.data?.creatable ?? []}>
                  {(item) => (
                    <ButtonV2 size="small" variant="outline" onClick={() => setParams({ file: item.path })}>
                      {language.t(`operator.memory.create.${item.scope}`)}
                    </ButtonV2>
                  )}
                </For>
              </div>
            </Show>
            <DataTable
              columnsKey="memory-files"
              label={language.t("operator.memory.filesLabel")}
              rows={memory.data?.files ?? []}
              loading={memory.isPending}
              empty={language.t("operator.memory.noFiles")}
              onRowClick={(row) => setParams({ file: row.path })}
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
                  id: "scope",
                  optional: true,
                  header: language.t("operator.scope.label"),
                  value: (row) => row.scope,
                  cell: (row) => language.t(`operator.scope.${row.scope}`),
                },
                {
                  id: "loaded",
                  optional: true,
                  header: language.t("operator.memory.loadedLabel"),
                  value: (row) => row.loaded,
                  cell: loaded,
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
          </TabsV2.Content>

          <TabsV2.Content value="database">
            <p data-slot="operator-note">{language.t("operator.memory.databaseHint")}</p>
            <div data-slot="operator-tiles">
              <StatTile
                label={language.t("operator.memory.dbSize")}
                value={formatBytes(memory.data?.database.size ?? 0, locale())}
                hint={<span title={memory.data?.database.path}>{shortPath(memory.data?.database.path ?? "")}</span>}
              />
              <StatTile
                label={language.t("operator.memory.dbRows")}
                value={formatCount(totalRows(), locale())}
                hint={language.t("operator.memory.dbTables", { count: memory.data?.database.tables.length ?? 0 })}
              />
              <StatTile
                label={language.t("operator.memory.summaries")}
                value={formatCount(memory.data?.summaries.length ?? 0, locale())}
                hint={language.t("operator.memory.summariesHint")}
              />
            </div>
            <div data-slot="operator-columns">
              <section data-component="operator-panel">
                <h2 data-slot="operator-panel-title">{language.t("operator.memory.tables")}</h2>
                <DataTable
                  columnsKey="memory-tables"
                  label={language.t("operator.memory.tables")}
                  rows={memory.data?.database.tables ?? []}
                  loading={memory.isPending}
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
              <section data-component="operator-panel">
                <h2 data-slot="operator-panel-title">{language.t("operator.memory.summaries")}</h2>
                <p data-slot="operator-note">{language.t("operator.memory.summariesBody")}</p>
                <For
                  each={memory.data?.summaries ?? []}
                  fallback={<p data-slot="operator-note">{language.t("operator.memory.noSummaries")}</p>}
                >
                  {(summary) => (
                    <button
                      type="button"
                      data-slot="record-overlay-item"
                      onClick={() => setParams({ summary: summary.sessionID })}
                    >
                      <span data-slot="record-overlay-item-label">{summary.title}</span>
                      <span data-slot="record-overlay-item-detail">{formatAgo(summary.time, locale())}</span>
                    </button>
                  )}
                </For>
              </section>
            </div>
          </TabsV2.Content>
        </TabsV2>
      </Show>
    </>
  )
}

// The overlay a memory file or compaction summary opens in: files and summaries on the left. A file
// shows read-only, with Edit (Cancel or Save then) when it can be written; a new file opens in edit
// mode.
function MemoryOverlay() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const openSession = useOpenSession()
  const directory = useScopedProject()
  const memory = useMemory(directory)
  const [params, setParams] = useOverlayParams<{ file?: string; summary?: string }>()
  const [store, setStore] = createStore({ text: "", saved: "", error: "", busy: false, editing: false })
  const locale = () => language.intl()
  const trash = useTrashItem(directory)
  const selected = createMemo(() => memory.data?.files.find((file) => file.path === params.file))
  const creating = createMemo(() => memory.data?.creatable.find((item) => item.path === params.file))
  const summary = createMemo(() => memory.data?.summaries.find((item) => item.sessionID === params.summary))
  const file = useQuery(() => ({
    queryKey: api.key("memory-file", directory(), params.file),
    enabled: !!directory() && !!selected()?.editable,
    queryFn: () =>
      api
        .client()
        .operator.memory.read({ directory: directory(), path: params.file! })
        .then((result) => result.data?.text ?? ""),
  }))
  createEffect(
    on([() => params.file, () => file.data], () => {
      const text = creating() ? "" : (file.data ?? "")
      setStore({ text, saved: text, error: "", editing: !!creating() })
    }),
  )
  const blocks = createMemo<OverlayBlock[]>(() => [
    {
      id: "files",
      label: language.t("operator.memory.filesLabel"),
      icon: "open-file",
      empty: language.t("operator.memory.noFiles"),
      records: (memory.data?.files ?? []).map((item) => ({
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
      records: (memory.data?.summaries ?? []).map((item) => ({
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
        await queryClient.invalidateQueries({ queryKey: api.key("memory", directory()) })
        await queryClient.invalidateQueries({ queryKey: api.key("memory-file", directory(), path) })
        await queryClient.invalidateQueries({ queryKey: api.key("prompt-preview", directory()) })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  const cancel = () => {
    if (creating()) return setParams({ file: undefined })
    setStore({ text: store.saved, editing: false, error: "" })
  }

  return (
    <RecordOverlay
      title={language.t("operator.page.memory.title")}
      namespaces={[]}
      blocks={blocks()}
      block={params.summary ? "summaries" : "files"}
      record={params.file ?? params.summary}
      editing={store.editing}
      onBlock={(id) =>
        setParams({ file: undefined, summary: undefined, tab: id === "summaries" ? "database" : "files" })
      }
      onRecord={(block, id) =>
        block === "summaries"
          ? setParams({ summary: id, file: undefined })
          : setParams({ file: id, summary: undefined })
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
                      void trash("memory", params.file!, shortPath(params.file!), () => setParams({ file: undefined }))
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
