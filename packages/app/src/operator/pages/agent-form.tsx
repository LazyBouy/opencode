import { useNavigate, useParams } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useScopedProject } from "../project"
import { EmptyState } from "../ui/empty-state"
import { Field } from "../ui/field"
import { PageHeader } from "../ui/page-header"
import { type Rule, rulesFromConfig, rulesToConfig } from "../ui/rules"
import { RulesEditor } from "../ui/rules-editor"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { useAgents } from "./agents"
import { agentPatch, type AgentForm, formFromSettings } from "./agent-form-state"
import { requestError } from "./config-helpers"

// Create a new agent (a markdown file) or edit an existing one.
export default function AgentFormPage() {
  const language = useLanguage()
  const params = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const directory = useScopedProject()
  const agents = useAgents()
  const editing = () => params.name !== undefined
  const existing = createMemo(() => agents.data?.find((agent) => agent.name === decodeURIComponent(params.name ?? "")))
  const [store, setStore] = createStore({
    scope: "project" as Scope,
    form: formFromSettings("", {}),
    rules: [] as Rule[],
    error: "",
    saving: false,
  })

  // Fill the form from the agent's own settings once they load.
  createEffect(
    on(existing, (agent) => {
      if (!agent) return
      setStore({
        form: formFromSettings(agent.name, agent.settings),
        rules: rulesFromConfig(agent.settings.permission),
      })
    }),
  )

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setStore("form", key, value)
  const done = (name: string) => {
    void queryClient.invalidateQueries({ queryKey: api.key("agents", directory()) })
    navigate(`/operator/agents/${encodeURIComponent(name)}?dir=${encodeURIComponent(directory() ?? "")}`)
  }

  const save = async () => {
    setStore({ saving: true, error: "" })
    const patch = agentPatch(store.form, existing()?.settings ?? {}, rulesToConfig(store.rules))
    const client = api.client()
    const request = editing()
      ? client.operator.agent.update({ name: existing()!.name, directory: directory(), scope: store.scope, ...patch })
      : client.operator.agent.create({
          name: store.form.name.trim(),
          directory: directory(),
          scope: store.scope,
          ...patch,
        })
    await request
      .then(() => {
        showToast({ title: language.t("operator.agentForm.saved", { name: store.form.name }) })
        done(store.form.name.trim())
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  const fileAgent = () => existing()?.source.kind === "file"

  return (
    <Show
      when={directory()}
      fallback={
        <EmptyState
          icon="brain"
          title={language.t("operator.project.none")}
          description={language.t("operator.project.noneHint")}
        />
      }
    >
      <PageHeader
        title={
          editing()
            ? language.t("operator.agentForm.editTitle", { name: params.name ?? "" })
            : language.t("operator.agentForm.newTitle")
        }
        description={language.t("operator.agentForm.description")}
      />
      <section data-component="operator-panel">
        <div data-component="operator-form">
          <Show when={!editing()}>
            <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.agentForm.nameHint")}>
              <TextInputV2
                appearance="base"
                value={store.form.name}
                onInput={(event) => set("name", event.currentTarget.value)}
              />
            </Field>
          </Show>
          <Show
            when={!fileAgent()}
            fallback={
              <p data-slot="operator-note">
                {language.t("operator.agentForm.fileNote", { path: existing()?.source.path ?? "" })}
              </p>
            }
          >
            <Field
              group
              label={language.t("operator.agentForm.scope")}
              hint={
                editing()
                  ? language.t("operator.agentForm.scopeEditHint")
                  : language.t("operator.agentForm.scopeNewHint")
              }
            >
              <ScopeSwitch value={store.scope} onChange={(scope) => setStore("scope", scope)} />
            </Field>
          </Show>
          <Field
            label={language.t("operator.column.description")}
            hint={language.t("operator.agentForm.descriptionHint")}
          >
            <TextInputV2
              appearance="base"
              value={store.form.description}
              onInput={(event) => set("description", event.currentTarget.value)}
            />
          </Field>
          <Field group label={language.t("operator.column.mode")}>
            <SegmentedControlV2
              value={store.form.mode}
              onChange={(value) => value && set("mode", value as AgentForm["mode"])}
            >
              <SegmentedControlItemV2 value="primary">
                {language.t("operator.agents.mode.primary")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="subagent">
                {language.t("operator.agents.mode.subagent")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="all">{language.t("operator.agents.mode.all")}</SegmentedControlItemV2>
            </SegmentedControlV2>
          </Field>
          <Field label={language.t("operator.column.model")} hint={language.t("operator.agentForm.modelHint")}>
            <TextInputV2
              appearance="base"
              value={store.form.model}
              placeholder="anthropic/claude-sonnet-4-5"
              onInput={(event) => set("model", event.currentTarget.value)}
            />
          </Field>
          <div data-slot="operator-form-row">
            <Field label={language.t("operator.agent.variant")}>
              <TextInputV2
                appearance="base"
                value={store.form.variant}
                onInput={(event) => set("variant", event.currentTarget.value)}
              />
            </Field>
            <Field label={language.t("operator.agent.temperature")}>
              <TextInputV2
                appearance="base"
                inputMode="decimal"
                value={store.form.temperature}
                onInput={(event) => set("temperature", event.currentTarget.value)}
              />
            </Field>
            <Field label={language.t("operator.agent.topP")}>
              <TextInputV2
                appearance="base"
                inputMode="decimal"
                value={store.form.top_p}
                onInput={(event) => set("top_p", event.currentTarget.value)}
              />
            </Field>
            <Field label={language.t("operator.agent.steps")}>
              <TextInputV2
                appearance="base"
                inputMode="numeric"
                value={store.form.steps}
                onInput={(event) => set("steps", event.currentTarget.value)}
              />
            </Field>
          </div>
          <div data-slot="operator-form-row">
            <Field label={language.t("operator.agentForm.color")} hint={language.t("operator.agentForm.colorHint")}>
              <TextInputV2
                appearance="base"
                value={store.form.color}
                placeholder="#FF6600"
                onInput={(event) => set("color", event.currentTarget.value)}
              />
            </Field>
            <Field group label={language.t("operator.agents.hidden")}>
              <Switch checked={store.form.hidden} onChange={(checked) => set("hidden", checked)}>
                {language.t("operator.agentForm.hiddenHint")}
              </Switch>
            </Field>
          </div>
          <Field label={language.t("operator.agentForm.home")} hint={language.t("operator.agentForm.homeHint")}>
            <TextInputV2
              appearance="base"
              value={store.form.home}
              placeholder="/root/projects/docs"
              onInput={(event) => set("home", event.currentTarget.value)}
            />
          </Field>
          <Field label={language.t("operator.agent.tab.prompt")} hint={language.t("operator.agentForm.promptHint")}>
            <TextareaV2
              class="operator-editor"
              rows={10}
              value={store.form.prompt}
              onInput={(event) => set("prompt", event.currentTarget.value)}
            />
          </Field>
          <Field
            group
            label={language.t("operator.agent.tab.permissions")}
            hint={language.t("operator.agent.rulesHint")}
          >
            <RulesEditor rules={store.rules} onChange={(rules) => setStore("rules", rules)} />
          </Field>
        </div>
        <Show when={store.error}>
          <pre data-slot="operator-error" role="alert">
            {store.error}
          </pre>
        </Show>
        <div data-slot="operator-actions">
          <ButtonV2 variant="neutral" onClick={() => history.back()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            disabled={store.saving || (!editing() && !store.form.name.trim())}
            onClick={() => void save()}
          >
            {editing() ? language.t("operator.config.save") : language.t("operator.agentForm.create")}
          </ButtonV2>
        </div>
      </section>
    </Show>
  )
}
