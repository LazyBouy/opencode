import type { OperatorCallSummary } from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { type ListStep, type ListTurn, type Selection, statusOf } from "./transcript-model"

type Language = ReturnType<typeof useLanguage>
type Key = Parameters<Language["t"]>[0]

// Call details' left list (transcript_view_spec_v2.md §2.2): "All turns", then each turn with its calls
// under it, a step's attempts grouped under the step. Picking a line shows only that in the pane.
export function TurnList(props: {
  turns: ListTurn[]
  selection: Selection | undefined
  filtering: boolean
  kindText: (call: OperatorCallSummary) => string
  onPick: (value: string) => void
  ref?: (element: HTMLElement) => void
  onScroll?: (top: number) => void
}) {
  const language = useLanguage()
  const turnLine = (entry: ListTurn) => {
    const turn = entry.turn
    const count =
      turn.calls.length === 1
        ? language.t("operator.accounting.oneCall")
        : language.t("operator.accounting.calls", { count: turn.calls.length })
    const status = turn.status === "ok" ? [] : [language.t(`operator.transcript.list.status.${turn.status}` as Key)]
    if (!turn.index) return [language.t("operator.accounting.turnOther"), count, ...status].join(" · ")
    return [
      language.t("operator.accounting.turn", { index: turn.index }),
      language.t("operator.transcript.list.quoted", { text: turn.text }),
      count,
      ...status,
    ].join(" · ")
  }
  const stepLine = (step: ListStep) => {
    const calls = step.calls
    const last = calls.at(-1)!
    const statuses = [...new Set(calls.flatMap((call) => (typeof statusOf(call) === "number" ? [statusOf(call)] : [])))]
    const outcome = calls.some((call) => !call.failed && !call.receiving)
      ? language.t("operator.transcript.list.succeeded")
      : last.receiving
        ? language.t("operator.transcript.list.retrying")
        : language.t("operator.transcript.list.allFailed", { statuses: statuses.join(", ") || "…" })
    const attempts = Math.max(last.attempts, calls.length)
    return language.t("operator.transcript.list.step", { step: step.step ?? "?", attempts, outcome })
  }
  const callLine = (call: OperatorCallSummary, attempt: boolean) => {
    const status = statusOf(call)
    const what = attempt
      ? language.t("operator.transcript.list.attemptWord", { attempt: call.attempt })
      : call.kind === "agent" && call.step !== undefined
        ? language.t("operator.transcript.list.stepWord", { step: call.step })
        : props.kindText(call)
    return language.t("operator.transcript.list.call", {
      index: call.index,
      what,
      status: typeof status === "number" ? String(status) : language.t(`operator.transcript.list.${status}` as Key),
    })
  }
  const active = (value: string) => {
    const selection = props.selection
    if (!selection) return false
    if (selection.kind === "all") return value === "all"
    if (selection.kind === "turn") return value === `turn:${selection.turn}`
    return value === `call:${selection.callID}`
  }
  const CallLine = (line: { call: OperatorCallSummary; attempt: boolean }) => (
    <button
      type="button"
      data-slot="operator-transcript-list-call"
      data-depth={line.attempt ? "2" : "1"}
      data-active={active(`call:${line.call.callID}`) ? "" : undefined}
      data-status={line.call.failed ? "failed" : line.call.receiving ? "running" : "ok"}
      data-testid="transcript-list-call"
      onClick={() => props.onPick(`call:${line.call.callID}`)}
    >
      {callLine(line.call, line.attempt)}
    </button>
  )
  return (
    <nav
      data-slot="operator-transcript-list"
      data-testid="transcript-list"
      aria-label={language.t("operator.transcript.list")}
      ref={(element) => props.ref?.(element)}
      onScroll={(event) => props.onScroll?.(Math.round(event.currentTarget.scrollTop))}
    >
      <button
        type="button"
        data-slot="operator-transcript-list-turn"
        data-active={active("all") ? "" : undefined}
        data-testid="transcript-list-all"
        onClick={() => props.onPick("all")}
      >
        {language.t("operator.transcript.allTurns")}
      </button>
      <For each={props.turns}>
        {(entry) => (
          <Show when={!props.filtering || entry.calls.length}>
            <button
              type="button"
              data-slot="operator-transcript-list-turn"
              data-active={active(`turn:${entry.turn.index}`) ? "" : undefined}
              data-status={entry.turn.status}
              data-testid="transcript-list-turn"
              onClick={() => props.onPick(`turn:${entry.turn.index}`)}
            >
              {turnLine(entry)}
            </button>
            <For each={entry.steps}>
              {(step) => (
                <Show when={step.calls.length > 1} fallback={<CallLine call={step.calls[0]!} attempt={false} />}>
                  <div
                    data-slot="operator-transcript-list-step"
                    data-status={step.calls.some((call) => !call.failed) ? "ok" : "failed"}
                    data-testid="transcript-list-step"
                  >
                    {stepLine(step)}
                  </div>
                  <For each={step.calls}>{(call) => <CallLine call={call} attempt />}</For>
                </Show>
              )}
            </For>
          </Show>
        )}
      </For>
    </nav>
  )
}
