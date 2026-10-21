import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import type { OperatorHook } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready } from "../data"
import { formatAgo, shortPath } from "../format"
import { actionsOf, shownState } from "./hook-model"
import { HookRunsList, OutcomeTag } from "./hook-runs"
import { HookForm, HookRunHost, useHookActions, useHookData } from "./hooks"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// An agent's hooks (SPEC-0022 §10.3), in its overlay's Hooks tab and the agent form's Hooks section: the hooks it
// inherits, read-only with their level and lock, and Turn off for this agent unless locked; its own, with the same
// form as Capabilities → Hooks; and (in the overlay) its recent runs.
export function AgentHooks(props: { agent: string; directory: string | undefined; runs?: boolean }) {
  const language = useLanguage()
  const scope = { directory: () => props.directory, namespace: () => undefined, agent: () => props.agent }
  const data = useHookData(scope)
  const actions = useHookActions(scope)
  const [editing, setEditing] = createSignal<string>()
  const [script, setScript] = createSignal(false)
  const hooks = () => ready(data.list)?.hooks ?? []
  const own = createMemo(() => hooks().filter((hook) => hook.level === "agent"))
  const inherited = createMemo(() => hooks().filter((hook) => hook.level !== "agent"))
  const locale = () => language.intl()
  const row = (hook: OperatorHook) => (
    <>
      <strong>{hook.name}</strong> <code>{hook.event}</code>{" "}
      <span data-slot="operator-note" title={hook.file}>
        {language.t(`operator.levels.level.${hook.level}` as Key)} · {shortPath(hook.file)}
      </span>{" "}
      <span data-state={shownState(hook, "agent")}>
        {language.t(`operator.hooks.state.${shownState(hook, "agent")}` as Key)}
      </span>
      <Show when={hook.lastRun}>
        {(last) => (
          <span class="inline-flex items-center gap-1">
            {formatAgo(last().time, locale())} <OutcomeTag outcome={last().outcome} />
          </span>
        )}
      </Show>
    </>
  )
  return (
    <div data-component="operator-agent-hooks" data-testid="agent-hooks">
      <Show when={ready(data.list)?.paused}>
        <p data-slot="operator-note" data-warning="">
          {language.t("operator.hooks.paused")}
        </p>
      </Show>
      <section data-component="operator-panel">
        <h3 data-slot="operator-panel-title">{language.t("operator.hooks.agent.own")}</h3>
        <Show
          when={own().length}
          fallback={<p data-slot="operator-note">{language.t("operator.hooks.agent.noOwn")}</p>}
        >
          <ul data-slot="operator-plain-list">
            <For each={own()}>
              {(hook) => (
                <li data-testid="agent-own-hook">
                  {row(hook)}{" "}
                  <ButtonV2 size="small" variant="ghost" onClick={() => setEditing(hook.name)}>
                    {language.t("operator.hooks.edit")}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    onClick={() => void actions.remove(hook, script(), () => setEditing(undefined))}
                  >
                    {language.t("operator.hooks.delete")}
                  </ButtonV2>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show
          when={editing()}
          fallback={
            <ButtonV2 size="small" variant="outline" onClick={() => setEditing("@new")}>
              {language.t("operator.hooks.agent.add")}
            </ButtonV2>
          }
        >
          {(name) => (
            <HookForm
              scope={scope}
              view={ready(data.list)}
              hook={name() === "@new" ? undefined : own().find((hook) => hook.name === name())}
              onDone={() => setEditing(undefined)}
              onCancel={() => setEditing(undefined)}
            />
          )}
        </Show>
        <Show when={own().length}>
          <CheckboxV2
            label={language.t("operator.hooks.removeScript")}
            checked={script()}
            onChange={(value: boolean) => setScript(value)}
          />
        </Show>
      </section>
      <section data-component="operator-panel">
        <h3 data-slot="operator-panel-title">{language.t("operator.hooks.agent.inherited")}</h3>
        <Show
          when={inherited().length}
          fallback={<p data-slot="operator-note">{language.t("operator.hooks.agent.noInherited")}</p>}
        >
          <ul data-slot="operator-plain-list">
            <For each={inherited()}>
              {(hook) => (
                <li data-testid="agent-inherited-hook">
                  {row(hook)}{" "}
                  <Show when={actionsOf(hook, "agent").turnOff}>
                    <ButtonV2 size="small" variant="ghost" onClick={() => void actions.setState(hook.name, true)}>
                      {language.t("operator.hooks.agent.turnOff")}
                    </ButtonV2>
                  </Show>
                  <Show when={actionsOf(hook, "agent").turnOn}>
                    <ButtonV2 size="small" variant="ghost" onClick={() => void actions.setState(hook.name, false)}>
                      {language.t("operator.hooks.agent.turnOn")}
                    </ButtonV2>
                  </Show>
                  <Show when={hook.locked}>
                    <span data-slot="operator-note"> 🔒 {language.t("operator.hooks.agent.locked")}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <Show when={props.runs}>
        <section data-component="operator-panel">
          <h3 data-slot="operator-panel-title">{language.t("operator.hooks.agent.runs")}</h3>
          <HookRunsList
            source={{ directory: () => props.directory, agent: () => props.agent }}
            testid="agent-hook-runs"
          />
          <HookRunHost directory={() => props.directory} />
        </section>
      </Show>
    </div>
  )
}
