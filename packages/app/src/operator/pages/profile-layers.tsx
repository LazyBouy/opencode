import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { useAllLayers, usePromptCatalog, useProfileNames } from "./profile-data"
import { type Catalog, type Layer, origin, profilesUsing, type Section, SECTIONS, WRITTEN } from "./profile-model"

// Each Layer Definition section's icon in the overlay's menu.
const ICONS: Record<Section, OverlayBlock["icon"]> = {
  base: "models",
  purpose: "task",
  role: "subagent",
  identity: "brain",
  tool: "console",
  generated: "code-lines",
  output: "align-right",
  custom: "pencil-line",
  message: "speech-bubble",
}

// The layers Layer Definition lists: the namespace's and the built-ins (with every tool's
// description). The org purpose is not one: it comes from the namespace (Settings → Namespaces).
function useLayers(ns: () => string) {
  const data = usePromptCatalog(ns)
  const all = useAllLayers(() => data.query.data)
  return { data, layers: createMemo(() => all().filter((layer) => layer.origin !== "automatic")) }
}

// Where a layer comes from, and what uses it, in words.
function useLayerWords(catalog: () => Catalog | undefined, layers: () => ReadonlyArray<Layer>) {
  const language = useLanguage()
  const names = useProfileNames()
  return {
    origin: (layer: Layer) => {
      const kind = origin(layer)
      if (kind !== "copy") return language.t(`operator.profile.origin.${kind}`)
      const original = layers().find((item) => item.id === layer.replaces)
      return language.t("operator.profile.origin.copy", {
        name: original ? names.layer(original) : (layer.replaces ?? ""),
      })
    },
    usedIn: (layer: Layer) => {
      const loaded = catalog()
      if (!loaded) return ""
      const profiles = profilesUsing(loaded, layer.id).map((profile) => names.profile(profile))
      const projects = loaded.projects.filter((project) => project.purpose === layer.id).map((project) => project.name)
      return [...profiles, ...projects.map((name) => language.t("operator.profile.projectName", { name }))].join(", ")
    },
  }
}

// Layer Definition: every layer of the namespace by section. A layer opens in the overlay.
export function LayerDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const { data, layers } = useLayers(() => props.ns)
  const catalog = () => data.query.data
  const words = useLayerWords(catalog, layers)
  const [params, setParams] = useSearchParams<{ layer?: string; block?: string; q?: string }>()
  useRecordOverlay(
    () => !!(params.layer || params.block),
    () => <LayerOverlay ns={props.ns} namespaces={props.namespaces} />,
    () => setParams({ layer: undefined, block: undefined }),
  )

  const sections = createMemo(() => {
    const query = (params.q ?? "").trim().toLowerCase()
    const shown = layers().filter(
      (layer) =>
        !query || `${layer.id} ${layer.name} ${names.layer(layer)} ${layer.text}`.toLowerCase().includes(query),
    )
    return SECTIONS.map((section) => ({ ...section, rows: shown.filter((layer) => layer.section === section.id) }))
  })

  return (
    <div class="flex flex-col gap-4 min-w-0">
      <div data-slot="operator-toolbar">
        <TextInputV2
          type="search"
          appearance="base"
          value={params.q ?? ""}
          placeholder={language.t("operator.profile.searchLayers")}
          aria-label={language.t("operator.profile.searchLayers")}
          onInput={(event) => setParams({ q: event.currentTarget.value || undefined })}
        />
      </div>
      <For each={sections()}>
        {(section) => (
          <section data-component="operator-panel" data-section={section.id}>
            <div data-slot="operator-panel-head">
              <h2 data-slot="operator-panel-title">{names.section(section.id)}</h2>
              <Show when={WRITTEN.includes(section.id)}>
                <ButtonV2 size="small" variant="outline" onClick={() => setParams({ layer: `new:${section.id}` })}>
                  {section.id === "purpose"
                    ? language.t("operator.profile.newPurpose")
                    : language.t("operator.profile.newLayer")}
                </ButtonV2>
              </Show>
            </div>
            <p data-slot="operator-note">{language.t(`operator.layerSection.about.${section.id}`)}</p>
            <DataTable
              columnsKey="profile-layers"
              label={names.section(section.id)}
              rows={section.rows}
              loading={data.query.isPending}
              empty={
                section.id === "purpose"
                  ? language.t("operator.profile.noPurposes")
                  : language.t("operator.profile.noLayers")
              }
              onRowClick={(row) => setParams({ layer: row.id, block: section.id })}
              columns={[
                {
                  id: "name",
                  header: language.t("operator.column.name"),
                  value: (row) => names.layer(row),
                  cell: (row) => (
                    <span class="flex items-center gap-2">
                      {names.layer(row)}
                      <Show when={row.delivery}>
                        {(delivery) => <Tag>{language.t(`operator.profile.delivery.${delivery()}`)}</Tag>}
                      </Show>
                    </span>
                  ),
                },
                {
                  id: "type",
                  optional: true,
                  header: language.t("operator.profile.type"),
                  value: (row) => row.type,
                  cell: (row) => names.typeId(catalog(), row.type),
                },
                {
                  id: "origin",
                  optional: true,
                  header: language.t("operator.profile.origin"),
                  cell: (row) => words.origin(row),
                },
                {
                  id: "used",
                  optional: true,
                  header: language.t("operator.profile.usedIn"),
                  cell: (row) => <span data-slot="operator-cell-clamp">{words.usedIn(row)}</span>,
                },
              ]}
            />
          </section>
        )}
      </For>
    </div>
  )
}

// The overlay of Layer Definition: its sections on the left, a section's layers or one layer.
function LayerOverlay(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const { data, layers } = useLayers(() => props.ns)
  const [params, setParams] = useSearchParams<{ layer?: string; block?: string }>()
  const [editing, setEditing] = createSignal(false)
  const creating = () => SECTIONS.find((item) => `new:${item.id}` === params.layer)?.id
  const block = () =>
    creating() ??
    layers().find((layer) => layer.id === params.layer)?.section ??
    SECTIONS.find((item) => item.id === params.block)?.id ??
    SECTIONS[0]!.id
  const blocks = createMemo<OverlayBlock[]>(() =>
    SECTIONS.map((section) => ({
      id: section.id,
      label: names.section(section.id),
      icon: ICONS[section.id],
      description: language.t(`operator.layerSection.about.${section.id}`),
      empty:
        section.id === "purpose" ? language.t("operator.profile.noPurposes") : language.t("operator.profile.noLayers"),
      create: WRITTEN.includes(section.id)
        ? {
            label:
              section.id === "purpose"
                ? language.t("operator.profile.newPurpose")
                : language.t("operator.profile.newLayer"),
            run: () => setParams({ layer: `new:${section.id}`, block: section.id }),
          }
        : undefined,
      records: layers()
        .filter((layer) => layer.section === section.id)
        .map((layer) => ({
          id: layer.id,
          label: names.layer(layer),
          detail: names.typeId(data.query.data, layer.type),
        })),
    })),
  )

  return (
    <RecordOverlay
      title={language.t("operator.profile.tab.layers")}
      blocks={blocks()}
      block={block()}
      record={params.layer}
      editing={editing()}
      onBlock={(id) => setParams({ block: id, layer: undefined })}
      onRecord={(id, layer) => setParams({ block: id, layer })}
    >
      <Show when={data.query.data}>
        {(catalog) => (
          <LayerRecord
            ns={props.ns}
            namespaces={props.namespaces}
            selected={params.layer!}
            catalog={catalog()}
            layers={layers()}
            onEditing={setEditing}
            onSelect={(layer) => setParams({ layer, block: layer ? undefined : block() })}
          />
        )}
      </Show>
    </RecordOverlay>
  )
}

// One layer: read-only, with Edit for the namespace's own layers (Cancel or Save then), and Make
// editable copy for OpenCode's texts. A new layer opens straight in edit mode.
function LayerRecord(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  selected: string
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  onEditing: (editing: boolean) => void
  onSelect: (layer: string | undefined) => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const words = useLayerWords(
    () => props.catalog,
    () => props.layers,
  )
  const creating = () => SECTIONS.find((item) => `new:${item.id}` === props.selected)?.id
  const layer = createMemo(() => props.layers.find((item) => item.id === props.selected))
  const [store, setStore] = createStore({ name: "", type: "", text: "", busy: false, editing: false })
  const reset = () => {
    const found = layer()
    setStore({
      name: found?.name ?? "",
      type: found?.type ?? SECTIONS.find((item) => item.id === creating())?.type ?? "identity",
      text: found?.text ?? "",
      editing: !!creating(),
    })
  }
  createEffect(on(() => props.selected, reset))
  createEffect(() => props.onEditing(store.editing))
  const editable = () => layer()?.origin === "user"
  // A layer's type changes only in Custom; copies keep their built-in's type.
  const typeEditable = () => (creating() ?? layer()?.section) === "custom" && !layer()?.replaces
  const types = () => props.catalog.types.filter((type) => type.id !== "purpose")
  const linked = () => props.catalog.projects.filter((project) => project.purpose === props.selected)

  const cancel = () => {
    if (creating()) return props.onSelect(undefined)
    reset()
  }
  const save = async () => {
    setStore("busy", true)
    const body = { ns: props.ns, name: store.name.trim(), type: store.type, text: store.text }
    await (
      creating()
        ? client().layer.create({ ...body, section: creating() })
        : client().layer.update({ ...body, id: props.selected })
    )
      .then(async (result) => {
        await data.refresh()
        setStore("editing", false)
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const copy = async () => {
    const found = layer()
    if (!found) return
    setStore("busy", true)
    await client()
      .layer.copy({ ns: props.ns, id: found.id, ...(found.section === "tool" ? { text: found.text } : {}) })
      .then(async (result) => {
        await data.refresh()
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const remove = async () => {
    const found = layer()
    if (!found) return
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: found.name }),
      description: language.t("operator.profile.deleteLayerBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await client()
      .layer.remove({ ns: props.ns, id: found.id })
      .then(async () => {
        await data.refresh()
        props.onSelect(undefined)
      })
      .catch(data.fail)
  }

  const form = () => (
    <div data-component="operator-form">
      <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.help.layerName")}>
        <TextInputV2
          appearance="base"
          value={store.name}
          onInput={(event) => setStore("name", event.currentTarget.value)}
        />
      </Field>
      <Field group label={language.t("operator.profile.type")} hint={language.t("operator.help.layerType")}>
        <Show when={typeEditable()} fallback={<span>{names.typeId(props.catalog, store.type)}</span>}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.type")}
            options={types().map((type) => type.id)}
            current={store.type}
            label={(id) => names.typeId(props.catalog, id)}
            onSelect={(id) => id && setStore("type", id)}
          />
        </Show>
      </Field>
      <Field
        label={language.t("operator.prompts.text")}
        hint={language.t("operator.help.layerText")}
        note={language.t("operator.profile.chars", { count: store.text.length })}
      >
        <TextareaV2
          class="operator-editor"
          rows={14}
          value={store.text}
          onInput={(event) => setStore("text", event.currentTarget.value)}
        />
      </Field>
    </div>
  )

  return (
    <Show
      when={!store.editing}
      fallback={
        <RecordView
          title={
            creating()
              ? creating() === "purpose"
                ? language.t("operator.profile.newPurpose")
                : language.t("operator.profile.newIn", { section: names.section(creating()!) })
              : language.t("operator.profile.editing", { name: layer()?.name ?? "" })
          }
          actions={
            <>
              <ButtonV2 variant="neutral" onClick={cancel}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="contrast" disabled={store.busy || !store.name.trim()} onClick={() => void save()}>
                {language.t("operator.config.save")}
              </ButtonV2>
            </>
          }
        >
          {form()}
        </RecordView>
      }
    >
      <Show when={layer()} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchLayer")}</p>}>
        {(found) => (
          <RecordView
            title={
              <>
                {names.layer(found())}
                <Show when={found().delivery}>
                  {(delivery) => <Tag>{language.t(`operator.profile.delivery.${delivery()}`)}</Tag>}
                </Show>
              </>
            }
            actions={
              <>
                <Show when={editable()}>
                  <ButtonV2 variant="contrast" onClick={() => setStore("editing", true)}>
                    {language.t("operator.profile.edit")}
                  </ButtonV2>
                  <CopyToNamespace
                    ns={props.ns}
                    kind="layer"
                    id={found().id}
                    namespaces={props.namespaces}
                    onCopied={() => void data.refresh()}
                  />
                  <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                    {language.t("operator.agent.delete")}
                  </ButtonV2>
                </Show>
                <Show when={found().origin === "builtin"}>
                  <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void copy()}>
                    {language.t("operator.profile.makeCopy")}
                  </ButtonV2>
                </Show>
                <Show when={found().id === "opencode:generated.instructions"}>
                  <ButtonV2 variant="outline" onClick={() => navigate("/operator/memory")}>
                    {language.t("operator.prompts.openMemory")}
                  </ButtonV2>
                </Show>
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.profile.type")} help={language.t("operator.help.layerType")}>
                {names.typeId(props.catalog, found().type)}
              </RecordField>
              <RecordField
                label={language.t("operator.profile.section")}
                help={language.t("operator.help.layerSection")}
              >
                {names.section(found().section)}
              </RecordField>
              <RecordField label={language.t("operator.profile.origin")} help={language.t("operator.help.layerOrigin")}>
                {words.origin(found())}
              </RecordField>
              <Show when={found().replaces}>
                {(original) => (
                  <RecordField
                    label={language.t("operator.profile.copyOf")}
                    help={language.t("operator.profile.copyNote")}
                  >
                    <button type="button" data-slot="operator-link" onClick={() => props.onSelect(original())}>
                      {original().replace("opencode:", "")}
                    </button>
                  </RecordField>
                )}
              </Show>
              <RecordField label={language.t("operator.profile.usedIn")} help={language.t("operator.help.layerUsedIn")}>
                {words.usedIn(found()) || "—"}
              </RecordField>
              <Show when={linked().length}>
                <RecordField
                  label={language.t("operator.profile.linkedByLabel")}
                  help={language.t("operator.help.layerLinked")}
                >
                  {linked()
                    .map((project) => shortPath(project.key))
                    .join(", ")}{" "}
                  <button type="button" data-slot="operator-link" onClick={() => navigate("/operator/projects")}>
                    {language.t("operator.page.projects.title")}
                  </button>
                </RecordField>
              </Show>
              <Show when={names.about(found())}>
                {(about) => (
                  <RecordField
                    label={language.t("operator.profile.about")}
                    help={language.t("operator.help.layerAbout")}
                  >
                    {about()}
                  </RecordField>
                )}
              </Show>
              <Show when={found().text}>
                <RecordField label={language.t("operator.prompts.text")} help={language.t("operator.help.layerText")}>
                  <pre data-component="operator-code">{found().text}</pre>
                </RecordField>
              </Show>
            </dl>
            <Show when={found().origin === "builtin"}>
              <p data-slot="operator-note">{language.t("operator.profile.copyNote")}</p>
            </Show>
          </RecordView>
        )}
      </Show>
    </Show>
  )
}
