import type { OperatorModelSource, OperatorPromptTraceStep } from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// What OpenCode's own skills give as their location.
const BUILTIN_SKILL = "<built-in>"

// One step of how a prompt text was resolved, as a line: what was decided, the layer it is in, the file.
export function useTraceText() {
  const language = useLanguage()
  return (step: OperatorPromptTraceStep) =>
    step.kind === "skill" && step.path === BUILTIN_SKILL
      ? language.t("operator.trace.skillBuiltin")
      : language.t(`operator.trace.${step.kind}` as Key, {
          name: step.name ?? "",
          path: step.path ?? "",
          detail: step.detail ?? "",
        })
}

// How a section of a prompt (or a sample) was resolved, down to the file its text is in.
export function TraceList(props: { trace: ReadonlyArray<OperatorPromptTraceStep>; label?: string }) {
  const language = useLanguage()
  const text = useTraceText()
  return (
    <Show when={props.trace.length}>
      <div data-slot="operator-trace" data-testid="prompt-trace">
        <strong>{props.label ?? language.t("operator.trace.resolvedFrom")}</strong>
        <ol>
          <For each={props.trace}>{(step) => <li data-kind={step.kind}>{text(step)}</li>}</For>
        </ol>
      </div>
    </Show>
  )
}

// Where a model comes from, as a line.
export function useModelSourceText() {
  const language = useLanguage()
  return (source: OperatorModelSource) => {
    const key = `operator.modelSource.${source.source}${source.path ? "In" : ""}` as Key
    const parts = [language.t(key, { path: source.path ?? "" })]
    if (source.unavailable) parts.push(language.t("operator.modelSource.unavailable"))
    if (source.agent)
      parts.push(
        language.t(
          source.agent.path ? "operator.modelSource.agentUnavailableIn" : "operator.modelSource.agentUnavailable",
          {
            model: source.agent.model,
            path: source.agent.path ?? "",
          },
        ),
      )
    return parts.join(" · ")
  }
}

// A model and where it comes from: the agent's own setting, the default model, or OpenCode's own choice.
export function ModelWithSource(props: { source: OperatorModelSource | undefined; compact?: boolean }) {
  const language = useLanguage()
  const text = useModelSourceText()
  return (
    <Show when={props.source} fallback="—">
      {(found) => (
        <span class="flex flex-col gap-0.5" data-testid="model-source">
          <span>{found().model || language.t("operator.modelSource.none")}</span>
          <Show when={!props.compact}>
            <span
              data-slot="operator-note"
              data-warning={found().source === "ranking" || found().unavailable || found().agent ? "" : undefined}
            >
              {text(found())}
            </span>
          </Show>
          <Show when={props.compact}>
            <span data-slot="operator-note">{language.t(`operator.modelSource.short.${found().source}` as Key)}</span>
          </Show>
        </span>
      )}
    </Show>
  )
}
