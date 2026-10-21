import { partView, renderable, type MessagePartProps } from "@opencode-ai/session-ui/message-part"
import { useData } from "@opencode-ai/session-ui/context"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { HookMarks } from "./hook-marks-view"
import { useSessionView } from "./view"

// The Detailed view: the chat as it is, plus what it hides. The fork seam in session-ui's
// message-part.tsx (`partView`) lets reasoning show whatever the setting, shows todo updates, and
// after the last part of each answer (one assistant message is one model step) shows the step's
// marker: its model, tokens, cost and time, from the call record when the session was recorded (else
// from the message), with "Open in Transcript".

// While mounted (the operator sidebar mounts it), the session page's parts follow the view.
export function useDetailedParts() {
  const view = useSessionView()
  const detailed = () => view.view() === "detailed"
  // What hooks did to a tool call shows in every view (hook-marks-view.tsx); the step marker in Detailed only.
  const after = (props: MessagePartProps) => [
    <HookMarks part={props.part} />,
    <StepMarkerAfter part={props.part} message={props.message} />,
  ]
  const previous = { detailed: partView.detailed, after: partView.after }
  partView.detailed = detailed
  partView.after = after
  onCleanup(() => {
    if (partView.detailed === detailed) partView.detailed = previous.detailed
    if (partView.after === after) partView.after = previous.after
  })
}

type Assistant = {
  id: string
  role: string
  sessionID: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

// The step's marker, after the last part of its assistant message, in the Detailed view only.
function StepMarkerAfter(props: { part: MessagePartProps["part"]; message: MessagePartProps["message"] }) {
  const data = useData()
  const view = useSessionView()
  const last = createMemo(() => {
    if (view.view() !== "detailed" || props.message.role !== "assistant") return false
    const parts = (data.store.part?.[props.message.id] ?? []) as MessagePartProps["part"][]
    return parts.filter((part) => renderable(part, true)).at(-1)?.id === props.part.id
  })
  return (
    <Show when={last()}>
      <StepMarker message={props.message as unknown as Assistant} />
    </Show>
  )
}

function StepMarker(props: { message: Assistant }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const view = useSessionView()
  const session = useQuery(() => ({
    queryKey: api.key("session", props.message.sessionID),
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: props.message.sessionID })
        .then((result) => result.data!),
  }))
  const calls = useQuery(() => ({
    queryKey: api.key("calls", props.message.sessionID),
    enabled: !!session.data?.directory,
    queryFn: () =>
      api
        .client()
        .operator.call.list({ sessionID: props.message.sessionID, directory: session.data?.directory })
        .then((result) => result.data!),
  }))
  // The recorded call of this step: the agent call that wrote this assistant message.
  const call = createMemo(() =>
    calls.data?.calls.findLast((item) => item.assistantMessageID === props.message.id && item.kind === "agent"),
  )
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  const text = () => {
    const tokens = props.message.tokens ?? {}
    const recorded = call()
    const out: string[] = [
      recorded?.step !== undefined
        ? language.t("operator.detailed.step", { step: recorded.step })
        : language.t("operator.detailed.stepPlain"),
    ]
    const model =
      recorded?.model ?? (props.message.modelID ? `${props.message.providerID}/${props.message.modelID}` : undefined)
    if (model) out.push(model)
    const input = recorded?.usage?.input ?? tokens.input
    const cache = recorded?.usage?.cacheRead ?? tokens.cache?.read
    if (input !== undefined)
      out.push(
        cache
          ? language.t("operator.transcript.inCache", { input: number(input), cache: number(cache) })
          : language.t("operator.transcript.in", { input: number(input) }),
      )
    const output = recorded?.usage?.output ?? tokens.output
    if (output !== undefined) out.push(language.t("operator.transcript.out", { output: number(output) }))
    const reasoning = recorded?.usage?.reasoning ?? tokens.reasoning
    if (reasoning) out.push(language.t("operator.transcript.reasoningTokens", { count: number(reasoning) }))
    const cost = recorded?.cost ?? props.message.cost
    if (cost !== undefined) out.push(`$${cost.toFixed(4)}`)
    if (recorded?.finishedAt) out.push(`${((recorded.finishedAt - recorded.startedAt) / 1000).toFixed(1)} s`)
    return out.join(" · ")
  }
  return (
    <div data-component="operator-step-marker" data-testid="step-marker">
      <span>{text()}</span>
      <Show when={call()}>
        {(found) => (
          <button type="button" data-slot="operator-link" onClick={() => view.set("transcript", found().callID)}>
            {language.t("operator.detailed.openTranscript")}
          </button>
        )}
      </Show>
    </div>
  )
}
