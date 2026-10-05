import { useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorTrashEntry } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo, shortPath } from "../format"
import { useConfirm, useDeleteForGood, useMoveToTrash } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { requestError } from "./config-helpers"

// What is in Trash, and putting it back or deleting it for good; any change refreshes what it can
// affect.
export function useTrash() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const entries = useQuery(() => ({
    queryKey: api.key("trash"),
    queryFn: () =>
      api
        .client()
        .operator.trash.list()
        .then((result) => result.data ?? []),
  }))
  // A delete or restore can change any operator list.
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key() })
  const fail = (error: unknown) =>
    showToast({ title: language.t("operator.trash.failed"), description: requestError(error) })
  const restore = (entry: OperatorTrashEntry) =>
    api
      .client()
      .operator.trash.restore({ id: entry.id }, { throwOnError: true })
      .then(async () => {
        showToast({ title: language.t("operator.trash.restored", { name: entry.name }) })
        await refresh()
      })
      .catch(fail)
  const purge = (entry: OperatorTrashEntry) =>
    api.client().operator.trash.purge({ id: entry.id }, { throwOnError: true }).then(refresh).catch(fail)
  return { entries, restore, purge, refresh, fail }
}

// Moves a project's skill, command, custom tool, MCP server or memory file to Trash, after asking.
export function useTrashItem(directory: () => string | undefined) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const moveToTrash = useMoveToTrash()
  return (kind: "skill" | "command" | "tool" | "mcp" | "memory", name: string, label = name, done?: () => void) =>
    moveToTrash(label, () =>
      api
        .client()
        .operator.trash.item({ directory: directory(), kind, name }, { throwOnError: true })
        .then(async () => {
          showToast({ title: language.t("operator.trash.moved", { name: label }) })
          done?.()
          await queryClient.invalidateQueries({ queryKey: api.key() })
        })
        .catch((error: unknown) =>
          showToast({ title: language.t("operator.trash.failed"), description: requestError(error) }),
        ),
    )
}

const kinds = [
  "project",
  "agent",
  "session",
  "namespace",
  "profile",
  "group",
  "layer",
  "type",
  "skill",
  "command",
  "tool",
  "mcp",
  "memory",
] as const

// Trash: everything deleted in the operator pages, newest first. An entry opens in the overlay, with
// Restore and Delete permanently; Empty Trash deletes everything for good.
export default function TrashPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const confirm = useConfirm()
  const trash = useTrash()
  const [params, setParams] = useSearchParams<{ entry?: string }>()
  useRecordOverlay(
    () => !!params.entry,
    () => <TrashOverlay />,
    () => setParams({ entry: undefined }),
  )
  const empty = async () => {
    const ok = await confirm({
      title: language.t("operator.trash.emptyTitle"),
      description: language.t("operator.trash.emptyBody"),
      confirm: language.t("operator.trash.emptyConfirm"),
      danger: true,
    })
    if (!ok) return
    await api.client().operator.trash.empty({ throwOnError: true }).then(trash.refresh).catch(trash.fail)
  }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.trash.title")}
        description={language.t("operator.page.trash.description")}
        actions={
          <Show when={trash.entries.data?.length}>
            <ButtonV2 size="small" variant="danger" onClick={() => void empty()}>
              {language.t("operator.trash.empty")}
            </ButtonV2>
          </Show>
        }
      />
      <Show
        when={trash.entries.data?.length || trash.entries.isPending}
        fallback={<EmptyState icon="trash" title={language.t("operator.trash.none")} />}
      >
        <DataTable
          columnsKey="trash"
          label={language.t("operator.page.trash.title")}
          rows={trash.entries.data ?? []}
          loading={trash.entries.isPending}
          empty={language.t("operator.trash.none")}
          onRowClick={(entry) => setParams({ entry: entry.id })}
          columns={[
            {
              id: "name",
              header: language.t("operator.column.name"),
              value: (entry) => entry.name,
              cell: (entry) => entry.name,
            },
            {
              id: "kind",
              header: language.t("operator.trash.kindLabel"),
              value: (entry) => entry.kind,
              cell: (entry) => <Tag>{language.t(`operator.trash.kind.${entry.kind}`)}</Tag>,
            },
            {
              id: "from",
              optional: true,
              header: language.t("operator.trash.from"),
              value: (entry) => entry.project ?? entry.namespace ?? "",
              cell: (entry) => (
                <span data-slot="operator-cell-clamp">
                  {entry.project ? shortPath(entry.project) : (entry.namespace ?? "")}
                </span>
              ),
            },
            {
              id: "deleted",
              optional: true,
              header: language.t("operator.trash.deleted"),
              align: "end",
              value: (entry) => entry.deletedAt,
              cell: (entry) => formatAgo(entry.deletedAt, language.intl()),
            },
          ]}
        />
      </Show>
    </>
  )
}

// The overlay an entry opens in: the kinds in Trash on the left; what it was and where, with Restore
// and Delete permanently.
function TrashOverlay() {
  const language = useLanguage()
  const trash = useTrash()
  const purge = useDeleteForGood()
  const [params, setParams] = useSearchParams<{ entry?: string }>()
  const entry = createMemo(() => trash.entries.data?.find((item) => item.id === params.entry))
  const blocks = createMemo<OverlayBlock[]>(() =>
    kinds
      .map((kind) => ({
        id: kind,
        label: language.t(`operator.trash.kind.${kind}`),
        icon: "trash" as const,
        records: (trash.entries.data ?? [])
          .filter((item) => item.kind === kind)
          .map((item) => ({ id: item.id, label: item.name, detail: formatAgo(item.deletedAt, language.intl()) })),
      }))
      .filter((block) => block.records.length),
  )
  // After a restore or delete the entry is gone: the next one opens, else the list.
  const next = (id: string) => {
    const order = blocks().flatMap((block) => block.records.map((record) => record.id))
    return order[order.indexOf(id) + 1] ?? order[order.indexOf(id) - 1]
  }

  return (
    <RecordOverlay
      title={language.t("operator.page.trash.title")}
      namespaces={[]}
      blocks={blocks()}
      block={entry()?.kind ?? blocks()[0]?.id ?? "project"}
      record={params.entry}
      editing={false}
      onBlock={(id) => setParams({ entry: blocks().find((block) => block.id === id)?.records[0]?.id })}
      onRecord={(_, id) => setParams({ entry: id })}
    >
      <Show when={entry()} fallback={<p data-slot="operator-note">{language.t("operator.trash.none")}</p>}>
        {(found) => (
          <RecordView
            title={
              <>
                {found().name}
                <Tag>{language.t(`operator.trash.kind.${found().kind}`)}</Tag>
              </>
            }
            actions={
              <>
                <ButtonV2
                  variant="contrast"
                  onClick={() => {
                    const after = next(found().id)
                    void trash.restore(found()).then(() => setParams({ entry: after }))
                  }}
                >
                  {language.t("operator.trash.restore")}
                </ButtonV2>
                <ButtonV2
                  variant="danger"
                  onClick={() => {
                    const after = next(found().id)
                    void purge(found().name, () => trash.purge(found())).then(
                      (done) => done && setParams({ entry: after }),
                    )
                  }}
                >
                  {language.t("operator.trash.purge")}
                </ButtonV2>
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.trash.kindLabel")} help={language.t("operator.help.trashKind")}>
                {language.t(`operator.trash.kind.${found().kind}`)}
              </RecordField>
              <Show when={found().project ?? found().namespace}>
                {(from) => (
                  <RecordField label={language.t("operator.trash.from")} help={language.t("operator.help.trashFrom")}>
                    {from()}
                  </RecordField>
                )}
              </Show>
              <Show when={found().files.length}>
                <RecordField label={language.t("operator.trash.files")} help={language.t("operator.help.trashFiles")}>
                  <ul>
                    <For each={found().files}>
                      {(file) => (
                        <li>
                          <code>{file.path}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </RecordField>
              </Show>
              <Show when={found().config}>
                {(config) => (
                  <RecordField
                    label={language.t("operator.trash.config")}
                    help={language.t("operator.help.trashConfig")}
                  >
                    <code>
                      {config().scope}: {config().key.join(".")}
                    </code>
                  </RecordField>
                )}
              </Show>
              <Show when={found().sessions?.length}>
                {(count) => (
                  <RecordField
                    label={language.t("operator.trash.sessions")}
                    help={language.t("operator.help.trashSessions")}
                  >
                    {count()}
                  </RecordField>
                )}
              </Show>
              <RecordField label={language.t("operator.trash.deleted")} help={language.t("operator.help.trashDeleted")}>
                {formatAgo(found().deletedAt, language.intl())}
              </RecordField>
            </dl>
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}
