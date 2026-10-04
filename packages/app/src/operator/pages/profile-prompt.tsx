import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import type { OperatorPromptSection } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatCount, shortPath } from "../format"
import { Field } from "../ui/field"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { useAgents } from "./agents"
import { requestError } from "./config-helpers"
import { usePromptCatalog } from "./profile-texts"

type Toggle = "environment" | "skills" | "mcp"
const TOGGLES: Toggle[] = ["environment", "skills", "mcp"]

// The section kinds a switch turns off; references go with the environment block.
const toggleFor = (kind: OperatorPromptSection["kind"]): Toggle | undefined =>
  kind === "references" ? "environment" : TOGGLES.find((item) => item === kind)

// The whole system prompt an agent sends with a model in this project, section by section, with
// where each part comes from and where to change it. Nothing is added that is not listed here.
export function FullPrompt(props: { directory: string; onEdit: (tab: "texts" | "identity", id?: string) => void }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const agents = useAgents()
  const catalog = usePromptCatalog(() => props.directory)
  const [store, setStore] = createStore({ agent: "build", model: "", scope: "project" as Scope, busy: false })

  const providers = useQuery(() => ({
    queryKey: api.key("providers", props.directory),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: props.directory })
        .then((result) => result.data!),
  }))
  const models = createMemo(() => [
    "",
    ...(providers.data?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => `${provider.id}/${model.id}`),
    ),
  ])
  const agentNames = createMemo(() => (agents.data ?? []).filter((agent) => !agent.disabled).map((agent) => agent.name))

  const preview = useQuery(() => ({
    queryKey: api.key("prompt-preview", props.directory, store.agent, store.model),
    queryFn: () => {
      const [provider, ...rest] = store.model.split("/")
      return api
        .client()
        .operator.prompt.preview({
          directory: props.directory,
          agent: store.agent,
          ...(store.model ? { provider, model: rest.join("/") } : {}),
        })
        .then((result) => result.data!)
    },
  }))

  const toggle = async (name: Toggle, value: boolean) => {
    setStore("busy", true)
    await api
      .client()
      .operator.config.update({ directory: props.directory, scope: store.scope, body: { prompts: { [name]: value } } })
      .then(() =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: api.key("prompt-catalog", props.directory) }),
          queryClient.invalidateQueries({ queryKey: api.key("prompt-preview", props.directory) }),
        ]),
      )
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.prompts.switchFailed"), description: requestError(error) }),
      )
      .finally(() => setStore("busy", false))
  }

  const source = (section: OperatorPromptSection) =>
    section.source.startsWith("/") ? shortPath(section.source) : section.source

  const action = (section: OperatorPromptSection) => {
    if (section.kind === "identity")
      return { label: language.t("operator.prompts.editLayers"), run: () => props.onEdit("identity") }
    if (section.kind === "base")
      return { label: language.t("operator.prompts.edit"), run: () => props.onEdit("texts", section.source) }
    if (section.kind === "agent")
      return {
        label: language.t("operator.prompts.editAgent"),
        run: () =>
          navigate(
            `/operator/agents/${encodeURIComponent(section.source)}/edit?dir=${encodeURIComponent(props.directory)}`,
          ),
      }
    if (section.kind === "instructions")
      return {
        label: language.t("operator.prompts.openMemory"),
        run: () => navigate(`/operator/memory?dir=${encodeURIComponent(props.directory)}`),
      }
    const name = toggleFor(section.kind)
    if (name) return { label: language.t("operator.prompts.turnOff"), run: () => void toggle(name, false) }
  }

  return (
    <>
      <section data-component="operator-panel">
        <div data-slot="operator-form-row">
          <Field group label={language.t("operator.column.agent")}>
            <SelectV2<string>
              appearance="base"
              options={agentNames()}
              current={store.agent}
              onSelect={(name) => name && setStore("agent", name)}
            />
          </Field>
          <Field group label={language.t("operator.column.model")} hint={language.t("operator.prompts.modelHint")}>
            <SelectV2<string>
              appearance="base"
              options={models()}
              current={store.model}
              label={(value) => value || language.t("operator.prompts.agentModel")}
              onSelect={(value) => setStore("model", value ?? "")}
            />
          </Field>
        </div>
        <h2 data-slot="operator-panel-title">{language.t("operator.prompts.generated")}</h2>
        <p data-slot="operator-note">{language.t("operator.prompts.generatedHint")}</p>
        <div data-slot="operator-form-row">
          <Field group label={language.t("operator.scope.label")}>
            <ScopeSwitch value={store.scope} onChange={(scope) => setStore("scope", scope)} />
          </Field>
          <For each={TOGGLES}>
            {(name) => (
              <Field group label={language.t(`operator.prompts.section.${name}`)}>
                <Switch
                  checked={catalog.data?.toggles[name] ?? true}
                  disabled={store.busy}
                  onChange={(checked) => void toggle(name, checked)}
                >
                  {language.t(`operator.prompts.toggle.${name}`)}
                </Switch>
              </Field>
            )}
          </For>
        </div>
      </section>

      <Show when={preview.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(preview.error)}
        </pre>
      </Show>
      <Show when={preview.data}>
        {(data) => (
          <>
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
                    <span class="flex items-center gap-2 min-w-0">
                      <Tag variant={section.kind === "identity" || section.kind === "agent" ? "accent" : "neutral"}>
                        {language.t(`operator.prompts.section.${section.kind}`)}
                      </Tag>
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
              <ButtonV2 size="small" variant="outline" onClick={() => props.onEdit("texts", "reminder.plan")}>
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
