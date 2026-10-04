import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { OperatorPromptAssembledSection } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatCount, shortPath } from "../format"
import { Field } from "../ui/field"
import { ScopePicker } from "../ui/scope-picker"
import { requestError } from "./config-helpers"

// The model option that means "whatever the agent uses".
const AGENT_MODEL = "agent"

// The whole system prompt an agent sends with a model from a folder, section by section, with where
// each part comes from and where to change it. Nothing is added that is not listed here.
export function AgentPrompt(props: { agent: string; directory: string }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const [store, setStore] = createStore({ model: AGENT_MODEL })

  const providers = useQuery(() => ({
    queryKey: api.key("providers", props.directory),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: props.directory })
        .then((result) => result.data!),
  }))
  const models = createMemo(() => [
    AGENT_MODEL,
    ...(providers.data?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => `${provider.id}/${model.id}`),
    ),
  ])

  const preview = useQuery(() => ({
    queryKey: api.key("prompt-preview", props.directory, props.agent, store.model),
    queryFn: () => {
      const [provider, ...rest] = store.model.split("/")
      return api
        .client()
        .operator.prompt.preview({
          directory: props.directory,
          agent: props.agent,
          ...(store.model === AGENT_MODEL ? {} : { provider, model: rest.join("/") }),
        })
        .then((result) => result.data!)
    },
  }))

  // A layer on the Prompt Profile page.
  const open = (layer: string) => navigate(`/operator/profile?view=layers&layer=${encodeURIComponent(layer)}`)

  const source = (section: OperatorPromptAssembledSection) =>
    section.source.startsWith("/") ? shortPath(section.source) : section.source

  // Where to change a section's text.
  const action = (section: OperatorPromptAssembledSection) => {
    if (section.layer === "slot.agent")
      return {
        label: language.t("operator.prompts.editAgent"),
        run: () =>
          navigate(
            `/operator/agents/${encodeURIComponent(props.agent)}/edit?dir=${encodeURIComponent(props.directory)}`,
          ),
      }
    if (section.layer === "generated.instructions")
      return {
        label: language.t("operator.prompts.openMemory"),
        run: () => navigate(`/operator/memory?dir=${encodeURIComponent(props.directory)}`),
      }
    return { label: language.t("operator.prompts.edit"), run: () => open(section.layer) }
  }

  return (
    <>
      <section data-component="operator-panel">
        <div data-slot="operator-form-row">
          <Field group label={language.t("operator.prompts.folder")} hint={language.t("operator.prompts.folderHint")}>
            <ScopePicker />
          </Field>
          <Field group label={language.t("operator.column.model")} hint={language.t("operator.prompts.modelHint")}>
            <SelectV2<string>
              appearance="base"
              options={models()}
              current={store.model}
              label={(value) => (value === AGENT_MODEL ? language.t("operator.prompts.agentModel") : value)}
              onSelect={(value) => value && setStore("model", value)}
            />
          </Field>
        </div>
      </section>

      <Show when={preview.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(preview.error)}
        </pre>
        <p data-slot="operator-note">{language.t("operator.prompts.previewFailed")}</p>
      </Show>
      <Show when={preview.data}>
        {(data) => (
          <>
            <dl data-component="operator-facts">
              <dt>{language.t("operator.prompts.project")}</dt>
              <dd>{data().project.name}</dd>
              <dt>{language.t("operator.prompts.profile")}</dt>
              <dd>{data().profile.name}</dd>
              <dt>{language.t("operator.prompts.mode")}</dt>
              <dd>{language.t(`operator.prompts.mode.${data().mode}`)}</dd>
            </dl>
            <p data-slot="operator-note">
              {language.t("operator.prompts.summary", {
                model: data().model,
                count: data().sections.length,
                chars: formatCount(
                  data().system.reduce((total, item) => total + item.length, 0),
                  language.intl(),
                ),
              })}
            </p>
            <For each={data().sections}>
              {(section) => (
                <section data-component="operator-panel" data-slot="operator-prompt-section">
                  <div data-slot="operator-panel-head">
                    <span class="flex items-center gap-2 min-w-0 flex-wrap">
                      <Tag variant={section.message === 1 ? "accent" : "neutral"}>{section.groupName}</Tag>
                      <span data-slot="operator-layer-name">{section.layerName}</span>
                      <Show when={section.mandatory}>
                        <Tag>{language.t("operator.prompts.mandatory")}</Tag>
                      </Show>
                      <span data-slot="operator-cell-clamp" title={section.source}>
                        {source(section)}
                      </span>
                      <span data-slot="operator-note">
                        {language.t("operator.prompts.chars", {
                          count: formatCount(section.text.length, language.intl()),
                        })}
                      </span>
                    </span>
                    <Show when={action(section)}>
                      {(item) => (
                        <ButtonV2 size="small" variant="outline" onClick={item().run}>
                          {item().label}
                        </ButtonV2>
                      )}
                    </Show>
                  </div>
                  <pre data-component="operator-code">{section.text}</pre>
                </section>
              )}
            </For>
            <section data-component="operator-panel">
              <h2 data-slot="operator-panel-title">{language.t("operator.prompts.perTurn")}</h2>
              <p data-slot="operator-note">{language.t("operator.prompts.perTurnHint")}</p>
              <ButtonV2 size="small" variant="outline" onClick={() => open("reminder.plan")}>
                {language.t("operator.prompts.perTurnOpen")}
              </ButtonV2>
            </section>
            <details data-slot="operator-details">
              <summary>{language.t("operator.prompts.raw", { count: data().system.length })}</summary>
              <For each={data().system}>{(message) => <pre data-component="operator-code">{message}</pre>}</For>
            </details>
          </>
        )}
      </Show>
    </>
  )
}
