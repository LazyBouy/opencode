import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorHookRun } from "@opencode-ai/sdk/v2/client"
import { keepPreviousData, useQuery } from "@tanstack/solid-query"
import { createMemo, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient, useOpenSession } from "../data"
import { formatAgo, shortPath } from "../format"
import { type Column, DataTable } from "../ui/data-table"
import { OverlayFrame } from "../ui/overlay-frame"
import { useOverlayParams } from "../ui/overlay-nav"
import { SelectV2 } from "../ui/select"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Hook runs (SPEC-0022 §9, §10.1, §10.4, §10.6): a list with filters for hook, event, outcome, agent and time, and
// a run's details, everything the run log keeps, with a link to its session. The Capabilities page's Runs, a hook's
// Runs, and the session's and agent's Hooks tabs show the same list over different runs.

export const OUTCOMES = [
  "allowed",
  "denied",
  "changed",
  "context",
  "ok",
  "ok, with ignored fields",
  "failed",
  "timed out",
  "stopped by the server",
  "dropped",
] as const
const ANY = "@any"
const SINCE = { hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000 } as const

export const outcomeKey = (outcome: string) =>
  `operator.hooks.outcome.${outcome.replace(/[^a-z]+/g, "-").replace(/-$/, "")}` as Key
const warning = (outcome: string) =>
  outcome === "denied" || outcome === "failed" || outcome === "timed out" || outcome === "stopped by the server"

export function OutcomeTag(props: { outcome: string }) {
  const language = useLanguage()
  return <Tag data-warning={warning(props.outcome) ? "" : undefined}>{language.t(outcomeKey(props.outcome))}</Tag>
}

/** The runs a list shows: by session, agent or hook; every project's or this one's; Test runs only. */
export type RunsSource = {
  directory: () => string | undefined
  session?: () => string | undefined
  agent?: () => string | undefined
  hook?: () => string | undefined
  test?: boolean
  scope?: "project" | "all"
  /** Keeps only these runs (a namespace's hooks, by file). */
  keep?: (run: OperatorHookRun) => boolean
}

export function HookRunsList(props: { source: RunsSource; empty?: string; testid?: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [, setParams] = useOverlayParams<{ hrun?: string }>()
  const [filter, setFilter] = createStore({ hook: "", event: ANY, outcome: ANY, agent: "", since: ANY })
  const runs = useQuery(() => ({
    queryKey: api.key(
      "hook-runs-list",
      props.source.directory(),
      props.source.session?.(),
      props.source.agent?.(),
      props.source.hook?.(),
      props.source.test ? "test" : "",
      props.source.scope ?? "project",
    ),
    enabled: !!props.source.directory(),
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .client()
        .operator.hook.runs({
          directory: props.source.directory(),
          ...(props.source.session?.() ? { session: props.source.session!() } : {}),
          ...(props.source.agent?.() ? { agent: props.source.agent!() } : {}),
          ...(props.source.hook?.() ? { hook: props.source.hook!() } : {}),
          ...(props.source.test ? { test: "true" as const } : {}),
          ...(props.source.scope ? { scope: props.source.scope } : {}),
          limit: "500",
        })
        .then((result) => result.data!),
  }))
  const all = createMemo(() => (ready(runs)?.runs ?? []).filter((run) => props.source.keep?.(run) ?? true))
  const events = createMemo(() => [ANY, ...new Set(all().map((run) => run.event))])
  const rows = createMemo(() => {
    const since = filter.since === ANY ? 0 : Date.now() - SINCE[filter.since as keyof typeof SINCE]
    return all().filter(
      (run) =>
        (!filter.hook || run.hook.includes(filter.hook)) &&
        (filter.event === ANY || run.event === filter.event) &&
        (filter.outcome === ANY || run.outcome === filter.outcome) &&
        (!filter.agent || (run.agent ?? "").includes(filter.agent)) &&
        run.time >= since,
    )
  })
  const locale = () => language.intl()
  const columns: Column<OperatorHookRun>[] = [
    {
      id: "time",
      header: language.t("operator.hooks.column.time"),
      value: (run) => run.time,
      cell: (run) => <span title={new Date(run.time).toLocaleString(locale())}>{formatAgo(run.time, locale())}</span>,
    },
    { id: "hook", header: language.t("operator.hooks.column.hook"), value: (run) => run.hook, cell: (run) => run.hook },
    {
      id: "event",
      header: language.t("operator.hooks.column.event"),
      value: (run) => run.event,
      cell: (run) => <code>{run.event}</code>,
    },
    {
      id: "outcome",
      header: language.t("operator.hooks.column.outcome"),
      value: (run) => run.outcome,
      cell: (run) => <OutcomeTag outcome={run.outcome} />,
    },
    {
      id: "tool",
      optional: true,
      header: language.t("operator.hooks.column.tool"),
      value: (run) => run.tool ?? "",
      cell: (run) => run.tool ?? "",
    },
    {
      id: "agent",
      optional: true,
      header: language.t("operator.hooks.column.agent"),
      value: (run) => run.agent ?? "",
      cell: (run) => run.agent ?? "",
    },
    {
      id: "duration",
      optional: true,
      header: language.t("operator.hooks.column.duration"),
      value: (run) => run.durationMs ?? 0,
      align: "end",
      cell: (run) => (run.durationMs !== undefined ? `${run.durationMs} ms` : ""),
    },
    {
      id: "reason",
      optional: true,
      header: language.t("operator.hooks.column.reason"),
      cell: (run) => <span data-slot="operator-cell-clamp">{run.reason ?? ""}</span>,
    },
  ]
  const choice = (
    label: string,
    options: ReadonlyArray<string>,
    current: string,
    set: (value: string) => void,
    word: (value: string) => string,
  ) => (
    <SelectV2<string>
      appearance="base"
      aria-label={label}
      options={[...options]}
      current={current}
      label={(value) => (value === ANY ? language.t("operator.hooks.filter.any", { what: label }) : word(value))}
      onSelect={(value) => value !== null && set(value)}
    />
  )
  return (
    <div data-component="operator-hook-runs" data-testid={props.testid ?? "hook-runs"}>
      <div data-slot="operator-toolbar">
        <Show when={!props.source.hook}>
          <TextInputV2
            type="search"
            appearance="base"
            value={filter.hook}
            onInput={(event) => setFilter("hook", event.currentTarget.value)}
            placeholder={language.t("operator.hooks.filter.hook")}
            aria-label={language.t("operator.hooks.filter.hook")}
          />
        </Show>
        {choice(
          language.t("operator.hooks.column.event"),
          events(),
          filter.event,
          (value) => setFilter("event", value),
          (value) => value,
        )}
        {choice(
          language.t("operator.hooks.column.outcome"),
          [ANY, ...OUTCOMES],
          filter.outcome,
          (value) => setFilter("outcome", value),
          (value) => language.t(outcomeKey(value)),
        )}
        <Show when={!props.source.agent}>
          <TextInputV2
            type="search"
            appearance="base"
            value={filter.agent}
            onInput={(event) => setFilter("agent", event.currentTarget.value)}
            placeholder={language.t("operator.hooks.filter.agent")}
            aria-label={language.t("operator.hooks.filter.agent")}
          />
        </Show>
        {choice(
          language.t("operator.hooks.filter.since"),
          [ANY, "hour", "day", "week"],
          filter.since,
          (value) => setFilter("since", value),
          (value) => language.t(`operator.hooks.filter.since.${value}` as Key),
        )}
      </div>
      <DataTable
        columnsKey="hook-runs"
        label={language.t("operator.hooks.runs")}
        rows={rows()}
        loading={runs.isPending}
        columns={columns}
        initialSort={{ column: "time", direction: "desc" }}
        empty={props.empty ?? language.t("operator.hooks.noRuns")}
        onRowClick={(run) => setParams({ hrun: run.id })}
      />
    </div>
  )
}

// A run's details (`?hrun=<id>`): everything the run log keeps of it, and its session.
export function HookRunOverlay(props: { directory: () => string | undefined }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const openSession = useOpenSession()
  const [params] = useOverlayParams<{ hrun?: string }>()
  const run = useQuery(() => ({
    queryKey: api.key("hook-run", params.hrun),
    enabled: !!params.hrun,
    queryFn: () =>
      api
        .client()
        .operator.hook.run({ id: params.hrun!, directory: props.directory() }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const locale = () => language.intl()
  const fact = (label: string, value: JSX.Element | undefined) => (
    <Show when={value !== undefined && value !== ""}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </Show>
  )
  const block = (label: string, text: string | undefined) => (
    <Show when={text}>
      <section data-component="operator-panel">
        <h3 data-slot="operator-panel-title">{label}</h3>
        <pre data-component="operator-code">{text}</pre>
      </section>
    </Show>
  )
  return (
    <OverlayFrame label={ready(run)?.hook ?? params.hrun} editing={false}>
      <div data-component="operator-hook-run" data-testid="hook-run">
        <Show
          when={ready(run)}
          fallback={
            <p data-slot="operator-note">
              {run.isError ? language.t("operator.hooks.runMissing") : language.t("common.loading")}
            </p>
          }
        >
          {(found) => (
            <>
              <section data-component="operator-panel">
                <div class="flex items-center gap-2 flex-wrap">
                  <OutcomeTag outcome={found().outcome} />
                  <Show when={found().test}>
                    <Tag>{language.t("operator.hooks.testRun")}</Tag>
                  </Show>
                  <Show when={found().sessionID}>
                    {(session) => (
                      <ButtonV2 size="small" variant="outline" onClick={() => openSession(session())}>
                        {language.t("operator.hooks.openSession")}
                      </ButtonV2>
                    )}
                  </Show>
                </div>
                <dl data-component="operator-facts" data-layout="stacked">
                  {fact(language.t("operator.hooks.column.hook"), found().hook)}
                  {fact(language.t("operator.hooks.column.event"), <code>{found().event}</code>)}
                  {fact(language.t("operator.hooks.column.time"), new Date(found().time).toLocaleString(locale()))}
                  {fact(
                    language.t("operator.hooks.column.from"),
                    `${language.t(`operator.levels.level.${found().level}` as Key)} · ${shortPath(found().file)}`,
                  )}
                  {fact(language.t("operator.hooks.column.reason"), found().reason)}
                  {fact(language.t("operator.hooks.column.tool"), found().tool)}
                  {fact(language.t("operator.hooks.column.call"), found().callID)}
                  {fact(language.t("operator.hooks.column.agent"), found().agent)}
                  {fact(language.t("operator.hooks.column.session"), found().sessionID)}
                  {fact(
                    language.t("operator.hooks.column.project"),
                    found().project ? shortPath(found().project!) : undefined,
                  )}
                  {fact(
                    language.t("operator.hooks.column.duration"),
                    found().durationMs !== undefined ? `${found().durationMs} ms` : undefined,
                  )}
                  {fact(
                    language.t("operator.hooks.column.exit"),
                    found().exitCode === undefined ? undefined : String(found().exitCode ?? "—"),
                  )}
                  {fact(language.t("operator.hooks.column.ignored"), found().ignored?.join(", "))}
                  {fact(
                    language.t("operator.hooks.column.dropped"),
                    found().dropped !== undefined ? String(found().dropped) : undefined,
                  )}
                </dl>
              </section>
              {block(language.t("operator.hooks.run.before"), found().before)}
              {block(language.t("operator.hooks.run.after"), found().after)}
              {block(language.t("operator.hooks.run.context"), found().context)}
              {block(language.t("operator.hooks.run.stdout"), found().stdout)}
              {block(language.t("operator.hooks.run.stderr"), found().stderr)}
            </>
          )}
        </Show>
      </div>
    </OverlayFrame>
  )
}
