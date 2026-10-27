import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { OperatorCallSummary, OperatorHookRun } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import type { Mark } from "./hook-marks"
import { HookMarkList, MessageHookMarks } from "./hook-marks-view"
import { MessageMarkView } from "./messages-view"
import { useSessionHookRuns } from "./hook-runs"
import { useSessionView } from "./view"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type UserMessage = { id: string; sessionID: string; system?: string; options?: ModelOptions }
type ModelOptions = {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
}
type Part = { id: string; type: string; text?: string; synthetic?: boolean; metadata?: Record<string, unknown> }

// The Detailed view, under a user message: what the chat hides about that exchange. OpenCode's own texts
// saved with the message (synthetic parts), the texts it added to the exchange's requests in memory (not
// saved; from the call records), and its side calls, retries and errors, each linked to the Transcript.
// Nothing in the other views.
// In every view, what hooks did to the message (hook-marks-view.tsx), and who sent it when another agent did
// (messages-view.tsx).
export function UserExtras(props: { message: UserMessage; parts: () => ReadonlyArray<Part> }) {
  const view = useSessionView()
  return (
    <>
      <MessageMarkView parts={props.parts} />
      <MessageHookMarks parts={props.parts} />
      <Show when={props.parts().some((part) => part.type === "compaction")}>
        <CompactionHookMarks message={props.message} />
      </Show>
      <Show when={view.view() === "detailed"}>
        <Extras message={props.message} parts={props.parts} />
      </Show>
    </>
  )
}

function Extras(props: { message: UserMessage; parts: () => ReadonlyArray<Part> }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const view = useSessionView()
  const synthetic = createMemo(() =>
    // A hook's context is marked as the hook's (above), not as OpenCode's.
    props.parts().filter((part) => part.type === "text" && part.synthetic && part.text?.trim() && !part.metadata?.hook),
  )
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
  const mine = createMemo(() => (calls.data?.calls ?? []).filter((call) => call.userMessageID === props.message.id))
  // Each in-memory text once, with the first call that carried it.
  const added = createMemo(() => {
    const seen = new Map<string, OperatorCallSummary>()
    for (const call of mine()) for (const id of call.added) if (!seen.has(id)) seen.set(id, call)
    return [...seen]
  })
  const side = createMemo(() => mine().filter((call) => call.kind !== "agent" || call.failed))
  const open = (call: OperatorCallSummary) => (
    <button type="button" data-slot="operator-link" onClick={() => view.set("transcript", call.callID)}>
      {language.t("operator.detailed.openTranscript")}
    </button>
  )
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  // The model options and system text the message was sent with (SPEC-0025), for the requests that answer it.
  const options = createMemo(() =>
    OPTION_KEYS.flatMap((key) => {
      const value = props.message.options?.[key]
      if (value === undefined) return []
      return [language.t(`operator.detailed.option.${key}`, { value: key === "seed" ? String(value) : number(value) })]
    }),
  )
  const system = () => props.message.system?.trim()

  return (
    <div data-component="operator-user-extras" data-testid="detailed-extras">
      <Show when={system()}>
        {(text) => (
          <details data-slot="operator-extra" data-kind="system" data-testid="detailed-system">
            <summary>
              <Tag>{language.t("operator.detailed.messageSystem")}</Tag> {firstLine(text())}
            </summary>
            <pre data-component="operator-code">{text()}</pre>
          </details>
        )}
      </Show>
      <Show when={options().length > 0}>
        <div data-slot="operator-extra" data-kind="options" data-testid="detailed-options">
          <Tag>{language.t("operator.detailed.options")}</Tag>
          <span data-slot="operator-note">{options().join(" · ")}</span>
        </div>
      </Show>
      <For each={synthetic()}>
        {(part) => (
          <details data-slot="operator-extra" data-kind="synthetic">
            <summary>
              <Tag>{language.t("operator.detailed.synthetic")}</Tag> {firstLine(part.text ?? "")}
            </summary>
            <pre data-component="operator-code">{part.text}</pre>
          </details>
        )}
      </For>
      <For each={added()}>
        {([id, call]) => (
          <div data-slot="operator-extra" data-kind="in-memory" data-testid="detailed-added">
            <Tag data-warning="">{language.t("operator.transcript.mark.in-memory")}</Tag>
            <span>{language.t(`operator.detailed.added.${id}` as Key)}</span>
            {open(call)}
          </div>
        )}
      </For>
      <For each={side()}>
        {(call) => (
          <div
            data-slot="operator-extra"
            data-kind={call.error ? "error" : call.failed ? "retry" : call.kind}
            data-testid="detailed-side"
          >
            <Tag data-warning={call.failed ? "" : undefined}>
              {call.error
                ? language.t("operator.transcript.error", {
                    status: String(call.error.status ?? call.httpStatus ?? ""),
                  })
                : call.failed
                  ? language.t("operator.transcript.attempt", { attempt: call.attempt, attempts: call.attempts })
                  : language.t(`operator.transcript.kind.${call.kind}` as Key)}
            </Tag>
            <span data-slot="operator-note">
              {[
                call.model,
                call.usage?.input !== undefined
                  ? language.t("operator.transcript.in", { input: number(call.usage.input) })
                  : "",
                call.usage?.output !== undefined
                  ? language.t("operator.transcript.out", { output: number(call.usage.output) })
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {open(call)}
          </div>
        )}
      </For>
    </div>
  )
}

// A compaction's request: what compaction.before hooks added to what it was given, and a compaction.after hook that
// stopped the automatic "continue" turn (from the run log, which keeps each run with the compaction's message).
function CompactionHookMarks(props: { message: UserMessage }) {
  const api = useOperatorClient()
  const session = useQuery(() => ({
    queryKey: api.key("session", props.message.sessionID),
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: props.message.sessionID })
        .then((result) => result.data!),
  }))
  const directory = () => session.data?.directory
  const before = useSessionHookRuns(() => props.message.sessionID, directory, "compaction.before")
  const after = useSessionHookRuns(() => props.message.sessionID, directory, "compaction.after")
  const marks = createMemo((): Mark[] => {
    const mine = (runs: ReadonlyArray<OperatorHookRun> | undefined) =>
      (runs ?? []).filter((run) => run.messageID === props.message.id).toReversed()
    const by = (run: OperatorHookRun) => ({ hook: run.hook, level: run.level, file: run.file, run: run.id })
    return [
      ...mine(before.data?.runs).flatMap((run): Mark[] =>
        run.context !== undefined ? [{ kind: "context", by: by(run), event: run.event, text: run.context }] : [],
      ),
      ...mine(after.data?.runs).flatMap((run): Mark[] =>
        run.outcome === "denied" ? [{ kind: "no-continue", by: by(run) }] : [],
      ),
    ]
  })
  return <HookMarkList marks={marks()} testid="compaction-hook-marks" />
}

const OPTION_KEYS = ["temperature", "topP", "maxOutputTokens", "frequencyPenalty", "presencePenalty", "seed"] as const

function firstLine(text: string) {
  const line = text.split("\n").find((item) => item.trim()) ?? ""
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}
