import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { FieldHelp } from "../ui/field-help"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// The Sys Prompt tab's "Hooks" block (SPEC-0022 §8.3, ADR-0002 as amended): hook context is a declared prompt
// source, so the tab lists every hook in force for the agent whose event can add text to the conversation: its
// name, event, level and file. Nothing a hook adds is hidden: the session views mark each text as the hook's.
export function AgentPromptHooks(props: { agent: string; directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const hooks = useQuery(() => ({
    queryKey: api.key("hooks", props.directory, props.agent),
    enabled: !!props.directory,
    queryFn: () =>
      api
        .client()
        .operator.hook.list({ directory: props.directory, agent: props.agent })
        .then((result) => result.data!),
  }))
  const events = useQuery(() => ({
    queryKey: api.key("hook-events"),
    queryFn: () =>
      api
        .client()
        .operator.hook.events()
        .then((result) => result.data!),
    staleTime: Infinity,
  }))
  const adding = createMemo(() => {
    const context = new Set<string>(
      (events.data ?? []).filter((item) => item.fields.includes("context")).map((item) => item.name),
    )
    return (hooks.data?.hooks ?? []).filter((hook) => hook.state === "on" && context.has(hook.event))
  })
  return (
    <section data-component="operator-panel" data-testid="agent-prompt-hooks">
      <h3 data-slot="operator-panel-title">
        {language.t("operator.hooks.prompt.title")}
        <FieldHelp field={language.t("operator.hooks.prompt.title")} text={language.t("operator.hooks.prompt.help")} />
      </h3>
      <Show when={hooks.data?.paused}>
        <p data-slot="operator-note">{language.t("operator.hooks.paused")}</p>
      </Show>
      <Show
        when={adding().length}
        fallback={
          <Show when={hooks.data}>
            <p data-slot="operator-note">{language.t("operator.hooks.prompt.none")}</p>
          </Show>
        }
      >
        <ul data-slot="operator-plain-list">
          <For each={adding()}>
            {(hook) => (
              <li data-testid="agent-prompt-hook">
                <strong>{hook.name}</strong> <Tag>{hook.event}</Tag>{" "}
                <span>
                  {language.t("operator.hooks.prompt.where", {
                    level: language.t(`operator.levels.level.${hook.level}` as Key),
                    file: shortPath(hook.file),
                  })}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
