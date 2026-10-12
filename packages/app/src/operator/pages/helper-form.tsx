import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorHelper, OperatorHelperModel } from "@opencode-ai/sdk/v2/client"
import { useQueryClient } from "@tanstack/solid-query"
import { type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { useOperatorProjects } from "../project"
import { Field } from "../ui/field"
import { useProjectModels } from "../ui/model-defaults"
import { SelectV2 } from "../ui/select"
import { TextCounters } from "../ui/text-counters"
import { AgentModelFields, type ModelForm } from "./agent-model-fields"
import { requestError } from "./config-helpers"
import { useNamespaces } from "./profile-data"

// A helper's form (agent_types_spec.md §4.3): its namespace (instead of Save in), name, description, model (Small
// model by default: the small model of the project it serves, the namespace's default project here), its text
// (a helper profile holding one helper layer, edited in place) with counters, and its step and time limits.
// Triggers come with automations (§4.9); actions, the `helper` tool and roles in later phases.

export const STEPS = { default: 5, max: 20 }
export const TIMEOUT = { default: 120, min: 10, max: 600 }

type Form = ModelForm & {
  namespace: string
  name: string
  description: string
  text: string
  steps: string
  timeout: string
}

function formOf(namespace: string, helper: OperatorHelper | undefined): Form {
  const source = helper?.model.source
  return {
    namespace: helper?.namespace ?? namespace,
    name: helper?.name ?? "",
    description: helper?.description ?? "",
    modelSource: source === "default" || source === "pick" ? source : "small",
    model: helper?.model.model ?? "",
    variant: helper?.model.variant ?? "",
    text: helper?.text ?? "",
    steps: String(helper?.steps ?? STEPS.default),
    timeout: String(helper?.timeout ?? TIMEOUT.default),
  }
}

function modelOf(form: Form): OperatorHelperModel {
  return {
    source: form.modelSource,
    ...(form.modelSource === "pick" ? { model: form.model.trim() } : {}),
    ...(form.modelSource !== "default" && form.variant ? { variant: form.variant } : {}),
  }
}

export function HelperForm(props: {
  /** The namespace a new helper starts in. */
  namespace: string
  /** Editing this helper (its namespace and name stay). */
  helper?: OperatorHelper
  onSaved: (helper: OperatorHelper) => void
  onCancel: () => void
  /** Shown first (the agent form's Type). */
  before?: JSX.Element
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const namespaces = useNamespaces()
  const projects = useOperatorProjects()
  const [store, setStore] = createStore({ form: formOf(props.namespace, props.helper), error: "", saving: false })
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setStore("form", key, value)
  const editing = () => !!props.helper

  // The project a helper serves by default: its namespace's default project.
  const summary = () => namespaces.data?.find((item) => item.namespace.id === store.form.namespace)
  const project = () => summary()?.defaultProject
  const projectName = () => projects().find((item) => item.directory === project())?.label ?? project() ?? ""
  const chain = useProjectModels(project)
  // The model the counters count for.
  const model = () => {
    const found = ready(chain)?.chain
    if (store.form.modelSource === "pick") return store.form.model || undefined
    return (store.form.modelSource === "small" ? found?.small : found?.model)?.effective.model || undefined
  }

  const save = async () => {
    setStore({ saving: true, error: "" })
    const client = api.client()
    const fields = {
      description: store.form.description.trim(),
      model: modelOf(store.form),
      text: store.form.text,
      steps: Number(store.form.steps),
      timeout: Number(store.form.timeout),
    }
    const request = props.helper
      ? client.operator.helper.update(
          { ns: props.helper.namespace, name: props.helper.name, ...fields },
          { throwOnError: true },
        )
      : client.operator.helper.create(
          {
            ns: store.form.namespace,
            name: store.form.name.trim(),
            ...fields,
            ...(fields.description ? {} : { description: undefined }),
          },
          { throwOnError: true },
        )
    await request
      .then((result) => {
        void queryClient.invalidateQueries({ queryKey: api.key("helpers") })
        props.onSaved(result.data)
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <section data-component="operator-panel">
      <div data-component="operator-form">
        {props.before}
        <Field group label={language.t("operator.helper.namespace")} hint={language.t("operator.help.helperNamespace")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.helper.namespace")}
            disabled={editing()}
            options={(namespaces.data ?? []).map((item) => item.namespace.id)}
            current={store.form.namespace}
            label={(id) => namespaces.data?.find((item) => item.namespace.id === id)?.namespace.name ?? id}
            onSelect={(id) => id && set("namespace", id)}
          />
        </Field>
        <Show when={!editing()}>
          <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.helper.nameHint")}>
            <TextInputV2
              appearance="base"
              value={store.form.name}
              onInput={(event) => set("name", event.currentTarget.value)}
            />
          </Field>
        </Show>
        <Field label={language.t("operator.column.description")} hint={language.t("operator.help.helperDescription")}>
          <TextInputV2
            appearance="base"
            value={store.form.description}
            onInput={(event) => set("description", event.currentTarget.value)}
          />
        </Field>
        <AgentModelFields
          form={store.form}
          set={(key, value) => set(key, value)}
          directory={project()}
          scope="project"
          editing={editing()}
          prefill={false}
          where={projectName()}
        />
        <Field label={language.t("operator.helper.text")} hint={language.t("operator.help.helperText")}>
          <TextCounters text={store.form.text} model={model()} directory={project()} />
          <TextareaV2
            class="operator-editor"
            aria-label={language.t("operator.helper.text")}
            rows={10}
            value={store.form.text}
            onInput={(event) => set("text", event.currentTarget.value)}
          />
        </Field>
        <div data-slot="operator-form-row">
          <Field
            label={language.t("operator.helper.steps")}
            hint={language.t("operator.help.helperSteps", { max: STEPS.max })}
          >
            <TextInputV2
              appearance="base"
              inputMode="numeric"
              value={store.form.steps}
              onInput={(event) => set("steps", event.currentTarget.value)}
            />
          </Field>
          <Field
            label={language.t("operator.helper.timeout")}
            hint={language.t("operator.help.helperTimeout", { min: TIMEOUT.min, max: TIMEOUT.max })}
          >
            <TextInputV2
              appearance="base"
              inputMode="numeric"
              value={store.form.timeout}
              onInput={(event) => set("timeout", event.currentTarget.value)}
            />
          </Field>
        </div>
        <Field group label={language.t("operator.helper.triggers")} hint={language.t("operator.help.helperTriggers")}>
          <ButtonV2 size="small" variant="neutral" disabled>
            {language.t("operator.helper.addTrigger")}
          </ButtonV2>
          <p data-slot="operator-note">{language.t("operator.helper.triggersLater")}</p>
        </Field>
      </div>
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div data-slot="operator-actions">
        <ButtonV2 variant="neutral" onClick={() => props.onCancel()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={store.saving || (!editing() && !store.form.name.trim())}
          onClick={() => void save()}
        >
          {editing() ? language.t("common.save") : language.t("operator.helper.create")}
        </ButtonV2>
      </div>
    </section>
  )
}
