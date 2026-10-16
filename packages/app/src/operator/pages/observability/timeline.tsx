import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorTelemetrySpan } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../../data"
import { attrsOf, bar, treeRows } from "./model"
import { useDuration, useStatusWord } from "./parts"

// A turn's timeline (observability_spec.md §10.3): its spans as a tree on the left and bars on one time axis on the
// right. Waits are hatched and say who they waited for; errors are outlined with ✗ and their type (colour is never
// the only signal). Attempts of a step are numbered (#2, #2 retry). A subagent is collapsed; expanding it loads its
// session's turns in place, and Open opens that session in the trail. Up and Down move between rows, Right and Left
// expand and collapse, Enter opens the span panel. A long turn (over 200 rows) draws only the rows in view.

type Span = OperatorTelemetrySpan
const ROW = 28
const WINDOW = 200

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

export function TurnTimeline(props: {
  sessionID: string
  turnID: string
  selected?: string
  onSelect: (span: Span) => void
  onOpenSession: (sessionID: string) => void
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const duration = useDuration()
  const word = useStatusWord()
  const tree = useQuery(() => ({
    queryKey: api.key("telemetry-turn", props.sessionID, props.turnID),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.turn({ id: props.sessionID, turnID: props.turnID }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())
  const found = () => ready(tree)
  // Subagents start collapsed: their own session's turns load when opened.
  const shut = createMemo(() => {
    const spans = found()?.spans ?? []
    const out = new Set(collapsed())
    for (const span of spans) if (span.kind === "subagent" && !opened().has(span.id)) out.add(span.id)
    return out
  })
  const rows = createMemo(() => (found() ? treeRows(found()!.turn, found()!.spans, shut()) : []))
  const axis = createMemo(() => {
    const turn = found()?.turn
    const start = turn?.start_ms ?? 0
    const ends = [turn?.end_ms ?? Date.now(), ...(found()?.spans ?? []).map((span) => span.end_ms ?? Date.now())]
    return { from: start, to: Math.max(start + 1, ...ends) }
  })
  // Steps of the turn's model calls, by the assistant message their attempts share.
  const steps = createMemo(() => {
    const out = new Map<string, number>()
    let next = 0
    const calls = (found()?.spans ?? [])
      .filter((span) => span.kind === "model_call" && !attrsOf(span).side)
      .toSorted((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0))
    for (const call of calls) {
      const key = call.message_id ?? call.id
      if (!out.has(key)) out.set(key, ++next)
    }
    return out
  })
  const kindLabel = (span: Span) => {
    if (span.kind === "model_call" && attrsOf(span).side) return t("operator.obs.kind.side")
    return t(`operator.obs.kind.${span.kind}` as Key)
  }
  const label = (span: Span) => {
    if (span.kind !== "model_call" || attrsOf(span).side) return span.name ?? ""
    const step = steps().get(span.message_id ?? span.id)
    const attempt =
      span.attempts && span.attempts > 1 && span.attempt && span.attempt > 1 ? ` ${t("operator.obs.attemptRetry")}` : ""
    return `${span.name ?? ""}${step ? `  #${step}${attempt}` : ""}`
  }
  const note = (span: Span) => {
    if (span.kind === "permission_wait")
      return span.status === "running"
        ? t("operator.obs.waitingNow")
        : span.decision_source === "rule"
          ? t("operator.obs.decidedByRule")
          : t("operator.obs.waitedFor", {
              who: span.decided_by ?? t("operator.obs.you"),
              time: duration(span.wait_ms ?? 0),
            })
    if (span.status === "error" || span.status === "denied" || span.status === "interrupted")
      return `✗ ${span.error_type ?? word(span.status)}`
    return ""
  }
  const describe = (span: Span) =>
    t("operator.obs.barLabel", {
      name: span.name ?? kindLabel(span),
      offset: duration(Math.max(0, (span.start_ms ?? axis().from) - axis().from)),
      duration: duration(span.duration_ms ?? Math.max(0, (span.end_ms ?? Date.now()) - (span.start_ms ?? 0))),
      active: duration(span.active_ms ?? span.duration_ms ?? 0),
      status: word(span.status),
    })

  // Keyboard: move, expand, collapse, open.
  let list: HTMLDivElement | undefined
  const [focus, setFocus] = createSignal(0)
  const [scroll, setScroll] = createSignal(0)
  const windowed = () => rows().length > WINDOW
  const visible = createMemo(() => {
    if (!windowed()) return rows().map((row, index) => ({ row, index }))
    const first = Math.max(0, Math.floor(scroll() / ROW) - 10)
    return rows()
      .slice(first, first + 60)
      .map((row, at) => ({ row, index: first + at }))
  })
  const toggle = (span: Span, open: boolean) => {
    if (span.kind === "subagent") {
      const next = new Set(opened())
      if (open) next.add(span.id)
      else next.delete(span.id)
      return setOpened(next)
    }
    const next = new Set(collapsed())
    if (open) next.delete(span.id)
    else next.add(span.id)
    setCollapsed(next)
  }
  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(rows().length - 1, index))
    setFocus(clamped)
    if (windowed() && list) {
      const top = clamped * ROW
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - ROW) list.scrollTop = top - ROW * 3
    }
    const row = () => list?.querySelector<HTMLElement>(`[data-row="${clamped}"]`)
    // At once when the row is drawn (a windowed list draws it on the next frame).
    if (row()) row()!.focus()
    else requestAnimationFrame(() => row()?.focus())
  }
  const onKey = (event: KeyboardEvent, index: number, span: Span, children: number) => {
    const actions: Record<string, () => void> = {
      ArrowDown: () => focusRow(index + 1),
      ArrowUp: () => focusRow(index - 1),
      ArrowRight: () => (children || span.kind === "subagent") && toggle(span, true),
      ArrowLeft: () => (children || span.kind === "subagent") && toggle(span, false),
      Enter: () => props.onSelect(span),
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  return (
    <div data-component="operator-obs-timeline" data-testid="obs-timeline">
      <Show when={tree.isError}>
        <div data-slot="operator-error" role="alert">
          {t("operator.obs.loadFailed")}
          <ButtonV2 size="small" variant="outline" onClick={() => void tree.refetch()}>
            {t("operator.obs.retry")}
          </ButtonV2>
        </div>
      </Show>
      <div data-slot="operator-obs-axis" aria-hidden="true">
        <span />
        <span>
          <For each={[0, 0.25, 0.5, 0.75, 1]}>
            {(at) => <span style={{ left: `${at * 100}%` }}>{duration((axis().to - axis().from) * at)}</span>}
          </For>
        </span>
      </div>
      <div
        ref={list}
        role="tree"
        aria-label={t("operator.obs.timeline")}
        data-slot="operator-obs-rows"
        data-windowed={windowed() ? "" : undefined}
        style={windowed() ? { height: "560px", "overflow-y": "auto", position: "relative" } : {}}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        <div style={windowed() ? { height: `${rows().length * ROW}px`, position: "relative" } : {}}>
          <For each={visible()}>
            {(item) => {
              const span = () => item.row.span
              const place = () => bar(span(), axis(), Date.now())
              const open = () => (span().kind === "subagent" ? opened().has(span().id) : !collapsed().has(span().id))
              return (
                <>
                  <div
                    role="treeitem"
                    tabIndex={focus() === item.index ? 0 : -1}
                    aria-level={item.row.depth + 1}
                    aria-expanded={item.row.children || span().kind === "subagent" ? open() : undefined}
                    aria-selected={props.selected === span().id}
                    aria-label={describe(span())}
                    title={describe(span())}
                    data-row={item.index}
                    data-slot="operator-obs-row"
                    data-testid="obs-timeline-row"
                    data-kind={span().kind}
                    data-status={span().status ?? undefined}
                    data-selected={props.selected === span().id ? "" : undefined}
                    style={windowed() ? { position: "absolute", top: `${item.index * ROW}px`, left: 0, right: 0 } : {}}
                    onClick={() => {
                      setFocus(item.index)
                      props.onSelect(span())
                    }}
                    onKeyDown={(event) => onKey(event, item.index, span(), item.row.children)}
                  >
                    <span
                      data-slot="operator-obs-row-label"
                      style={{ "padding-inline-start": `${item.row.depth * 14}px` }}
                    >
                      <Show
                        when={item.row.children || span().kind === "subagent"}
                        fallback={<span data-slot="operator-obs-twisty" />}
                      >
                        <button
                          type="button"
                          data-slot="operator-obs-twisty"
                          tabIndex={-1}
                          aria-label={open() ? t("operator.obs.collapse") : t("operator.obs.expand")}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggle(span(), !open())
                          }}
                        >
                          <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
                        </button>
                      </Show>
                      <span data-slot="operator-obs-kind">{kindLabel(span())}</span>
                      <span data-slot="operator-obs-name">{label(span())}</span>
                      <Show when={span().kind === "subagent"}>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          onClick={(event: MouseEvent) => {
                            event.stopPropagation()
                            const child = span().id.slice("sub:".length)
                            props.onOpenSession(child)
                          }}
                        >
                          {t("operator.obs.open")}
                        </ButtonV2>
                      </Show>
                    </span>
                    <span data-slot="operator-obs-track">
                      <span
                        data-slot="operator-obs-bar"
                        data-kind={span().kind}
                        data-status={span().status ?? undefined}
                        data-hatched={span().kind === "permission_wait" ? "" : undefined}
                        style={{ left: `${place().left * 100}%`, width: `${place().width * 100}%` }}
                      >
                        <Show when={span().kind === "model_call" && span().ttft_ms && span().duration_ms}>
                          <span
                            data-slot="operator-obs-ttft"
                            style={{
                              width: `${Math.min(100, ((span().ttft_ms ?? 0) / Math.max(1, span().duration_ms ?? 1)) * 100)}%`,
                            }}
                          />
                        </Show>
                      </span>
                      <Show when={note(span())}>
                        <span data-slot="operator-obs-bar-note">{note(span())}</span>
                      </Show>
                    </span>
                  </div>
                  <Show when={span().kind === "subagent" && opened().has(span().id)}>
                    <SubagentTurns
                      sessionID={span().id.slice("sub:".length)}
                      depth={item.row.depth + 1}
                      axis={axis()}
                      selected={props.selected}
                      onSelect={props.onSelect}
                    />
                  </Show>
                </>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

/** A subagent's session's turns, in place under its row, on the parent turn's axis. */
function SubagentTurns(props: {
  sessionID: string
  depth: number
  axis: { from: number; to: number }
  selected?: string
  onSelect: (span: Span) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const word = useStatusWord()
  const detail = useQuery(() => ({
    queryKey: api.key("telemetry-session", props.sessionID, "all"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.session({ id: props.sessionID, turns: "all" }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  return (
    <Show
      when={ready(detail)}
      fallback={
        <div data-slot="operator-obs-row" data-loading="">
          <span data-slot="operator-note" style={{ "padding-inline-start": `${props.depth * 14 + 20}px` }}>
            {detail.isError ? language.t("operator.obs.loadFailed") : language.t("common.loading")}
          </span>
        </div>
      }
    >
      {(found) => (
        <For each={found().turns}>
          {(turn) => {
            const place = () => bar(turn.span, props.axis, Date.now())
            return (
              <div
                role="treeitem"
                tabIndex={-1}
                aria-level={props.depth + 1}
                data-slot="operator-obs-row"
                data-testid="obs-timeline-row"
                data-kind="turn"
                data-status={turn.span.status ?? undefined}
                data-selected={props.selected === turn.span.id ? "" : undefined}
                onClick={() => props.onSelect(turn.span)}
              >
                <span data-slot="operator-obs-row-label" style={{ "padding-inline-start": `${props.depth * 14}px` }}>
                  <span data-slot="operator-obs-twisty" />
                  <span data-slot="operator-obs-kind">{language.t("operator.obs.kind.turn")}</span>
                  <span data-slot="operator-obs-name">{turn.label ?? turn.span.name}</span>
                </span>
                <span data-slot="operator-obs-track">
                  <span
                    data-slot="operator-obs-bar"
                    data-kind="turn"
                    data-status={turn.span.status ?? undefined}
                    style={{ left: `${place().left * 100}%`, width: `${place().width * 100}%` }}
                  />
                  <Show when={turn.span.status !== "ok" && turn.span.status !== "running"}>
                    <span data-slot="operator-obs-bar-note">✗ {turn.span.error_type ?? word(turn.span.status)}</span>
                  </Show>
                </span>
              </div>
            )
          }}
        </For>
      )}
    </Show>
  )
}
