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
import { useQuery } from "@tanstack/solid-query"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useOperatorProjects } from "../project"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { NamespaceAction } from "../ui/namespace-picker"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { requestError } from "./config-helpers"
import { usePromptRefresh, useProfileNames, useScopeCatalogs, useToolLayers } from "./profile-data"
import {
  ALL,
  type Catalog,
  DYNAMIC,
  isWrittenDynamic,
  type Layer,
  origin,
  PREFIX,
  type Section,
  SECTIONS,
  WRITTEN,
} from "./profile-model"
import { PurposeDraft } from "./purpose-draft"

// Each Layer Definition section's icon in the overlay's menu.
const ICONS: Record<Section, OverlayBlock["icon"]> = {
  base: "models",
  purpose: "task",
  role: "subagent",
  identity: "brain",
  tool: "console",
  dynamic: "code-lines",
  helper: "help",
  output: "align-right",
  custom: "pencil-line",
  message: "speech-bubble",
}

// A layer as Layer Definition lists it: with its namespace, or none for OpenCode's built-ins (the
// same in every namespace).
type Row = { ns: string | undefined; item: Layer }

// The layers of the namespaces in scope: each namespace's own, then OpenCode's (with every tool's
// description). The org purpose is not one: it comes from the namespace (Settings → Namespaces).
function useLayers(ns: () => string, namespaces: () => ReadonlyArray<OperatorNamespaceSummary>) {
  const catalogs = useScopeCatalogs(ns, namespaces)
  const tools = useToolLayers(catalogs.first)
  const rows = createMemo<Row[]>(() => [
    ...catalogs
      .scoped(
        (catalog) => catalog.layers,
        (layer) => layer.origin !== "user",
      )
      .filter((row) => row.item.origin !== "automatic"),
    ...tools().map((item) => ({ ns: undefined, item })),
  ])
  return { catalogs, rows }
}

// The key of a row in the overlay: the id, with its namespace when all namespaces are shown.
const keyOf = (row: Row, all: boolean) => (all && row.ns ? `${row.ns}|${row.item.id}` : row.item.id)

// Where a layer comes from, in words.
function useLayerWords(rows: () => ReadonlyArray<Row>) {
  const language = useLanguage()
  const names = useProfileNames()
  return {
    origin: (layer: Layer) => {
      const kind = origin(layer)
      if (kind !== "copy") return language.t(`operator.profile.origin.${kind}`)
      const original = rows().find((row) => row.item.id === layer.replaces)?.item
      return language.t("operator.profile.origin.copy", {
        name: original ? names.layer(original) : (layer.replaces ?? ""),
      })
    },
  }
}

// Layer Definition: every layer of the namespaces in scope, by section. A layer opens in the overlay.
export function LayerDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const all = () => props.ns === ALL
  const { catalogs, rows } = useLayers(
    () => props.ns,
    () => props.namespaces,
  )
  const words = useLayerWords(rows)
  const nsName = (id: string | undefined) =>
    id
      ? (props.namespaces.find((item) => item.namespace.id === id)?.namespace.name ?? id)
      : language.t("operator.namespace.builtin")
  const [params, setParams] = useSearchParams<{ layer?: string; rns?: string; block?: string; q?: string }>()
  useRecordOverlay(
    () => !!(params.layer || params.block),
    () => <LayerOverlay ns={props.ns} namespaces={props.namespaces} />,
    () => setParams({ layer: undefined, rns: undefined, block: undefined }),
  )

  const sections = createMemo(() => {
    const query = (params.q ?? "").trim().toLowerCase()
    const shown = rows().filter(
      (row) =>
        !query ||
        `${row.item.id} ${row.item.name} ${names.layer(row.item)} ${row.item.text}`.toLowerCase().includes(query),
    )
    return SECTIONS.map((section) => ({ ...section, rows: shown.filter((row) => row.item.section === section.id) }))
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
                <NamespaceAction
                  size="small"
                  label={language.t(`operator.profile.new.${section.id}` as "operator.profile.new.role")}
                  ns={all() ? undefined : props.ns}
                  namespaces={props.namespaces}
                  run={(ns) => setParams({ layer: `new:${section.id}`, rns: ns, block: section.id })}
                />
              </Show>
            </div>
            <p data-slot="operator-note">{language.t(`operator.layerSection.about.${section.id}`)}</p>
            <DataTable
              columnsKey="profile-layers"
              label={names.section(section.id)}
              rows={section.rows}
              loading={catalogs.query.isPending}
              empty={
                section.id === "purpose"
                  ? language.t("operator.profile.noPurposes")
                  : language.t("operator.profile.noLayers")
              }
              onRowClick={(row) => setParams({ layer: row.item.id, rns: row.ns, block: section.id })}
              columns={[
                {
                  id: "name",
                  header: language.t("operator.column.name"),
                  value: (row) => names.layer(row.item),
                  cell: (row) => (
                    <span class="flex items-center gap-2">
                      {names.layer(row.item)}
                      <Show when={row.item.delivery}>
                        {(delivery) => <Tag>{language.t(`operator.profile.delivery.${delivery()}`)}</Tag>}
                      </Show>
                    </span>
                  ),
                },
                ...(all()
                  ? [
                      {
                        id: "namespace",
                        optional: true,
                        header: language.t("operator.column.namespace"),
                        value: (row: Row) => nsName(row.ns),
                        cell: (row: Row) => nsName(row.ns),
                      },
                    ]
                  : []),
                {
                  id: "type",
                  optional: true,
                  header: language.t("operator.profile.type"),
                  value: (row) => row.item.type,
                  cell: (row) => names.typeId(catalogs.of(row.ns) ?? catalogs.first(), row.item.type),
                },
                {
                  id: "origin",
                  optional: true,
                  header: language.t("operator.profile.origin"),
                  cell: (row) => words.origin(row.item),
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
  const all = () => props.ns === ALL
  const { catalogs, rows } = useLayers(
    () => props.ns,
    () => props.namespaces,
  )
  const [params, setParams] = useSearchParams<{ layer?: string; rns?: string; block?: string; edit?: string }>()
  const [editing, setEditing] = createSignal(false)
  // The record's namespace: the one the page shows, or (all of them) the one in the URL.
  const recordNs = () => (all() ? params.rns : props.ns)
  const creating = () => SECTIONS.find((item) => `new:${item.id}` === params.layer)?.id
  const row = createMemo(() =>
    rows().find((item) => item.item.id === params.layer && (!all() || !item.ns || item.ns === params.rns)),
  )
  const block = () =>
    creating() ?? row()?.item.section ?? SECTIONS.find((item) => item.id === params.block)?.id ?? SECTIONS[0]!.id
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
            label: language.t(`operator.profile.new.${section.id}` as "operator.profile.new.role"),
            ns: all() ? undefined : props.ns,
            run: (ns: string) => setParams({ layer: `new:${section.id}`, rns: ns, block: section.id }),
          }
        : undefined,
      records: rows()
        .filter((item) => item.item.section === section.id)
        .map((item) => ({
          id: keyOf(item, all()),
          label: names.layer(item.item),
          detail: all()
            ? (props.namespaces.find((entry) => entry.namespace.id === item.ns)?.namespace.name ??
              language.t("operator.namespace.builtin"))
            : names.typeId(catalogs.first(), item.item.type),
        })),
    })),
  )
  // `edit` opens the record in edit mode (an editable copy just made).
  const open = (key: string | undefined, ns?: string, edit?: boolean) => {
    if (!key) return setParams({ layer: undefined, rns: undefined, block: block(), edit: undefined })
    const [first, second] = key.split("|")
    if (second) return setParams({ layer: second, rns: first, block: undefined, edit: undefined })
    setParams({
      layer: first,
      rns: ns ?? (all() ? undefined : props.ns),
      block: undefined,
      edit: edit ? "1" : undefined,
    })
  }

  return (
    <RecordOverlay
      title={language.t("operator.profile.tab.layers")}
      namespaces={props.namespaces}
      blocks={blocks()}
      block={block()}
      record={
        params.layer ? (all() && params.rns && row()?.ns ? `${params.rns}|${params.layer}` : params.layer) : undefined
      }
      editing={editing()}
      onBlock={(id) => setParams({ block: id, layer: undefined, rns: undefined })}
      onRecord={(_, key) => open(key)}
    >
      <Show when={catalogs.of(recordNs()) ?? catalogs.first()}>
        {(catalog) => (
          <LayerRecord
            ns={recordNs()}
            namespaces={props.namespaces}
            selected={params.layer!}
            catalog={catalog()}
            layers={rows()
              .filter((item) => !item.ns || item.ns === recordNs())
              .map((item) => item.item)}
            edit={params.edit === "1"}
            onEditing={setEditing}
            onSelect={(layer, ns, edit) => open(layer, ns, edit)}
          />
        )}
      </Show>
    </RecordOverlay>
  )
}

// One layer: read-only, with Edit for the namespace's own layers (Cancel or Save then), and Edit a
// copy for OpenCode's texts, which opens the copy in edit mode. OpenCode's Dynamic layers are filled
// in per request: Generate sample shows what one fills in, and Edit at source opens where it comes
// from. A new layer opens straight in edit mode.
function LayerRecord(props: {
  // The layer's namespace; none for OpenCode's layers while all namespaces are shown.
  ns: string | undefined
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  selected: string
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  // Open in edit mode.
  edit: boolean
  onEditing: (editing: boolean) => void
  onSelect: (layer: string | undefined, ns?: string, edit?: boolean) => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const names = useProfileNames()
  const data = usePromptRefresh()
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const words = useLayerWords(() => props.layers.map((item) => ({ ns: props.ns, item })))
  const creating = () => SECTIONS.find((item) => `new:${item.id}` === props.selected)?.id
  const layer = createMemo(() => props.layers.find((item) => item.id === props.selected))
  const [store, setStore] = createStore({ name: "", type: "", text: "", prompt: "", busy: false, editing: false })
  const reset = () => {
    const found = layer()
    setStore({
      name: found?.name ?? "",
      type: found?.type ?? SECTIONS.find((item) => item.id === creating())?.type ?? "identity",
      text: found?.text ?? "",
      prompt: found?.prompt ?? "",
      editing: !!creating() || (props.edit && found?.origin === "user"),
    })
  }
  // Only a change of record resets the form (not a refresh of the data around it).
  const record = createMemo(() => `${props.ns ?? ""}|${props.selected}`)
  createEffect(on(record, reset))
  createEffect(() => props.onEditing(store.editing))
  const editable = () => layer()?.origin === "user"
  // Texts filled in per request: OpenCode's, and yours (written by the dynamic generator).
  const dynamic = () => layer()?.origin === "slot" || layer()?.origin === "generated" || isWrittenDynamic(layer())
  // The form edits a prompt instead of a text: a Dynamic layer of yours.
  const prompted = () => store.type === DYNAMIC
  // The projects a Project Purpose is drafted from: the ones it is linked to, then the namespace's;
  // every known project when the namespace has none.
  const draftProjects = () => {
    const keys = [...linked(), ...props.catalog.projects]
      .map((project) => project.key)
      .filter((key, index, all) => all.indexOf(key) === index)
    return keys.length ? keys : undefined
  }
  // A Project Purpose can be drafted by the purpose generator.
  const purpose = () => (creating() ?? layer()?.section) === "purpose"
  // A layer's type changes only in Custom; copies keep their built-in's type.
  const typeEditable = () => (creating() ?? layer()?.section) === "custom" && !layer()?.replaces
  const types = () => props.catalog.types.filter((type) => type.id !== "purpose")
  const linked = () => props.catalog.projects.filter((project) => project.purpose === props.selected)

  const cancel = () => {
    if (creating()) return props.onSelect(undefined)
    reset()
    setStore("editing", false)
    // A copy opened in edit mode: back to its view.
    if (props.edit) props.onSelect(props.selected, props.ns)
  }
  const save = async () => {
    setStore("busy", true)
    const body = {
      ns: props.ns!,
      name: store.name.trim(),
      type: store.type,
      text: prompted() ? "" : store.text,
      ...(prompted() ? { prompt: store.prompt.trim() } : {}),
    }
    await (
      creating()
        ? client().layer.create({ ...body, section: creating() })
        : client().layer.update({ ...body, id: props.selected })
    )
      .then(async (result) => {
        await data.refresh()
        setStore("editing", false)
        props.onSelect(result.data?.id, props.ns)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const copy = async (ns: string) => {
    const found = layer()
    if (!found) return
    setStore("busy", true)
    await client()
      .layer.copy({ ns, id: found.id, ...(found.section === "tool" ? { text: found.text } : {}) })
      .then(async (result) => {
        await data.refresh()
        props.onSelect(result.data?.id, ns, true)
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
      .layer.remove({ ns: props.ns!, id: found.id })
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
      <Show
        when={!prompted()}
        fallback={
          <Field
            label={language.t("operator.profile.prompt")}
            hint={language.t("operator.help.layerPrompt")}
            note={language.t("operator.profile.chars", { count: store.prompt.length })}
          >
            <TextareaV2
              class="operator-editor"
              rows={8}
              value={store.prompt}
              onInput={(event) => setStore("prompt", event.currentTarget.value)}
            />
          </Field>
        }
      >
        <Show when={purpose()}>
          <PurposeDraft kind="project" projects={draftProjects()} onDraft={(text) => setStore("text", text)} />
        </Show>
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
      </Show>
    </div>
  )

  return (
    <Show
      when={!store.editing}
      fallback={
        <RecordView
          title={
            creating()
              ? language.t(`operator.profile.new.${creating()!}` as "operator.profile.new.role")
              : language.t("operator.profile.editing", { name: layer()?.name ?? "" })
          }
          actions={
            <>
              <ButtonV2 variant="neutral" onClick={cancel}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                disabled={store.busy || !store.name.trim() || (prompted() && !store.prompt.trim())}
                onClick={() => void save()}
              >
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
                    ns={props.ns!}
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
                  <NamespaceAction
                    variant="contrast"
                    label={language.t("operator.profile.makeCopy")}
                    ns={props.ns}
                    namespaces={props.namespaces}
                    disabled={store.busy}
                    run={(ns) => void copy(ns)}
                  />
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
              <Show when={!dynamic()}>
                <RecordField label={language.t("operator.prompts.text")} help={language.t("operator.help.layerText")}>
                  <Show when={found().text} fallback="—">
                    <pre data-component="operator-code">{found().text}</pre>
                  </Show>
                </RecordField>
              </Show>
            </dl>
            <Show when={isWrittenDynamic(found())}>
              <dl data-component="record-fields">
                <RecordField
                  label={language.t("operator.profile.prompt")}
                  help={language.t("operator.help.layerPrompt")}
                >
                  <pre data-component="operator-code">{found().prompt}</pre>
                </RecordField>
              </dl>
            </Show>
            <Show when={dynamic()}>
              <LayerSample layer={found()} catalog={props.catalog} onSelect={(id) => props.onSelect(id)} />
            </Show>
            <Show when={found().origin === "builtin"}>
              <p data-slot="operator-note">{language.t("operator.profile.copyNote")}</p>
            </Show>
          </RecordView>
        )}
      </Show>
    </Show>
  )
}

// What one of OpenCode's Dynamic layers fills in for an agent of a project, made on request, and where
// to change it: the agent, the base prompt layer for the model, Memory, Capabilities or Config.
function LayerSample(props: { layer: Layer; catalog: Catalog; onSelect: (id: string) => void }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const projects = useOperatorProjects()
  const names = useProfileNames()
  const [store, setStore] = createStore({
    project: undefined as string | undefined,
    agent: "build",
    busy: false,
    error: "",
    sample: undefined as { text: string; source: string; agent: string; project: string } | undefined,
  })
  createEffect(
    on(
      () => props.layer.id,
      () => setStore({ sample: undefined, error: "" }),
      { defer: true },
    ),
  )
  const project = () =>
    store.project ?? props.catalog.projects.find((item) => item.registered)?.key ?? projects()[0]?.directory
  const projectName = (key: string) => projects().find((item) => item.directory === key)?.label ?? shortPath(key)
  const agents = useQuery(() => ({
    queryKey: api.key("agents", project()),
    enabled: !!project(),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: project() })
        .then((result) => result.data ?? []),
  }))
  const suffix = () => props.layer.id.slice(PREFIX.length)
  const generate = async () => {
    const directory = project()
    if (!directory) return
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.prompt.sample({ directory, agent: store.agent, layer: props.layer.id })
      .then((result) => {
        if (!result.data) return
        setStore("sample", {
          text: result.data.text,
          source: result.data.source,
          agent: result.data.agent,
          project: directory,
        })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  const scoped = (page: string) => navigate(`/operator/${page}?dir=${encodeURIComponent(project() ?? "")}`)
  // The base prompt layer a sample came from (Base prompt by model, or an agent without a prompt).
  const base = () => (store.sample?.source.startsWith("base.") ? `${PREFIX}${store.sample.source}` : undefined)

  return (
    <section data-component="operator-form" aria-label={language.t("operator.profile.sample")}>
      <div class="flex items-end gap-2 flex-wrap">
        <Field
          group
          label={language.t("operator.profile.sampleProject")}
          hint={language.t("operator.help.sampleProject")}
        >
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.sampleProject")}
            options={projects().map((item) => item.directory)}
            current={project()}
            label={projectName}
            onSelect={(key) => key && setStore({ project: key, sample: undefined })}
          />
        </Field>
        <Field group label={language.t("operator.profile.sampleAgent")} hint={language.t("operator.help.sampleAgent")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.sampleAgent")}
            options={(agents.data ?? []).map((agent) => agent.name)}
            current={store.agent}
            label={(name) => name}
            onSelect={(name) => name && setStore({ agent: name, sample: undefined })}
          />
        </Field>
        <ButtonV2 variant="contrast" disabled={store.busy || !project()} onClick={() => void generate()}>
          {language.t("operator.profile.sample")}
        </ButtonV2>
      </div>
      <Show when={store.error}>
        <p data-slot="operator-error" role="alert">
          {store.error}
        </p>
      </Show>
      <Show when={store.sample}>
        {(sample) => (
          <div class="flex flex-col gap-2" role="status">
            <h4 data-slot="operator-panel-title">
              {language.t("operator.profile.sampleFor", {
                agent: sample().agent,
                project: projectName(sample().project),
              })}
            </h4>
            <Show
              when={sample().text}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.sampleEmpty")}</p>}
            >
              <pre data-component="operator-code">{sample().text}</pre>
            </Show>
            <p data-slot="operator-note">
              {language.t(
                isWrittenDynamic(props.layer) ? "operator.profile.sampleNoteWritten" : "operator.profile.sampleNote",
              )}
            </p>
          </div>
        )}
      </Show>
      <div data-slot="operator-actions">
        <Show when={suffix() === "slot.agent" || suffix() === "slot.agent-or-base"}>
          <ButtonV2
            variant="outline"
            onClick={() =>
              navigate(`/operator/agents/${encodeURIComponent(store.agent)}?dir=${encodeURIComponent(project() ?? "")}`)
            }
          >
            {language.t("operator.profile.source.agent")}
          </ButtonV2>
        </Show>
        <Show when={base()}>
          {(id) => (
            <ButtonV2 variant="outline" onClick={() => props.onSelect(id())}>
              {language.t("operator.profile.source.base", {
                name: names.layer({ id: id(), name: store.sample!.source }),
              })}
            </ButtonV2>
          )}
        </Show>
        <Show when={suffix() === "generated.instructions"}>
          <ButtonV2 variant="outline" onClick={() => scoped("memory")}>
            {language.t("operator.profile.source.instructions")}
          </ButtonV2>
        </Show>
        <Show when={suffix() === "generated.skills" || suffix() === "generated.mcp"}>
          <ButtonV2 variant="outline" onClick={() => scoped("capabilities")}>
            {language.t("operator.profile.source.skills")}
          </ButtonV2>
        </Show>
        <Show when={suffix() === "generated.references"}>
          <ButtonV2 variant="outline" onClick={() => scoped("config")}>
            {language.t("operator.profile.source.references")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={suffix() === "generated.environment"}>
        <p data-slot="operator-note">{language.t("operator.profile.source.environment")}</p>
      </Show>
    </section>
  )
}
