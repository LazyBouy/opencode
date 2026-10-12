import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "../ui/select"
import type { OperatorModelSource, OperatorPromptOverride } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatCount, shortPath } from "../format"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { FieldHelp } from "../ui/field-help"
import { TraceList, useModelSourceText } from "../ui/prompt-trace"
import { Resolution } from "../ui/resolution"
import { requestError } from "./config-helpers"
import { useAllLayers, usePromptCatalog, useProfileNames } from "./profile-data"
import { SlotEditor, type SlotValue } from "./profile-editor"
import {
  type Catalog,
  copySlots,
  DYNAMIC,
  isHelper,
  PREFIX,
  type Profile,
  slotProblem,
  type Slots,
  textSize,
} from "./profile-model"
import { exceptionsFor } from "./prompt-exceptions"

// The model option that means "whatever the agent uses".
const AGENT_MODEL = "agent"
// The profile option that means "no setting of its own" (not a possible profile id).
const DEFAULT = "@default"

// An agent's prompt setting, its namespace, and the profile it uses with where that comes from.
export function useAgentPromptSetting(agent: () => string, directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("agent-prompt", directory(), agent()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.agentPrompt.get({ name: agent(), directory: directory() })
        .then((result) => result.data!),
  }))
}

// The agent's prompt: which profile it uses, its override of that profile, and the whole system
// prompt it sends, section by section, each traced to where its text comes from. The agent belongs to
// the project of `directory`. The agent only chooses a profile and overrides it: profiles are shared by
// many agents, so they are changed on the Prompt Profile page, not here.
export function AgentPrompt(props: { agent: string; directory: string; modelSource?: OperatorModelSource }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const names = useProfileNames()
  // The override being edited and not saved yet, previewed live (undefined: the saved one).
  const [draft, setDraft] = createSignal<OperatorPromptOverride>()

  const setting = useAgentPromptSetting(
    () => props.agent,
    () => props.directory,
  )
  const ns = () => setting.data?.namespace.id
  const data = usePromptCatalog(() => ns() ?? "")
  const catalog = () => (ns() ? data.query.data : undefined)

  const save = (next: { profile?: string; override?: OperatorPromptOverride }) =>
    api
      .client()
      .operator.agentPrompt.update({ name: props.agent, directory: props.directory, ...next })
      .then(() => data.refresh())

  return (
    <Show
      when={setting.data && catalog() ? { view: setting.data, catalog: catalog()! } : undefined}
      fallback={
        <Show when={setting.error ?? data.query.error}>
          {(error) => (
            <pre data-slot="operator-error" role="alert">
              {requestError(error())}
            </pre>
          )}
        </Show>
      }
    >
      {(loaded) => (
        <>
          <section data-component="operator-panel">
            <dl data-component="operator-facts">
              <dt>{language.t("operator.prompts.project")}</dt>
              <dd>{shortPath(props.directory)}</dd>
              <dt>{language.t("operator.prompts.namespace")}</dt>
              <dd>{loaded().view.namespace.name}</dd>
              <dt>{language.t("operator.prompts.profile")}</dt>
              <dd>
                {language.t("operator.prompts.profileFrom", {
                  name: profileName(loaded().catalog, loaded().view.profile),
                  source: language.t(`operator.prompts.source.${loaded().view.profile.source}`),
                })}
              </dd>
            </dl>
            <Field
              group
              label={language.t("operator.prompts.profile")}
              hint={language.t("operator.prompts.profileHint")}
            >
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.prompts.profile")}
                options={[DEFAULT, ...loaded().catalog.profiles.map((item) => item.id)]}
                current={loaded().view.setting.profile ?? DEFAULT}
                label={(id) =>
                  id === DEFAULT
                    ? language.t("operator.prompts.useDefault", {
                        name: profileName(loaded().catalog, loaded().view.default),
                      })
                    : helperOf(loaded().catalog, id)
                      ? language.t("operator.prompts.helperProfile", {
                          name: profileName(loaded().catalog, { id, name: id }),
                        })
                      : profileName(loaded().catalog, { id, name: id })
                }
                onSelect={(id) => {
                  if (id === null) return
                  // A helper agent has no override.
                  void save({
                    profile: id === DEFAULT ? undefined : id,
                    override: helperOf(loaded().catalog, id) ? undefined : loaded().view.setting.override,
                  }).catch(data.fail)
                }}
              />
            </Field>
          </section>
          <Show
            when={!helperOf(loaded().catalog, loaded().view.profile.id)}
            fallback={
              <p data-slot="operator-note">{language.t("operator.prompts.helperAgent", { name: props.agent })}</p>
            }
          >
            <Override
              ns={loaded().view.namespace.id}
              catalog={loaded().catalog}
              profile={loaded().catalog.profiles.find((item) => item.id === loaded().view.profile.id)}
              setting={loaded().view.setting}
              onSave={save}
              onDraft={setDraft}
            />
          </Show>
          <Preview agent={props.agent} directory={props.directory} override={draft()} modelSource={props.modelSource} />
        </>
      )}
    </Show>
  )

  function helperOf(loaded: Catalog, id: string) {
    const found = loaded.profiles.find((item) => item.id === id)
    return !!found && isHelper(loaded, found)
  }

  function profileName(loaded: Catalog, profile: { id: string; name: string }) {
    const found = loaded.profiles.find((item) => item.id === profile.id)
    return found ? names.profile(found) : profile.name
  }
}

// The agent's changes to its profile: a group, and the slots it changed. Only changes are saved, so
// the slots it did not change keep following the profile.
function Override(props: {
  ns: string
  catalog: Catalog
  profile: Profile | undefined
  setting: { profile?: string; override?: OperatorPromptOverride }
  onSave: (next: { profile?: string; override?: OperatorPromptOverride }) => Promise<unknown>
  // The override being edited and not saved yet, for the preview; undefined when there is none.
  onDraft: (override: OperatorPromptOverride | undefined) => void
}) {
  const language = useLanguage()
  const confirm = useConfirm()
  const data = usePromptCatalog(() => props.ns)
  const layers = useAllLayers(() => props.catalog)
  const [store, setStore] = createStore({
    open: false,
    group: undefined as string | undefined,
    slots: {} as Slots,
    busy: false,
  })
  // The saved override, whenever it changes on the server (a memo, so a refetch of the same setting
  // does not reset edits in progress).
  const saved = createMemo(() => JSON.stringify(props.setting.override ?? null))
  createEffect(
    on(saved, () => {
      const override = props.setting.override
      // Slots are replaced, not merged, so slots the saved override dropped go.
      setStore({ open: !!override, group: override?.group })
      setStore("slots", reconcile(copySlots(override?.slots ?? {})))
    }),
  )
  const value = createMemo<SlotValue>(() => {
    const group = store.group ?? props.profile?.group ?? ""
    const types = props.catalog.groups.find((item) => item.id === group)?.types ?? []
    return {
      group,
      slots: Object.fromEntries(
        types
          .filter((type) => type !== "purpose")
          .map((type) => [type, store.slots[type] ?? props.profile?.slots[type] ?? []]),
      ),
    }
  })
  // What a save stores: the group if it differs, and the changed slots of the group's types.
  const override = (): OperatorPromptOverride => {
    const types = props.catalog.groups.find((item) => item.id === value().group)?.types ?? []
    const slots = Object.fromEntries(Object.entries(store.slots).filter(([type]) => types.includes(type)))
    return {
      ...(store.group && store.group !== props.profile?.group ? { group: store.group } : {}),
      ...(Object.keys(slots).length ? { slots } : {}),
    }
  }
  const dirty = () => JSON.stringify(override()) !== JSON.stringify(props.setting.override ?? {})
  const problem = () => slotProblem(props.catalog, value().slots)
  createEffect(() => props.onDraft(store.open && props.profile && dirty() ? override() : undefined))

  const toggle = async (checked: boolean) => {
    if (checked) return setStore("open", true)
    if (!props.setting.override) {
      setStore({ open: false, group: undefined })
      return setStore("slots", reconcile({}))
    }
    const ok = await confirm({
      title: language.t("operator.prompts.removeOverrideTitle"),
      description: language.t("operator.prompts.removeOverrideBody"),
      confirm: language.t("operator.prompts.removeOverride"),
      danger: true,
    })
    if (!ok) return
    await props.onSave({ profile: props.setting.profile }).catch(data.fail)
  }
  const save = async () => {
    setStore("busy", true)
    await props
      .onSave({ profile: props.setting.profile, override: override() })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }

  return (
    <section data-component="operator-panel">
      <span class="inline-flex items-center">
        <CheckboxV2
          label={language.t("operator.prompts.override")}
          checked={store.open}
          onChange={(checked: boolean) => void toggle(checked)}
        />
        <FieldHelp field={language.t("operator.prompts.override")} text={language.t("operator.help.override")} />
      </span>
      <Show when={store.open && props.profile}>
        <SlotEditor
          ns={props.ns}
          catalog={props.catalog}
          layers={layers()}
          value={value()}
          noHelper
          changed={(type) => type in store.slots}
          groupChanged={!!store.group}
          onReset={(type) =>
            setStore(
              "slots",
              produce((slots) => {
                delete slots[type]
              }),
            )
          }
          onResetGroup={() => setStore("group", undefined)}
          onChange={(next, type) => {
            if (type) return setStore("slots", type, [...(next.slots[type] ?? [])])
            setStore("group", next.group === props.profile?.group ? undefined : next.group)
          }}
        />
        <div data-slot="operator-actions">
          <ButtonV2 variant="contrast" disabled={store.busy || !dirty() || !!problem()} onClick={() => void save()}>
            {language.t("operator.prompts.saveOverride")}
          </ButtonV2>
        </div>
      </Show>
    </section>
  )
}

// The system prompt the agent sends with a model, section by section, each with how it was resolved,
// down to the file its text is in; the texts OpenCode adds that are not in the profile; and its size.
// `override` previews unsaved override edits.
function Preview(props: {
  agent: string
  directory: string
  override?: OperatorPromptOverride
  modelSource?: OperatorModelSource
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const names = useProfileNames()
  const modelText = useModelSourceText()
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
  const draft = () => (props.override ? JSON.stringify(props.override) : undefined)

  const preview = useQuery(() => ({
    queryKey: api.key("prompt-preview", props.directory, props.agent, store.model, draft()),
    queryFn: () => {
      const [provider, ...rest] = store.model.split("/")
      return api
        .client()
        .operator.prompt.preview({
          directory: props.directory,
          agent: props.agent,
          ...(store.model === AGENT_MODEL ? {} : { provider, model: rest.join("/") }),
          ...(draft() ? { override: draft() } : {}),
        })
        .then((result) => result.data!)
    },
  }))
  // External plugins can change the prompt after the profile.
  const plugins = useQuery(() => ({
    queryKey: api.key("prompt-plugins", props.directory),
    queryFn: () =>
      api
        .client()
        .operator.prompt.plugins({ directory: props.directory })
        .then((result) => result.data?.plugins ?? []),
  }))
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)

  return (
    <>
      <section data-component="operator-panel">
        <Field group label={language.t("operator.column.model")} hint={language.t("operator.prompts.modelHint")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.column.model")}
            options={models()}
            current={store.model}
            label={(value) =>
              value === AGENT_MODEL
                ? language.t("operator.prompts.agentModel", { model: props.modelSource?.model ?? "" })
                : value
            }
            onSelect={(value) => value && setStore("model", value)}
          />
        </Field>
        <Show when={preview.data?.modelSource}>
          {(source) => (
            <p data-slot="operator-note" data-testid="preview-model-source">
              {language.t("operator.prompts.modelFrom", { model: source().model, source: modelText(source()) })}
            </p>
          )}
        </Show>
      </section>

      <Show when={preview.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(preview.error)}
        </pre>
        <p data-slot="operator-note">{language.t("operator.prompts.previewFailed")}</p>
      </Show>
      <Show when={preview.data}>
        {(data) => {
          const sent = () => textSize(data().system.join("\n"))
          const perRequest = () =>
            textSize(
              data()
                .sections.filter((item) => item.type === DYNAMIC)
                .map((item) => item.text)
                .join("\n"),
            )
          return (
            <>
              <p data-slot="operator-note">
                {language.t("operator.prompts.summary", {
                  model: data().model,
                  count: data().sections.length,
                  chars: formatCount(sent().chars, language.intl()),
                })}
                {" · "}
                {language.t("operator.prompts.groupOf", {
                  group: names.group({ ...data().group, builtin: data().group.id.startsWith(PREFIX) }),
                })}
              </p>
              <For each={data().sections}>
                {(section) => (
                  <section
                    data-component="operator-panel"
                    data-slot="operator-prompt-section"
                    data-type={section.type}
                    data-changed={section.changed ? "" : undefined}
                  >
                    <div data-slot="operator-panel-head">
                      <span class="flex items-center gap-2 min-w-0 flex-wrap">
                        <Tag variant={section.automatic ? "accent" : "neutral"}>{section.typeName}</Tag>
                        <span data-slot="operator-layer-name">{section.layerName}</span>
                        <Show when={section.automatic}>
                          <Tag>{language.t("operator.prompts.automatic")}</Tag>
                        </Show>
                        <Show when={section.changed}>
                          <Tag>{language.t("operator.profile.changed")}</Tag>
                        </Show>
                        <span data-slot="operator-note">
                          {language.t("operator.prompts.chars", {
                            count: formatCount(section.text.length, language.intl()),
                          })}
                        </span>
                      </span>
                    </div>
                    <TraceList trace={section.trace} />
                    <Resolution trace={section.resolution} parity={section.parity} />
                    <pre data-component="operator-code">{section.text}</pre>
                  </section>
                )}
              </For>
              <section data-component="operator-panel">
                <h2 data-slot="operator-panel-title">{language.t("operator.prompts.perTurn")}</h2>
                <p data-slot="operator-note">{language.t("operator.prompts.perTurnHint")}</p>
              </section>
              <section data-component="operator-panel" data-testid="prompt-exceptions">
                <h2 data-slot="operator-panel-title">{language.t("operator.prompts.exceptions")}</h2>
                <p data-slot="operator-note">{language.t("operator.prompts.exceptionsHint")}</p>
                <ul data-slot="operator-exceptions">
                  <For each={exceptionsFor(props.agent)}>
                    {(item) => (
                      <li data-exception={item.id}>
                        <span>{language.t(`operator.exception.${item.id}`)}</span>
                        <span data-slot="operator-note">{item.files.join(", ")}</span>
                      </li>
                    )}
                  </For>
                  <Show when={plugins.data?.length}>
                    <li data-exception="plugins">
                      <span>{language.t("operator.prompts.plugins")}</span>
                      <span data-slot="operator-note">
                        {(plugins.data ?? []).map((item) => `${item.spec} (${shortPath(item.source)})`).join(", ")}
                      </span>
                    </li>
                  </Show>
                </ul>
              </section>
              <details data-slot="operator-details">
                <summary>{language.t("operator.prompts.raw", { count: data().system.length })}</summary>
                <For each={data().system}>{(message) => <pre data-component="operator-code">{message}</pre>}</For>
              </details>
              <p data-slot="operator-note" data-testid="prompt-size">
                <span class="inline-flex items-center">
                  {language.t("operator.prompts.size", {
                    words: number(sent().words),
                    tokens: number(sent().tokens),
                    chars: number(sent().chars),
                    dynamic: number(perRequest().words),
                  })}
                  <FieldHelp
                    field={language.t("operator.prompts.sizeLabel")}
                    text={language.t("operator.help.promptSize")}
                  />
                </span>
              </p>
            </>
          )
        }}
      </Show>
    </>
  )
}
