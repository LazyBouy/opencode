import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { useInfiniteQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo, formatCost, formatCount, sessionFolder, shortPath } from "../format"
import { useOperatorScope } from "../scope"
import { type Column, DataTable } from "../ui/data-table"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"
import { FieldHelp } from "../ui/field-help"
import { useMoveToTrash } from "../ui/confirm"
import { requestError } from "./config-helpers"
import { useSessionOverlay } from "./session-overlay"

const PAGE = 50

export default function SessionsPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const scope = useOperatorScope()
  const [prefs, setPrefs] = persisted(
    Persist.global("operator.sessions"),
    createStore({ children: false, archived: false }),
  )
  const [filter, setFilter] = createStore({ search: "", agent: "" })

  // The server filters by title and agent, and pages by the last row's update time.
  const sessions = useInfiniteQuery(() => ({
    queryKey: api.key("sessions", scope.directory(), filter.search, filter.agent, prefs.children, prefs.archived),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api
        .client()
        .operator.session.list({
          directory: scope.directory(),
          search: filter.search || undefined,
          agent: filter.agent || undefined,
          roots: prefs.children ? "false" : "true",
          archived: prefs.archived ? "true" : "false",
          cursor: pageParam === undefined ? undefined : String(pageParam),
          limit: String(PAGE),
        })
        .then((result) => result.data ?? []),
    getNextPageParam: (last: GlobalSession[]) => (last.length === PAGE ? last.at(-1)?.time.updated : undefined),
  }))
  const rows = createMemo(() => sessions.data?.pages.flat() ?? [])
  const locale = () => language.intl()
  const tokens = (session: GlobalSession) => (session.tokens?.input ?? 0) + (session.tokens?.output ?? 0)

  const columns: Column<GlobalSession>[] = [
    {
      id: "title",
      header: language.t("operator.column.title"),
      value: (session) => session.title,
      cell: (session) => session.title,
    },
    {
      id: "project",
      optional: true,
      header: language.t("operator.column.project"),
      value: (session) => sessionFolder(session),
      cell: (session) => <span title={session.directory}>{shortPath(sessionFolder(session))}</span>,
    },
    {
      id: "agent",
      optional: true,
      header: language.t("operator.column.agent"),
      value: (session) => session.agent,
      cell: (session) => session.agent ?? "",
    },
    {
      id: "model",
      optional: true,
      hidden: true,
      header: language.t("operator.column.model"),
      value: (session) => session.model?.id,
      cell: (session) => (session.model ? `${session.model.providerID}/${session.model.id}` : ""),
    },
    {
      id: "tokens",
      optional: true,
      header: language.t("operator.column.tokens"),
      align: "end",
      value: tokens,
      cell: (session) => formatCount(tokens(session), locale()),
    },
    {
      id: "cost",
      optional: true,
      header: language.t("operator.column.cost"),
      align: "end",
      value: (session) => session.cost ?? 0,
      cell: (session) => formatCost(session.cost ?? 0, locale()),
    },
    {
      id: "updated",
      optional: true,
      header: language.t("operator.column.updated"),
      align: "end",
      value: (session) => session.time.updated,
      cell: (session) => formatAgo(session.time.updated, locale()),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      cell: (session) => (
        <ButtonV2
          size="small"
          variant="ghost"
          onClick={(event: MouseEvent) => {
            event.stopPropagation()
            void remove(session)
          }}
        >
          {language.t("operator.trash.delete")}
        </ButtonV2>
      ),
    },
  ]

  // A session opens in the overlay; Maximize there opens the full session page.
  const openOverlay = useSessionOverlay(rows)

  // To Trash: archived (with its subagents' sessions) until restored or deleted for good.
  const moveToTrash = useMoveToTrash()
  const queryClient = useQueryClient()
  const remove = (session: GlobalSession) =>
    moveToTrash(session.title, () =>
      api
        .client()
        .operator.trash.session({ sessionID: session.id }, { throwOnError: true })
        .then(async () => {
          showToast({ title: language.t("operator.trash.moved", { name: session.title }) })
          await queryClient.invalidateQueries({ queryKey: api.key() })
        })
        .catch((error: unknown) =>
          showToast({ title: language.t("operator.trash.failed"), description: requestError(error) }),
        ),
    )

  return (
    <>
      <PageHeader
        title={language.t("operator.page.sessions.title")}
        description={language.t("operator.page.sessions.description")}
        actions={<ScopePicker all />}
      />
      <div data-slot="operator-toolbar">
        <TextInputV2
          type="search"
          appearance="base"
          value={filter.search}
          onChange={(event) => setFilter("search", event.currentTarget.value)}
          placeholder={language.t("operator.sessions.search")}
          aria-label={language.t("operator.sessions.search")}
        />
        <TextInputV2
          appearance="base"
          value={filter.agent}
          onChange={(event) => setFilter("agent", event.currentTarget.value.trim())}
          placeholder={language.t("operator.sessions.agent")}
          aria-label={language.t("operator.sessions.agent")}
        />
        <span class="inline-flex items-center">
          <Switch checked={prefs.children} onChange={(checked) => setPrefs("children", checked)}>
            {language.t("operator.sessions.children")}
          </Switch>
          <FieldHelp
            field={language.t("operator.sessions.children")}
            text={language.t("operator.help.sessionChildren")}
          />
        </span>
        <span class="inline-flex items-center">
          <Switch checked={prefs.archived} onChange={(checked) => setPrefs("archived", checked)}>
            {language.t("operator.sessions.archived")}
          </Switch>
          <FieldHelp
            field={language.t("operator.sessions.archived")}
            text={language.t("operator.help.sessionArchived")}
          />
        </span>
      </div>
      <DataTable
        columnsKey="sessions"
        label={language.t("operator.page.sessions.title")}
        rows={rows()}
        columns={columns}
        loading={sessions.isPending}
        empty={language.t("operator.sessions.empty")}
        onRowClick={(session) => openOverlay(session.id)}
      />
      <Show when={sessions.hasNextPage}>
        <div data-slot="operator-more">
          <ButtonV2
            variant="outline"
            disabled={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
          >
            {language.t("operator.sessions.more")}
          </ButtonV2>
        </div>
      </Show>
    </>
  )
}
