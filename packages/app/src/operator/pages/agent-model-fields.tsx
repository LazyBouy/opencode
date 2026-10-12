import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "../ui/select"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, on, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { formatCount } from "../format"
import { Field } from "../ui/field"
import { useModelWords, useNamespaceModels, useProjectModels } from "../ui/model-defaults"
import type { AgentForm, ModelSource } from "./agent-form-state"

// The agent form's model (agent_form_spec.md §2, default_models_spec.md §8): Model source (Default model, Small
// model, Pick a model), then for Pick a model a provider and one of its models, and a variant built from the
// model. A new agent starts on Pick a model with the default model in effect where it's saved, copied in;
// changing where it's saved updates that until the model is touched.

const NO_VARIANT = "@model-default"
const EFFORT = ["minimal", "low", "medium", "high", "xhigh"]

type Variants = Record<string, Record<string, unknown>>
type ProviderModels = { id: string; name: string; models: Array<{ id: string; name: string; variants?: Variants }> }

/** A variant in words (§2.3): from its name, else a token budget in its options, else its name. */
export function useVariantLabel() {
  const language = useLanguage()
  const budget = (options: Record<string, unknown>): number | undefined => {
    for (const [key, value] of Object.entries(options)) {
      if (/budget/i.test(key) && typeof value === "number") return value
      if (value && typeof value === "object") {
        const found = budget(value as Record<string, unknown>)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return (name: string, options: Record<string, unknown> = {}) => {
    if (name === "none") return language.t("operator.agentModel.variant.off")
    if (name === "thinking") return language.t("operator.agentModel.variant.on")
    if (EFFORT.includes(name)) return language.t("operator.agentModel.variant.effort", { level: name })
    if (name === "max") return language.t("operator.agentModel.variant.max")
    const tokens = budget(options)
    if (tokens !== undefined)
      return language.t("operator.agentModel.variant.budget", { tokens: formatCount(tokens, language.intl()) })
    return name
  }
}

/** The model part of a form: the agent form's, or a helper's. */
export type ModelForm = Pick<AgentForm, "modelSource" | "model" | "variant">

export function AgentModelFields(props: {
  form: ModelForm
  /** Model source values come from the control (ModelSource); model and variant are text. */
  set: (key: keyof ModelForm, value: string) => void
  directory: string | undefined
  scope: "project" | "global"
  editing: boolean
  /** A new agent starts on the default model in effect, copied in; a helper keeps the source it was given. */
  prefill?: boolean
  /** Where the agent is saved, in words (the project's name, or Settings), for the "copied in" note. */
  where: string
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const variantLabel = useVariantLabel()
  const providers = useQuery(() => ({
    queryKey: api.key("providers", props.directory),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: props.directory })
        .then((result) => result.data!),
  }))
  const list = createMemo<ProviderModels[]>(() =>
    (ready(providers)?.providers ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.values(provider.models).map((model) => ({
        id: model.id,
        name: model.name,
        variants: model.variants as Variants | undefined,
      })),
    })),
  )
  const connected = createMemo(() =>
    list().flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.id}/${model.id}`,
        name: model.name,
        provider: provider.name,
      })),
    ),
  )
  const words = useModelWords(connected)
  // The default and small model in effect where the agent is saved: the project's, or Settings' for Global.
  const project = useProjectModels(() => (props.scope === "project" ? props.directory : undefined))
  const settings = useNamespaceModels(() => undefined)
  const chains = () => (props.scope === "project" ? ready(project)?.chain : ready(settings)?.chain)
  const split = (value: string) => {
    const at = value.indexOf("/")
    return at < 0 ? { provider: "", model: "" } : { provider: value.slice(0, at), model: value.slice(at + 1) }
  }
  const picked = () => split(props.form.model)
  const provider = () => list().find((item) => item.id === picked().provider)
  const model = () => provider()?.models.find((item) => item.id === picked().model)

  // A new agent starts on the default model in effect where it's saved, copied in, until it's touched.
  let touched = false
  const touch = () => (touched = true)
  createEffect(
    on(
      () => [props.scope, chains()?.model.effective.model] as const,
      ([, effective]) => {
        if (props.editing || props.prefill === false || touched || effective === undefined) return
        if (!effective) return props.set("modelSource", "default")
        props.set("modelSource", "pick")
        props.set("model", effective)
      },
    ),
  )

  // The variants on offer: the picked model's, or for Small model the small model's.
  const smallModel = () => {
    const value = chains()?.small.effective.model
    if (!value) return undefined
    const { provider: id, model: name } = split(value)
    return list()
      .find((item) => item.id === id)
      ?.models.find((item) => item.id === name)
  }
  const variants = (): Variants =>
    (props.form.modelSource === "pick"
      ? model()?.variants
      : props.form.modelSource === "small"
        ? smallModel()?.variants
        : undefined) ?? {}
  const variantOff = () =>
    props.form.modelSource === "default"
      ? language.t("operator.agentModel.variantDefaultSource")
      : Object.keys(variants()).length === 0
        ? language.t("operator.agentModel.variantNone")
        : undefined

  const source = (value: ModelSource) => {
    touch()
    props.set("modelSource", value)
    if (value === "default") props.set("variant", "")
  }
  // What the agent will use now (§2.1), and for a prefilled new agent where its model came from.
  const usesNow = () => {
    const found = chains()
    if (!found) return ""
    if (props.form.modelSource === "default" || props.form.modelSource === "small") {
      const effective = props.form.modelSource === "small" ? found.small.effective : found.model.effective
      const model = words.full(effective.model) || language.t("operator.modelSource.none")
      const from =
        effective.from === "opencode"
          ? `(${language.t("operator.modelChain.decides")})`
          : language.t("operator.modelChain.fromLine", { from: words.from(effective, props.where) })
      return language.t(
        props.form.modelSource === "small" ? "operator.agentModel.usesSmall" : "operator.agentModel.usesDefault",
        { model, from },
      )
    }
    if (props.prefill !== false && !props.editing && !touched && props.form.model === found.model.effective.model)
      return props.scope === "global"
        ? language.t("operator.agentModel.copiedInSettings")
        : language.t("operator.agentModel.copiedIn", { where: props.where })
    return ""
  }

  return (
    <>
      <Field group label={language.t("operator.agentModel.source")} hint={language.t("operator.help.agentModelSource")}>
        <SegmentedControlV2
          class="operator-segmented-wide"
          value={props.form.modelSource}
          onChange={(value) => value && source(value as ModelSource)}
        >
          <SegmentedControlItemV2 value="default">
            {language.t("operator.agentModel.sourceDefault")}
          </SegmentedControlItemV2>
          <SegmentedControlItemV2 value="small">{language.t("operator.agentModel.sourceSmall")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="pick">{language.t("operator.agentModel.sourcePick")}</SegmentedControlItemV2>
        </SegmentedControlV2>
      </Field>
      <Show when={props.form.modelSource === "pick"}>
        <div data-slot="operator-form-row">
          <Field
            label={language.t("operator.agentModel.provider")}
            hint={language.t("operator.help.agentModelProvider")}
          >
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.agentModel.provider")}
              options={list().map((item) => item.id)}
              current={picked().provider || undefined}
              placeholder={language.t("operator.agentModel.choose")}
              label={(id) => list().find((item) => item.id === id)?.name ?? id}
              onSelect={(id) => {
                if (!id) return
                touch()
                // The provider's first model, until another is chosen.
                const first = list().find((item) => item.id === id)?.models[0]
                props.set("model", first ? `${id}/${first.id}` : `${id}/`)
                props.set("variant", "")
              }}
            />
          </Field>
          <Field label={language.t("operator.agentModel.model")} hint={language.t("operator.help.agentModelPick")}>
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.agentModel.model")}
              options={provider()?.models.map((item) => item.id) ?? []}
              current={model()?.id}
              placeholder={language.t("operator.agentModel.choose")}
              label={(id) => provider()?.models.find((item) => item.id === id)?.name ?? id}
              onSelect={(id) => {
                if (!id) return
                touch()
                props.set("model", `${picked().provider}/${id}`)
                if (
                  props.form.variant &&
                  !provider()?.models.find((item) => item.id === id)?.variants?.[props.form.variant]
                )
                  props.set("variant", "")
              }}
            />
          </Field>
        </div>
      </Show>
      <Show when={props.form.modelSource === "pick" && model()}>
        <p data-slot="operator-note" data-testid="agent-model-id">
          <code>{props.form.model}</code>
        </p>
      </Show>
      <Field label={language.t("operator.agent.variant")} hint={language.t("operator.help.variant")}>
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.agent.variant")}
          disabled={!!variantOff()}
          options={[NO_VARIANT, ...Object.keys(variants())]}
          current={props.form.variant || NO_VARIANT}
          label={(name) =>
            name === NO_VARIANT
              ? language.t("operator.agentModel.variantModelDefault")
              : variantLabel(name, variants()[name])
          }
          onSelect={(name) => name && props.set("variant", name === NO_VARIANT ? "" : name)}
        />
      </Field>
      <Show when={variantOff()}>{(text) => <p data-slot="operator-note">{text()}</p>}</Show>
      <Show when={usesNow()}>
        {(text) => (
          <p data-slot="operator-note" data-testid="agent-model-now">
            {text()}
          </p>
        )}
      </Show>
    </>
  )
}
