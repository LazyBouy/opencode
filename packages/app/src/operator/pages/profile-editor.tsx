import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { OrderedList } from "../ui/ordered-list"
import { usePromptCatalog, useProfileNames } from "./profile-data"
import {
  type Catalog,
  DYNAMIC,
  HELPER,
  type Layer,
  layersOfType,
  regroup,
  type Section,
  slotProblem,
  type Slots,
} from "./profile-model"

export type SlotValue = { group: string; slots: Slots }

// A profile's group and slots: one panel per type of the group, in its order, each an ordered list of
// layers. Profile Definition edits a profile with it; an agent's Override edits the agent's copy, and
// then marks the slots it changed.
export function SlotEditor(props: {
  ns: string
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  value: SlotValue
  disabled?: boolean
  /** Leave out the group select (a read-only view shows the group elsewhere). */
  hideGroup?: boolean
  /** Leave helper groups out of the group select (an agent's override cannot make it a helper). */
  noHelper?: boolean
  changed?: (type: string) => boolean
  groupChanged?: boolean
  onReset?: (type: string) => void
  onResetGroup?: () => void
  onChange: (value: SlotValue, type?: string) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const confirm = useConfirm()
  const group = createMemo(() => props.catalog.groups.find((item) => item.id === props.value.group))
  const layerName = (id: string) => {
    const found = props.layers.find((layer) => layer.id === id)
    return found ? names.layer(found) : id
  }
  const problem = () => slotProblem(props.catalog, props.value.slots, group()?.types)

  const pickGroup = async (id: string) => {
    const next = props.catalog.groups.find((item) => item.id === id)
    if (!next || id === props.value.group) return
    const result = regroup(props.value.slots, next.types)
    if (result.dropped.length) {
      const ok = await confirm({
        title: language.t("operator.profile.regroupTitle", { group: names.group(next) }),
        description: language.t("operator.profile.regroupBody", {
          types: result.dropped.map((type) => names.typeId(props.catalog, type)).join(", "),
        }),
        confirm: language.t("operator.profile.regroup"),
      })
      if (!ok) return
    }
    props.onChange({ group: id, slots: result.slots })
  }
  const setSlot = (type: string, ids: string[]) =>
    props.onChange({ group: props.value.group, slots: { ...props.value.slots, [type]: ids } }, type)

  return (
    <div class="flex flex-col gap-3">
      <Show when={!props.hideGroup}>
        <Field group label={language.t("operator.profile.group")} hint={language.t("operator.profile.groupHint")}>
          <div class="flex items-center gap-2 flex-wrap">
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.profile.group")}
              disabled={props.disabled}
              options={props.catalog.groups
                .filter((item) => !props.noHelper || !item.types.includes(HELPER))
                .map((item) => item.id)}
              current={props.value.group}
              label={(id) => {
                const found = props.catalog.groups.find((item) => item.id === id)
                return found ? names.group(found) : id
              }}
              onSelect={(id) => id && void pickGroup(id)}
            />
            <Show when={props.groupChanged}>
              <Tag>{language.t("operator.profile.changed")}</Tag>
              <Show when={props.onResetGroup}>
                <ButtonV2 size="small" variant="ghost" onClick={() => props.onResetGroup!()}>
                  {language.t("operator.profile.resetGroup")}
                </ButtonV2>
              </Show>
            </Show>
          </div>
        </Field>
      </Show>
      <For each={group()?.types ?? []}>
        {(type) => (
          <section data-slot="operator-slot" data-type={type} data-changed={props.changed?.(type) ? "" : undefined}>
            <div data-slot="operator-panel-head">
              <h3 data-slot="operator-slot-title">
                {names.typeId(props.catalog, type)}
                <Show when={type === "purpose"}>
                  <Tag>{language.t("operator.profile.locked")}</Tag>
                </Show>
                <Show when={props.changed?.(type)}>
                  <Tag>{language.t("operator.profile.changed")}</Tag>
                </Show>
              </h3>
              <Show when={props.changed?.(type) && props.onReset}>
                <ButtonV2 size="small" variant="ghost" onClick={() => props.onReset!(type)}>
                  {language.t("operator.profile.resetSlot")}
                </ButtonV2>
              </Show>
            </div>
            <Show
              when={type !== "purpose"}
              fallback={
                <>
                  <ol data-component="operator-layers" aria-label={names.typeId(props.catalog, type)}>
                    <li data-slot="operator-layer">
                      <span data-slot="operator-layer-open">{language.t("operator.profile.orgPurpose")}</span>
                    </li>
                    <li data-slot="operator-layer">
                      <span data-slot="operator-layer-open">{language.t("operator.profile.projectPurpose")}</span>
                    </li>
                  </ol>
                  <p data-slot="operator-note">{language.t("operator.profile.purposeAutomatic")}</p>
                </>
              }
            >
              <OrderedList
                label={names.typeId(props.catalog, type)}
                items={props.value.slots[type] ?? []}
                name={layerName}
                disabled={props.disabled}
                badge={(id) => {
                  const delivery = props.layers.find((layer) => layer.id === id)?.delivery
                  return delivery ? <Tag>{language.t(`operator.profile.delivery.${delivery}`)}</Tag> : undefined
                }}
                onChange={(ids) => setSlot(type, ids)}
              />
              <Show when={(props.value.slots[type] ?? []).length === 0}>
                <p data-slot="operator-note">{language.t("operator.profile.emptySlot")}</p>
              </Show>
              <Show when={!props.disabled}>
                <AddLayer
                  ns={props.ns}
                  catalog={props.catalog}
                  type={type}
                  options={layersOfType(props.layers, type).filter(
                    (layer) => !(props.value.slots[type] ?? []).includes(layer.id),
                  )}
                  // A helper profile holds one helper layer: a new one replaces it.
                  onAdd={(id) => setSlot(type, type === HELPER ? [id] : [...(props.value.slots[type] ?? []), id])}
                />
              </Show>
            </Show>
          </section>
        )}
      </For>
      <Show when={problem()}>
        {(found) => (
          <p data-slot="operator-error" role="alert">
            {found().kind === "helper"
              ? language.t("operator.profile.oneHelper")
              : found().kind === "repeated"
                ? language.t("operator.profile.repeated", { layer: layerName(found().layer) })
                : language.t("operator.profile.twoCopies", { layer: found().layer.replace("opencode:", "") })}
          </p>
        )}
      </Show>
    </div>
  )
}

// The section a layer created inside a slot is filed under in Layer Definition.
function sectionFor(type: string): Section {
  if (type === "role" || type === "identity" || type === HELPER || type === DYNAMIC) return type
  return "custom"
}

// Adds an existing layer of the slot's type, or writes a new one in the namespace and adds it.
function AddLayer(props: {
  ns: string
  catalog: Catalog
  type: string
  options: ReadonlyArray<Layer>
  onAdd: (id: string) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const [creating, setCreating] = createSignal(false)
  const [store, setStore] = createStore({ name: "", text: "", busy: false })

  const create = async () => {
    setStore("busy", true)
    await client()
      .layer.create({
        ns: props.ns,
        name: store.name.trim(),
        type: props.type,
        section: sectionFor(props.type),
        // A Dynamic layer is a prompt the dynamic generator writes from, for each session.
        ...(props.type === DYNAMIC ? { text: "", prompt: store.text.trim() } : { text: store.text }),
      })
      .then(async (result) => {
        await data.refresh()
        if (result.data) props.onAdd(result.data.id)
        setStore({ name: "", text: "" })
        setCreating(false)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }

  return (
    <Show
      when={creating()}
      fallback={
        <div class="flex items-center gap-2 flex-wrap">
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.addLayerTo", { type: names.typeId(props.catalog, props.type) })}
            placeholder={language.t("operator.profile.addLayer")}
            options={props.options.map((layer) => layer.id)}
            label={(id) => {
              const found = props.options.find((layer) => layer.id === id)
              return found ? names.layer(found) : id
            }}
            onSelect={(id) => id && props.onAdd(id)}
          />
          <ButtonV2 size="small" variant="ghost" onClick={() => setCreating(true)}>
            {language.t("operator.profile.createLayer")}
          </ButtonV2>
        </div>
      }
    >
      <div data-component="operator-form" role="group" aria-label={language.t("operator.profile.createLayer")}>
        <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.help.newLayerName")}>
          <TextInputV2
            appearance="base"
            value={store.name}
            onInput={(event) => setStore("name", event.currentTarget.value)}
          />
        </Field>
        <Field
          label={language.t(props.type === DYNAMIC ? "operator.profile.prompt" : "operator.prompts.text")}
          hint={language.t(props.type === DYNAMIC ? "operator.help.layerPrompt" : "operator.help.newLayerText")}
        >
          <TextareaV2 rows={5} value={store.text} onInput={(event) => setStore("text", event.currentTarget.value)} />
        </Field>
        <div data-slot="operator-actions">
          <ButtonV2 variant="neutral" onClick={() => setCreating(false)}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            disabled={store.busy || !store.name.trim() || (props.type === DYNAMIC && !store.text.trim())}
            onClick={() => void create()}
          >
            {language.t("operator.profile.createAndAdd")}
          </ButtonV2>
        </div>
      </div>
    </Show>
  )
}
