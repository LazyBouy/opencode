import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorTelemetryLogEntry, OperatorTelemetryLogPage } from "@opencode-ai/sdk/v2/client"
import { useInfiniteQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../../data"
import { formatDateTime } from "../../format"
import { SelectV2 } from "../../ui/select"
import { useLiveTail } from "./live"

// The Logs tab (observability_spec.md §13): the server log's lines kept in the store (warnings and errors by default),
// newest first, filtered by the lowest level, service, session and text. A row expands to every field, with Copy line
// in the log file's format. Live (§8.6) adds lines as they are written.

type Entry = OperatorTelemetryLogEntry
type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
const PAGE = 100
const LEVELS = ["error", "warn", "info"] as const
const ICON: Record<string, Parameters<typeof Icon>[0]["name"]> = { ERROR: "circle-x", WARN: "warning", INFO: "status" }

const fieldsOf = (entry: Entry): Array<[string, string]> => {
  if (!entry.fields) return []
  try {
    return Object.entries(JSON.parse(entry.fields) as Record<string, string>)
  } catch {
    return []
  }
}

const quote = (value: string) => (/^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value))

/** A line as the log file writes it (core observability/logging.ts). */
export function lineOf(entry: Entry) {
  return [
    `timestamp=${new Date(entry.time_ms).toISOString()}`,
    `level=${entry.level}`,
    ...(entry.run ? [`run=${entry.run}`] : []),
    `message=${quote(entry.message)}`,
    ...fieldsOf(entry).map(([key, value]) => `${key}=${quote(value)}`),
  ].join(" ")
}

export function LogsTab(props: {
  query: Record<string, string>
  level: string | undefined
  onLevel: (level: string | undefined) => void
  live: boolean
  onOpenSession: (sessionID: string) => void
  onUpdated: (time: number) => void
  note: string | undefined
  empty: () => JSX.Element
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const logs = useInfiniteQuery(() => ({
    queryKey: api.key("telemetry-logs", props.query),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api
        .client()
        .operator.telemetry.logs(
          { ...props.query, ...(pageParam ? { cursor: pageParam } : {}), limit: String(PAGE) },
          { throwOnError: true },
        )
        .then((result) => result.data!),
    getNextPageParam: (last: OperatorTelemetryLogPage) => last.nextCursor ?? undefined,
  }))
  createEffect(() => {
    if (logs.dataUpdatedAt) props.onUpdated(logs.dataUpdatedAt)
  })
  const base = createMemo(() => logs.data?.pages.flatMap((page) => page.rows) ?? [])
  const [top, setTop] = createSignal(true)
  let scroller: HTMLDivElement | undefined
  const live = useLiveTail<Entry>({
    enabled: () => props.live,
    seq: () => logs.data?.pages[0]?.seq,
    key: () => JSON.stringify(props.query),
    shown: () => base().map((row) => row.id),
    atTop: top,
    fetch: (after) =>
      api
        .client()
        .operator.telemetry.logs({ ...props.query, after: String(after), limit: "500" }, { throwOnError: true })
        .then((result) => ({ rows: result.data!.rows, seq: result.data!.seq })),
  })
  const rows = createMemo(() => (props.live ? live.rows(base()) : base()))
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => {
    const next = new Set(open())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }
  const levelWord = (level: string) => t(`operator.obs.level.${level.toLowerCase()}` as Key)

  return (
    <div data-component="operator-obs-logs">
      <div class="flex flex-wrap items-center gap-2">
        <SelectV2<string>
          appearance="base"
          aria-label={t("operator.obs.minLevel")}
          options={[...LEVELS]}
          current={props.level ?? "warn"}
          label={(level) => t(`operator.obs.levelAtLeast.${level}` as Key)}
          onSelect={(level) => level && props.onLevel(level === "warn" ? undefined : level)}
        />
        <Show when={props.note}>
          <p data-slot="operator-note" data-testid="obs-logs-note">
            {props.note}
          </p>
        </Show>
      </div>
      <Show when={props.live && live.waiting()}>
        <button
          type="button"
          data-slot="operator-obs-new"
          onClick={() => {
            scroller?.scrollTo({ top: 0 })
            setTop(true)
            live.show()
          }}
        >
          {t("operator.obs.newLines", { n: live.waiting() })}
        </button>
      </Show>
      <Show when={logs.isError}>
        <div data-slot="operator-error" role="alert">
          {String((logs.error as Error | undefined)?.message ?? logs.error)}
          <ButtonV2 size="small" variant="outline" onClick={() => void logs.refetch()}>
            {t("operator.obs.retry")}
          </ButtonV2>
        </div>
      </Show>
      <div
        ref={scroller}
        data-slot="operator-obs-scroll"
        onScroll={(event) => setTop(event.currentTarget.scrollTop < 8)}
      >
        <Show
          when={rows().length}
          fallback={<div data-slot="operator-table-empty">{logs.isPending ? t("common.loading") : props.empty()}</div>}
        >
          <table data-component="operator-table" aria-label={t("operator.obs.tab.logs")}>
            <thead>
              <tr>
                <th scope="col">{t("operator.obs.col.time")}</th>
                <th scope="col">{t("operator.obs.col.level")}</th>
                <th scope="col">{t("operator.obs.col.message")}</th>
                <th scope="col">{t("operator.obs.col.service")}</th>
                <th scope="col">{t("operator.obs.col.session")}</th>
                <th scope="col">{t("operator.obs.col.fields")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(entry) => (
                  <>
                    <tr
                      data-clickable=""
                      tabIndex={0}
                      data-testid="obs-log-row"
                      aria-expanded={open().has(entry.id)}
                      onClick={() => {
                        if (window.getSelection()?.toString()) return
                        toggle(entry.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return
                        event.preventDefault()
                        toggle(entry.id)
                      }}
                    >
                      <td title={new Date(entry.time_ms).toISOString()}>
                        {formatDateTime(entry.time_ms, language.intl())}
                      </td>
                      <td>
                        <span
                          data-slot="operator-obs-status"
                          data-status={
                            entry.level === "ERROR" ? "error" : entry.level === "WARN" ? "denied" : undefined
                          }
                        >
                          <Show when={ICON[entry.level]}>{(icon) => <Icon name={icon()} size="small" />}</Show>
                          {levelWord(entry.level)}
                        </span>
                      </td>
                      <td data-slot="operator-obs-message">{entry.message.split("\n")[0]}</td>
                      <td>{entry.service ?? ""}</td>
                      <td>
                        <Show when={entry.session_id}>
                          {(id) => (
                            <button
                              type="button"
                              data-slot="operator-link"
                              onClick={(event) => {
                                event.stopPropagation()
                                props.onOpenSession(id())
                              }}
                            >
                              {id()}
                            </button>
                          )}
                        </Show>
                      </td>
                      <td data-slot="operator-note">
                        {fieldsOf(entry)
                          .slice(0, 3)
                          .map(([key, value]) => `${key}=${value.length > 40 ? `${value.slice(0, 39)}…` : value}`)
                          .join(" ")}
                      </td>
                    </tr>
                    <Show when={open().has(entry.id)}>
                      <tr data-slot="operator-obs-log-detail">
                        <td colSpan={6}>
                          <dl data-slot="operator-obs-log-fields">
                            <div>
                              <dt>message</dt>
                              <dd>{entry.message}</dd>
                            </div>
                            <Show when={entry.run}>
                              <div>
                                <dt>run</dt>
                                <dd>{entry.run}</dd>
                              </div>
                            </Show>
                            <For each={fieldsOf(entry)}>
                              {([key, value]) => (
                                <div>
                                  <dt>{key}</dt>
                                  <dd>{value}</dd>
                                </div>
                              )}
                            </For>
                          </dl>
                          <ButtonV2
                            size="small"
                            variant="outline"
                            onClick={() => void navigator.clipboard?.writeText(lineOf(entry))}
                          >
                            {t("operator.obs.copyLine")}
                          </ButtonV2>
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
      <div data-slot="operator-obs-paging">
        <Show when={logs.hasNextPage && !props.live}>
          <ButtonV2
            size="small"
            variant="outline"
            disabled={logs.isFetchingNextPage}
            onClick={() => void logs.fetchNextPage()}
          >
            {t("operator.obs.loadMore")}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}
