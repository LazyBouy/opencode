import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { OperatorToolPromptDraft } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import type { Rule } from "./rules"

// How long the rules must stay unchanged before the impact is rebuilt.
const DEBOUNCE = 300

// The tool prompt impact of unsaved permission rules: the tool prompt built from them (the agent's
// default model; the agent's default way of running, or the session), against the saved state. Tools
// added or removed, each with the rule that caused it; descriptions that changed (task's subagent
// list); and the total size change. Patterns never change what is sent, so changing only patterns
// shows no change.
export function PermissionImpact(props: {
  agent: string
  directory: string
  sessionID?: string
  // The unsaved rules: the agent's own, or the session's own.
  agentRules?: ReadonlyArray<Rule>
  sessionRules?: ReadonlyArray<Rule>
  // Whether the rules differ from the saved ones.
  dirty: boolean
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const draft = () => JSON.stringify({ agent: props.agentRules, session: props.sessionRules })
  const [settled, setSettled] = createSignal(draft())
  createEffect(
    on(draft, (value) => {
      const timer = setTimeout(() => setSettled(value), DEBOUNCE)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  const impact = useQuery(() => ({
    queryKey: api.key("tool-prompt-draft", props.directory, props.agent, props.sessionID, settled()),
    enabled: props.dirty,
    queryFn: () => {
      const rules = JSON.parse(settled()) as { agent?: Rule[]; session?: Rule[] }
      return api
        .client()
        .operator.toolPrompt.draft({
          name: props.agent,
          directory: props.directory,
          ...(rules.agent ? { agentRules: rules.agent } : {}),
          ...(props.sessionID ? { sessionID: props.sessionID, sessionRules: rules.session ?? [] } : {}),
        })
        .then((result) => result.data!)
    },
  }))
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)

  return (
    <aside data-slot="operator-permission-impact" data-testid="permission-impact">
      <h3 data-slot="operator-panel-title">{language.t("operator.impact.title")}</h3>
      <Show when={props.dirty} fallback={<p data-slot="operator-note">{language.t("operator.impact.noChanges")}</p>}>
        <Show when={impact.error}>
          <pre data-slot="operator-error" role="alert">
            {requestError(impact.error)}
          </pre>
        </Show>
        <Show
          when={impact.data}
          fallback={
            <p data-slot="operator-note">{`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}</p>
          }
        >
          {(data) => <Diff data={data()} number={number} />}
        </Show>
      </Show>
    </aside>
  )
}

function Diff(props: { data: OperatorToolPromptDraft; number: (value: number) => string }) {
  const language = useLanguage()
  const diff = () => props.data.diff
  const delta = () => diff().after - diff().before
  const none = () => !diff().added.length && !diff().removed.length && !diff().changed.length && delta() === 0
  const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${props.number(Math.abs(value))}`
  return (
    <Show
      when={!none()}
      fallback={
        <div data-testid="impact-none">
          <p data-slot="operator-note">{language.t("operator.impact.none")}</p>
          <p data-slot="operator-note">{language.t("operator.toolPrompt.patterns")}</p>
        </div>
      }
    >
      <ul data-component="operator-list" data-testid="impact-tools">
        <For each={diff().removed}>
          {(item) => (
            <li data-change="removed">
              <span class="inline-flex items-center gap-1">
                <Tag>{language.t("operator.impact.removed")}</Tag>
                <code>{item.name}</code>
              </span>
              <Show when={item.rule !== undefined}>
                <span data-slot="operator-note">{language.t("operator.impact.byRule", { rule: item.rule ?? 0 })}</span>
              </Show>
            </li>
          )}
        </For>
        <For each={diff().added}>
          {(item) => (
            <li data-change="added">
              <span class="inline-flex items-center gap-1">
                <Tag variant="accent">{language.t("operator.impact.added")}</Tag>
                <code>{item.name}</code>
              </span>
              <Show when={item.rule !== undefined}>
                <span data-slot="operator-note">{language.t("operator.impact.byRule", { rule: item.rule ?? 0 })}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <For each={diff().changed}>
        {(item) => (
          <div data-slot="operator-impact-change">
            <p data-slot="operator-note">{language.t("operator.impact.descriptionChanged", { name: item.name })}</p>
            <pre data-component="operator-code" data-slot="operator-text-diff">
              <For each={lineDiff(item.before, item.after)}>
                {(line) => <span data-change={line.change}>{`${line.mark} ${line.text}\n`}</span>}
              </For>
            </pre>
          </div>
        )}
      </For>
      <p data-slot="operator-note" data-testid="impact-size">
        {language.t("operator.impact.size", {
          chars: signed(delta()),
          tokens: signed(Math.ceil(diff().after / 4) - Math.ceil(diff().before / 4)),
          total: props.number(diff().after),
        })}
      </p>
    </Show>
  )
}

// The lines one text has and the other doesn't: enough to show what a subagent list gained or lost.
export function lineDiff(before: string, after: string) {
  const old = before.split("\n")
  const next = after.split("\n")
  const kept = new Set(old.filter((line) => next.includes(line)))
  return [
    ...old.filter((line) => !kept.has(line)).map((text) => ({ change: "removed", mark: "−", text })),
    ...next.filter((line) => !kept.has(line)).map((text) => ({ change: "added", mark: "+", text })),
  ]
}
