import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import type { OperatorTelemetrySessionDetail, OperatorTelemetrySpan } from "@opencode-ai/sdk/v2/client"
import { useSearchParams } from "@solidjs/router"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { asList, ready, useOperatorClient } from "../../data"
import { formatCost, formatCount, formatDateTime, shortPath } from "../../format"
import { useOperatorProjects } from "../../project"
import { useOpenSessionView } from "../../session-views/view"
import { useNamespaceScope } from "../../ui/namespace-picker"
import { OverlayFrame } from "../../ui/overlay-frame"
import { useOverlayParams } from "../../ui/overlay-nav"
import { DecisionView } from "../../ui/permission-requests"
import { attrsOf, cacheHit } from "./model"
import { CacheHit, Cost, Status, Tokens, useDuration, useStatusWord } from "./parts"
import { turnCounts } from "./sessions"
import { TurnTimeline } from "./timeline"

// A session's detail (observability_spec.md §10), over any tab: its header (times, totals, actions), its turns (the
// latest 20, then earlier ones), each turn's timeline, and the span panel for the span chosen. `session`, `turn` and
// `span` in the URL open it there; a subagent opens as the next level of the trail.

type Span = OperatorTelemetrySpan
type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

export function SessionDetail(props: { records: () => ReadonlyArray<string> }) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const openView = useOpenSessionView()
  const duration = useDuration()
  const projects = useOperatorProjects()
  const namespaces = useNamespaceScope()
  const [params, setParams] = useOverlayParams<{ session?: string; turn?: string; span?: string }>()
  const [, setPage] = useSearchParams()
  const id = () => params.session ?? ""

  // The latest turns first; earlier pages come before them.
  const detail = useInfiniteQuery(() => ({
    queryKey: api.key("telemetry-session", id()),
    enabled: !!id(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api
        .client()
        .operator.telemetry.session({ id: id(), ...(pageParam ? { before: pageParam } : {}) }, { throwOnError: true })
        .then((result) => result.data!),
    getNextPageParam: (last: OperatorTelemetrySessionDetail) =>
      last.earlier && last.turns[0] ? String(last.turns[0].span.start_ms) : undefined,
  }))
  const session = () => detail.data?.pages[0]?.session
  const turns = createMemo(() => [...(detail.data?.pages ?? [])].reverse().flatMap((page) => page.turns))
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  // The turn in the URL opens expanded and in view.
  createEffect(
    on(
      () => [params.turn, turns().length] as const,
      ([turn]) => {
        if (!turn) return
        setExpanded((before) => new Set([...before, turn]))
        requestAnimationFrame(() =>
          document.querySelector(`[data-turn="${CSS.escape(turn)}"]`)?.scrollIntoView({ block: "center" }),
        )
      },
    ),
  )
  const project = () => projects().find((item) => item.directory === session()?.project_key)
  const step = () => {
    const list = props.records()
    const index = list.indexOf(id())
    return {
      index,
      count: list.length,
      go: (by: number) => {
        const next = list[index + by]
        if (next) setParams({ session: next, turn: undefined, span: undefined })
      },
    }
  }
  const keep = async (on: boolean) => {
    const client = api.client().operator.telemetry
    await (on ? client.keep({ id: id() }) : client.unkeep({ id: id() }))
    await queryClient.invalidateQueries({ queryKey: api.key("telemetry-session", id()) })
  }
  const exportSession = async () => {
    const full = await api
      .client()
      .operator.telemetry.session({ id: id(), turns: "all" }, { throwOnError: true })
      .then((result) => result.data!)
    const trees = await Promise.all(
      full.turns.map((turn) =>
        api
          .client()
          .operator.telemetry.turn({ id: id(), turnID: turn.span.id }, { throwOnError: true })
          .then((result) => result.data!),
      ),
    )
    const blob = new Blob(
      [
        JSON.stringify(
          {
            session: full.session,
            turns: full.turns.map((turn) => turn.span),
            spans: trees.flatMap((tree) => tree.spans),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    )
    const link = document.createElement("a")
    link.href = URL.createObjectURL(blob)
    link.download = `opencode-session-${id()}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  const selected = useQuery(() => ({
    queryKey: api.key("telemetry-span", params.span),
    enabled: !!params.span,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.span({ id: params.span! }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  // Each span chosen is a step Back undoes (§21.2).
  const select = (span: Span) =>
    setParams(
      { span: span.id, turn: span.kind === "turn" ? span.id : (span.turn_id ?? params.turn) },
      { replace: false },
    )

  return (
    <OverlayFrame label={session()?.title ?? id()} editing={false} step={step()}>
      <div data-component="operator-obs-detail" data-testid="obs-session-detail">
        <Show
          when={session()}
          fallback={
            <div data-slot="operator-obs-detail-empty">
              {detail.isError ? t("operator.obs.noSessionTelemetry") : t("common.loading")}
            </div>
          }
        >
          {(row) => (
            <>
              <header data-slot="operator-obs-detail-head">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 data-slot="operator-obs-detail-title">{row().title || row().id}</h2>
                  <Status status={row().status} scope="session" />
                  <Show when={row().kept}>
                    <Tag>{t("operator.obs.kept")}</Tag>
                  </Show>
                </div>
                <div class="flex flex-wrap items-center gap-2" data-slot="operator-note">
                  <span>
                    {row().agent}
                    <Show when={row().agent_type && row().agent_type !== "usual"}>
                      {" · "}
                      {t(`operator.obs.agentType.${row().agent_type}` as Key)}
                    </Show>
                  </span>
                  <span title={row().project_key ?? ""}>
                    {project()?.label ?? (row().project_key ? shortPath(row().project_key!) : "")}
                    {" · "}
                    {namespaces.name(project()?.namespace ?? "opencode")}
                  </span>
                  <Show when={row().model}>
                    <span>{row().model}</span>
                  </Show>
                </div>
                <dl data-slot="operator-obs-facts">
                  <Fact label={t("operator.obs.col.started")}>
                    {formatDateTime(row().first_ms ?? undefined, language.intl())}
                  </Fact>
                  <Fact label={t("operator.obs.col.lastActivity")}>
                    {formatDateTime(row().last_ms ?? undefined, language.intl())}
                  </Fact>
                  <Fact label={t("operator.obs.col.duration")}>
                    {duration((row().last_ms ?? 0) - (row().first_ms ?? 0))}
                  </Fact>
                  <Fact label={t("operator.obs.col.active")}>{duration(row().active_ms)}</Fact>
                  <Fact label={t("operator.obs.col.wait")}>{duration(row().wait_ms)}</Fact>
                  <Fact label={t("operator.obs.col.turns")}>{row().turns}</Fact>
                  <Fact label={t("operator.obs.col.modelCalls")}>{row().model_calls}</Fact>
                  <Fact label={t("operator.obs.col.toolCalls")}>{row().tool_calls}</Fact>
                  <Fact label={t("operator.obs.col.errors")}>{row().errors}</Fact>
                  <Fact label={t("operator.obs.col.denials")}>{row().denials}</Fact>
                  <Fact label={t("operator.obs.col.retries")}>{row().retries}</Fact>
                  <Fact label={t("operator.obs.col.subagents")}>{row().subagents}</Fact>
                  <Fact label={t("operator.obs.col.tokens")}>
                    <Tokens row={row()} />
                  </Fact>
                  <Fact label={t("operator.obs.col.cacheHit")}>
                    <CacheHit row={row()} />
                  </Fact>
                  <Fact label={t("operator.obs.costOwn")}>{formatCost(row().cost, language.intl())}</Fact>
                  <Fact label={t("operator.obs.costTotal")}>{formatCost(row().cost_total, language.intl())}</Fact>
                  <Show when={row().cost_billed !== null}>
                    <Fact label={t("operator.obs.costBilled")}>
                      {formatCost(row().cost_billed ?? 0, language.intl())}
                    </Fact>
                  </Show>
                </dl>
                <div data-slot="operator-actions">
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={!!row().trashed}
                    onClick={() => openView(row().id, "user")}
                  >
                    {t("operator.obs.openInChats")}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={!!row().trashed}
                    onClick={() => openView(row().id, "transcript")}
                  >
                    {t("operator.obs.transcript")}
                  </ButtonV2>
                  <MenuV2>
                    <MenuV2.Trigger as={ButtonV2} size="small" variant="ghost" aria-label={t("operator.obs.more")}>
                      <Icon name="menu" size="small" />
                    </MenuV2.Trigger>
                    <MenuV2.Portal>
                      <MenuV2.Content>
                        <MenuV2.Item onSelect={() => void keep(!row().kept)}>
                          {row().kept ? t("operator.obs.unkeep") : t("operator.obs.keep")}
                        </MenuV2.Item>
                        <MenuV2.Item onSelect={() => void exportSession()}>
                          {t("operator.obs.exportSession")}
                        </MenuV2.Item>
                        <MenuV2.Item onSelect={() => void navigator.clipboard?.writeText(location.href)}>
                          {t("operator.obs.copyLink")}
                        </MenuV2.Item>
                      </MenuV2.Content>
                    </MenuV2.Portal>
                  </MenuV2>
                </div>
              </header>
              <div data-slot="operator-obs-detail-body" data-panel={params.span ? "" : undefined}>
                <section data-slot="operator-obs-turns" aria-label={t("operator.obs.turns")}>
                  <Show when={detail.hasNextPage}>
                    <ButtonV2
                      size="small"
                      variant="ghost"
                      disabled={detail.isFetchingNextPage}
                      onClick={() => void detail.fetchNextPage()}
                    >
                      {t("operator.obs.earlierTurns")}
                    </ButtonV2>
                  </Show>
                  <Show when={!turns().length}>
                    <p data-slot="operator-note">{t("operator.obs.noTurns")}</p>
                  </Show>
                  <For each={turns()}>
                    {(turn) => {
                      const open = () => expanded().has(turn.span.id)
                      const counts = () => turnCounts(turn.span.attrs)
                      return (
                        <article data-slot="operator-obs-turn" data-turn={turn.span.id} data-testid="obs-turn">
                          <button
                            type="button"
                            data-slot="operator-obs-turn-head"
                            aria-expanded={open()}
                            onClick={() => {
                              const next = new Set(expanded())
                              if (open()) next.delete(turn.span.id)
                              else next.add(turn.span.id)
                              setExpanded(next)
                            }}
                          >
                            <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
                            <span data-slot="operator-obs-turn-number">
                              {t("operator.obs.turnNumber", { n: turn.number })}
                            </span>
                            <Status status={turn.span.status} />
                            <span data-slot="operator-obs-turn-label">{turn.label ? `“${turn.label}”` : ""}</span>
                            <span data-slot="operator-note">
                              {formatDateTime(turn.span.start_ms ?? undefined, language.intl())}
                            </span>
                            <span data-slot="operator-note">
                              {t("operator.obs.activeShort", {
                                time: duration(turn.span.active_ms ?? turn.span.duration_ms ?? 0),
                              })}
                            </span>
                            <Show when={turn.span.wait_ms}>
                              <span data-slot="operator-note">
                                {t("operator.obs.waitShort", { time: duration(turn.span.wait_ms) })}
                              </span>
                            </Show>
                            <span data-slot="operator-note">
                              {t("operator.obs.callsShort", { n: counts().modelCalls })}
                            </span>
                            <span data-slot="operator-note">
                              {t("operator.obs.toolsShort", { n: counts().toolCalls })}
                            </span>
                            <Cost value={turn.span.cost} />
                            <Show when={turn.span.loop}>
                              <Tag data-warning="">⟲ {t("operator.obs.possibleLoop")}</Tag>
                            </Show>
                            <Show when={counts().retries}>
                              <Tag>{t("operator.obs.retriesShort", { n: counts().retries })}</Tag>
                            </Show>
                            <Show when={counts().compactions}>
                              <Tag>{t("operator.obs.compacted")}</Tag>
                            </Show>
                            <Show when={counts().errors}>
                              <Tag data-warning="">{t("operator.obs.errorsShort", { n: counts().errors })}</Tag>
                            </Show>
                          </button>
                          <Show when={open()}>
                            <TurnTimeline
                              sessionID={id()}
                              turnID={turn.span.id}
                              selected={params.span}
                              onSelect={select}
                              onOpenSession={(child) =>
                                setParams({ session: child, turn: undefined, span: undefined }, { replace: false })
                              }
                            />
                          </Show>
                        </article>
                      )
                    }}
                  </For>
                </section>
                <Show when={params.span}>
                  <SpanPanel
                    detail={ready(selected)}
                    loading={selected.isPending}
                    onShowInEvents={(span) => {
                      const turn = turns().find(
                        (item) => item.span.id === (span.kind === "turn" ? span.id : span.turn_id),
                      )
                      const window = turn?.span ?? span
                      setPage({
                        tab: "events",
                        inSession: span.session_id ?? undefined,
                        from: String(window.start_ms ?? 0),
                        to: String((window.end_ms ?? Date.now()) + 1),
                        range: undefined,
                        session: undefined,
                        turn: undefined,
                        span: undefined,
                        full: undefined,
                      })
                    }}
                    onClose={() => setParams({ span: undefined })}
                    onOpenSession={(child) =>
                      setParams({ session: child, turn: undefined, span: undefined }, { replace: false })
                    }
                  />
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </OverlayFrame>
  )
}

function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  )
}

/** A span's fields, grouped (§10.4), with links to where it came from. */
export function SpanPanel(props: {
  detail: { span: Span; links: Record<string, string | undefined> } | undefined
  loading: boolean
  onClose: () => void
  onOpenSession: (sessionID: string) => void
  /** Show in Events: the Events tab, filtered to its session and its turn's time. */
  onShowInEvents?: (span: Span) => void
  /** Open session: the session detail at this span (from the Events tab). */
  onOpenAt?: (span: Span) => void
}) {
  const language = useLanguage()
  const t = language.t
  const dialog = useDialog()
  const api = useOperatorClient()
  const duration = useDuration()
  const word = useStatusWord()
  const openView = useOpenSessionView()
  const n = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : formatCount(value, language.intl())
  const span = () => props.detail?.span
  const speed = () => {
    const s = span()
    if (!s?.tokens_output || !s.end_ms || !s.ttft_ms || !s.start_ms) return undefined
    const seconds = (s.end_ms - (s.start_ms + s.ttft_ms)) / 1000
    return seconds > 0 ? s.tokens_output / seconds : undefined
  }
  const openDecision = async (requestID: string, sessionID: string) => {
    const records = await api
      .client()
      .operator.permission.decisions({ sessionID, limit: "500" })
      .then((result) => asList(result.data))
    const record = records.find((item) => item.requestID === requestID)
    if (!record) return
    void dialog.push(() => (
      <Dialog size="large" variant="settings" class="record-overlay">
        <div class="settings-v2-tab-body" style={{ padding: "24px 32px" }}>
          <DecisionView record={record} />
        </div>
      </Dialog>
    ))
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    props.onClose()
  }
  const group = (title: string, rows: Array<[string, JSX.Element | string | number | null | undefined]>) => {
    const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "")
    return (
      <Show when={shown.length}>
        <section>
          <h4>{title}</h4>
          <dl>
            <For each={shown}>
              {([label, value]) => (
                <div>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              )}
            </For>
          </dl>
        </section>
      </Show>
    )
  }
  return (
    <aside
      data-slot="operator-obs-span-panel"
      data-testid="obs-span-panel"
      aria-label={t("operator.obs.spanPanel")}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div class="flex items-center justify-between gap-2">
        <strong>{span()?.name ?? ""}</strong>
        <ButtonV2
          size="small"
          variant="ghost"
          aria-label={t("operator.obs.closePanel")}
          onClick={() => props.onClose()}
        >
          <Icon name="close-small" size="small" />
        </ButtonV2>
      </div>
      <Show
        when={span()}
        fallback={<p data-slot="operator-note">{props.loading ? t("common.loading") : t("operator.obs.noSpan")}</p>}
      >
        {(s) => (
          <>
            {group(t("operator.obs.group.what"), [
              [t("operator.obs.field.kind"), t(`operator.obs.kind.${s().kind}` as Key)],
              [t("operator.obs.field.status"), word(s().status)],
              [t("operator.obs.field.errorType"), s().error_type],
              [t("operator.obs.field.errorMessage"), s().error_message],
              [t("operator.obs.field.finish"), s().finish_reason],
            ])}
            {group(t("operator.obs.group.when"), [
              [t("operator.obs.field.start"), formatDateTime(s().start_ms ?? undefined, language.intl())],
              [t("operator.obs.field.end"), formatDateTime(s().end_ms ?? undefined, language.intl())],
              [t("operator.obs.col.duration"), s().duration_ms !== null ? duration(s().duration_ms) : undefined],
              [t("operator.obs.col.active"), s().active_ms !== null ? duration(s().active_ms) : undefined],
              [t("operator.obs.col.wait"), s().wait_ms ? duration(s().wait_ms) : undefined],
              [
                t("operator.obs.field.ttft"),
                s().ttft_ms !== null ? duration(s().ttft_ms) : s().kind === "model_call" ? "—" : undefined,
              ],
              [
                t("operator.obs.field.speed"),
                speed() ? t("operator.obs.tokensPerSecond", { n: n(Math.round(speed()!)) }) : undefined,
              ],
            ])}
            <Show when={s().kind === "model_call" && s().ttft_ms === null}>
              <p data-slot="operator-note">{t("operator.obs.noRecording")}</p>
            </Show>
            {group(t("operator.obs.group.model"), [
              [t("operator.obs.col.model"), s().model],
              [t("operator.obs.field.provider"), s().provider],
              [t("operator.obs.field.attempt"), s().attempts ? `${s().attempt} / ${s().attempts}` : undefined],
              [t("operator.obs.field.http"), s().http_status],
              [
                t("operator.obs.field.context"),
                s().context_tokens && s().context_limit
                  ? `${Math.round((s().context_tokens! / s().context_limit!) * 1000) / 10}%`
                  : s().context_tokens
                    ? n(s().context_tokens)
                    : undefined,
              ],
              [t("operator.obs.field.tokensInput"), n(s().tokens_input)],
              [t("operator.obs.field.tokensRead"), n(s().tokens_cache_read)],
              [t("operator.obs.field.tokensWrite"), n(s().tokens_cache_write)],
              [t("operator.obs.field.tokensOutput"), n(s().tokens_output)],
              [t("operator.obs.field.tokensReasoning"), n(s().tokens_reasoning)],
              [
                t("operator.obs.col.cacheHit"),
                cacheHit(s()) !== undefined && s().kind === "model_call" ? <CacheHit row={s()} /> : undefined,
              ],
              [t("operator.obs.col.cost"), s().cost ? formatCost(s().cost!, language.intl()) : undefined],
              [
                t("operator.obs.costBilled"),
                s().cost_billed !== null ? formatCost(s().cost_billed ?? 0, language.intl()) : undefined,
              ],
            ])}
            {group(t("operator.obs.group.tool"), [
              [t("operator.obs.col.tool"), s().tool],
              [t("operator.obs.field.mcp"), s().mcp_server],
              [t("operator.obs.field.argsHash"), s().args_hash ? s().args_hash!.slice(0, 12) : undefined],
              [t("operator.obs.field.resultHash"), s().result_hash ? s().result_hash!.slice(0, 12) : undefined],
            ])}
            {group(t("operator.obs.group.permission"), [
              [t("operator.obs.field.permission"), s().permission],
              [t("operator.obs.field.pattern"), s().pattern],
              [t("operator.obs.field.decision"), s().decision],
              [t("operator.obs.field.decidedBy"), s().decided_by],
              [
                t("operator.obs.field.decisionSource"),
                s().decision_source ? t(`operator.obs.source.${s().decision_source}` as Key) : undefined,
              ],
            ])}
            {group(t("operator.obs.group.where"), [
              [t("operator.obs.col.session"), s().session_id],
              [t("operator.obs.col.agent"), s().agent],
              [t("operator.obs.col.project"), s().project_key],
              [t("operator.obs.field.folder"), s().directory],
              [t("operator.obs.field.purpose"), attrsOf(s()).purpose as string | undefined],
            ])}
            <div data-slot="operator-actions">
              <Show when={props.detail?.links.call && s().session_id}>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() => openView(s().session_id!, "transcript", props.detail!.links.call)}
                >
                  {t("operator.obs.openTranscript")}
                </ButtonV2>
              </Show>
              <Show when={s().kind === "tool_call" && s().session_id}>
                <ButtonV2 size="small" variant="outline" onClick={() => openView(s().session_id!, "detailed")}>
                  {t("operator.obs.openInChats")}
                </ButtonV2>
              </Show>
              <Show when={s().kind === "permission_wait" && props.detail?.links.decision && s().session_id}>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() => void openDecision(props.detail!.links.decision!, s().session_id!)}
                >
                  {t("operator.obs.openDecision")}
                </ButtonV2>
              </Show>
              <Show when={props.detail?.links.child}>
                {(child) => (
                  <ButtonV2 size="small" variant="outline" onClick={() => props.onOpenSession(child())}>
                    {t("operator.obs.openSubagent")}
                  </ButtonV2>
                )}
              </Show>
              <Show when={props.onOpenAt && s().session_id}>
                <ButtonV2 size="small" variant="outline" onClick={() => props.onOpenAt!(s())}>
                  {t("operator.obs.openSession")}
                </ButtonV2>
              </Show>
              <Show when={props.onShowInEvents && s().session_id}>
                <ButtonV2 size="small" variant="ghost" onClick={() => props.onShowInEvents!(s())}>
                  {t("operator.obs.showInEvents")}
                </ButtonV2>
              </Show>
            </div>
          </>
        )}
      </Show>
    </aside>
  )
}
