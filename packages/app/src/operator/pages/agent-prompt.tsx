import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { OperatorPromptAssembledSection, OperatorPromptOverride } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatCount, shortPath } from "../format"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { requestError } from "./config-helpers"
import { useAllLayers, usePromptCatalog, useProfileNames } from "./profile-data"
import { SlotEditor, type SlotValue } from "./profile-editor"
import { type Catalog, copySlots, PREFIX, type Profile, slotProblem, type Slots } from "./profile-model"
import { FieldHelp } from "../ui/field-help"

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
// prompt it sends, section by section. The agent belongs to the project of `directory`.
export function AgentPrompt(props: { agent: string; directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const names = useProfileNames()
  const [params, setParams] = useSearchParams<{ previewProfile?: string }>()

  const setting = useAgentPromptSetting(
    () => props.agent,
    () => props.directory,
  )
  const ns = () => setting.data?.namespace.id
  const data = usePromptCatalog(() => ns() ?? "")
  const catalog = () => (ns() ? data.query.data : undefined)
  const previewed = () => catalog()?.profiles.find((item) => item.id === params.previewProfile)

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
                    : profileName(loaded().catalog, { id, name: id })
                }
                onSelect={(id) => {
                  if (id === null) return
                  void save({
                    profile: id === DEFAULT ? undefined : id,
                    override: loaded().view.setting.override,
                  }).catch(data.fail)
                }}
              />
            </Field>
          </section>
          <Override
            ns={loaded().view.namespace.id}
            catalog={loaded().catalog}
            profile={loaded().catalog.profiles.find((item) => item.id === loaded().view.profile.id)}
            setting={loaded().view.setting}
            onSave={save}
          />
          <Show when={previewed()}>
            {(profile) => (
              <section data-component="operator-panel" data-slot="operator-previewing" role="status">
                <span>{language.t("operator.prompts.previewing", { name: names.profile(profile()) })}</span>
                <span class="flex gap-2">
                  <ButtonV2 size="small" variant="neutral" onClick={() => setParams({ previewProfile: undefined })}>
                    {language.t("operator.prompts.stopPreview")}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="contrast"
                    onClick={() =>
                      void save({ profile: profile().id, override: loaded().view.setting.override })
                        .then(() => setParams({ previewProfile: undefined }))
                        .catch(data.fail)
                    }
                  >
                    {language.t("operator.prompts.usePreviewed")}
                  </ButtonV2>
                </span>
              </section>
            )}
          </Show>
          <Preview
            agent={props.agent}
            directory={props.directory}
            ns={loaded().view.namespace.id}
            profile={previewed()?.id}
          />
        </>
      )}
    </Show>
  )

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

// The system prompt the agent sends with a model, section by section, with where each part comes
// from and where to change it. `profile` previews another profile than the agent's own.
function Preview(props: { agent: string; directory: string; ns: string; profile?: string }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const names = useProfileNames()
  const openSettings = useSettingsDialog("namespaces")
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
    queryKey: api.key("prompt-preview", props.directory, props.agent, store.model, props.profile),
    queryFn: () => {
      const [provider, ...rest] = store.model.split("/")
      return api
        .client()
        .operator.prompt.preview({
          directory: props.directory,
          agent: props.agent,
          ...(store.model === AGENT_MODEL ? {} : { provider, model: rest.join("/") }),
          ...(props.profile ? { profile: props.profile } : {}),
        })
        .then((result) => result.data!)
    },
  }))

  // A layer on the Prompt Profile page.
  const open = (layer: string) =>
    navigate(`/operator/profile?ns=${encodeURIComponent(props.ns)}&tab=layers&layer=${encodeURIComponent(layer)}`)

  const source = (section: OperatorPromptAssembledSection) =>
    section.source.startsWith("/") ? shortPath(section.source) : section.source

  // Where to change a section's text.
  const action = (section: OperatorPromptAssembledSection) => {
    if (section.layer === `${PREFIX}purpose.org`)
      return { label: language.t("operator.profile.editInSettings"), run: openSettings }
    const agentText =
      section.entry === `${PREFIX}slot.agent` ||
      (section.entry === `${PREFIX}slot.agent-or-base` && section.source === props.agent)
    if (agentText)
      return {
        label: language.t("operator.prompts.editAgent"),
        run: () =>
          navigate(
            `/operator/agents/${encodeURIComponent(props.agent)}/edit?dir=${encodeURIComponent(props.directory)}`,
          ),
      }
    if (section.layer === `${PREFIX}generated.instructions`)
      return {
        label: language.t("operator.prompts.openMemory"),
        run: () => navigate(`/operator/memory?dir=${encodeURIComponent(props.directory)}`),
      }
    // A slot that resolved to a model family's base prompt opens that text.
    const layer =
      section.layer.startsWith(`${PREFIX}slot.`) && section.source.startsWith("base.")
        ? `${PREFIX}${section.source}`
        : section.layer
    return { label: language.t("operator.prompts.edit"), run: () => open(layer) }
  }

  return (
    <>
      <section data-component="operator-panel">
        <Field group label={language.t("operator.column.model")} hint={language.t("operator.prompts.modelHint")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.column.model")}
            options={models()}
            current={store.model}
            label={(value) => (value === AGENT_MODEL ? language.t("operator.prompts.agentModel") : value)}
            onSelect={(value) => value && setStore("model", value)}
          />
        </Field>
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
            <p data-slot="operator-note">
              {language.t("operator.prompts.summary", {
                model: data().model,
                count: data().sections.length,
                chars: formatCount(
                  data().system.reduce((total, item) => total + item.length, 0),
                  language.intl(),
                ),
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
                      <span data-slot="operator-cell-clamp" title={section.source}>
                        {source(section)}
                      </span>
                      <span data-slot="operator-note">
                        {language.t("operator.prompts.chars", {
                          count: formatCount(section.text.length, language.intl()),
                        })}
                      </span>
                    </span>
                    <ButtonV2 size="small" variant="outline" onClick={() => action(section).run()}>
                      {action(section).label}
                    </ButtonV2>
                  </div>
                  <pre data-component="operator-code">{section.text}</pre>
                </section>
              )}
            </For>
            <section data-component="operator-panel">
              <h2 data-slot="operator-panel-title">{language.t("operator.prompts.perTurn")}</h2>
              <p data-slot="operator-note">{language.t("operator.prompts.perTurnHint")}</p>
              <ButtonV2 size="small" variant="outline" onClick={() => open(`${PREFIX}reminder.plan`)}>
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
