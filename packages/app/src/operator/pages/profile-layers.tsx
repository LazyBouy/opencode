import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "../ui/select"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorNamespaceSummary, OperatorPromptSample, OperatorResolver } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useQuery } from "@tanstack/solid-query"
import { ready, useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useOperatorProjects } from "../project"
import { useRememberedProject } from "../scope"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { NamespaceAction } from "../ui/namespace-picker"
import { TraceList } from "../ui/prompt-trace"
import { Resolution } from "../ui/resolution"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { requestError } from "./config-helpers"
import { usePromptRefresh, useProfileNames, useScopeCatalogs, useToolLayers } from "./profile-data"
import {
  ALL,
  type Catalog,
  DEPENDS_ON,
  DYNAMIC,
  dynamicKey,
  isPerRequest,
  isWrittenDynamic,
  type Layer,
  OPENCODE,
  origin,
  PREFIX,
  type Section,
  SECTIONS,
  WRITTEN,
} from "./profile-model"
import { PurposeDraft } from "./purpose-draft"
import { hasHelper, RulesForm, RulesView } from "./layer-rules"
import { useHelpers } from "./helper-data"
import { LAYER_ACTIONS } from "./helper-form"
import { useOverlayParams } from "../ui/overlay-nav"

// Test resolve's model and session choices: the agent's own model; no session.
const AGENT_MODEL = "agent"
const NO_SESSION = "none"

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

// A layer as Layer Definition lists it: with its namespace, or none for OpenCode's built-ins (listed
// under OpenCode only; other namespaces have their own copies).
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
    // Tool descriptions are OpenCode's built-ins (another namespace holds copies of the ones it changed).
    ...(catalogs.of(OPENCODE) ? tools().map((item) => ({ ns: undefined, item })) : []),
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
    ["layer", "rns", "block"],
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
  const [params, setParams] = useOverlayParams<{ layer?: string; rns?: string; block?: string; edit?: string }>()
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
  const [store, setStore] = createStore({
    name: "",
    type: "",
    text: "",
    prompt: "",
    busy: false,
    editing: false,
    rules: undefined as OperatorResolver | undefined,
    // Your Dynamic layer's writer: a helper of the namespace that only reads ("": the default).
    writer: "",
  })
  // The helpers that may write or judge a Dynamic layer (agent_types_spec.md §4.6): the namespace's own, reading only.
  // Asked for only for layers whose rules are edited in one namespace, and read without holding the form back.
  const DEFAULT_WRITER = "@default"
  const helpers = useHelpers(
    () => props.ns,
    () =>
      !!props.ns &&
      props.ns !== ALL &&
      (isWrittenDynamic(layer()) ||
        SECTIONS.find((item) => item.id === creating())?.type === DYNAMIC ||
        // A copy of one of OpenCode's per-request layers with editable rules (rulesEditable, below): its judge.
        (!!layer()?.replaces && props.catalog.editableRules.includes(layer()!.replaces!))),
  )
  const writers = () =>
    (ready(helpers) ?? [])
      .filter((item) => !item.builtin && item.actions.every((action) => LAYER_ACTIONS.includes(action)))
      .map((item) => item.name)
  // Without a writer of its own: the namespace's Dynamic generator role, else OpenCode's.
  const defaultWriter = () => {
    const holder = (ready(helpers) ?? []).find((item) => !item.builtin && item.roles.includes("dynamic-generator"))
    return holder
      ? language.t("operator.layer.writerRole", { name: holder.name })
      : language.t("operator.layer.writerBuiltin")
  }
  // A Dynamic layer's rules: its own, else OpenCode's (its built-in's, for a copy), else the helper's.
  const rulesOf = (found: Layer | undefined): OperatorResolver | undefined => {
    if (!found)
      return SECTIONS.find((item) => item.id === creating())?.type === DYNAMIC ? props.catalog.helperRules : undefined
    if (found.origin !== "user") return props.catalog.resolvers[found.id]
    return found.resolver ?? (found.replaces ? props.catalog.resolvers[found.replaces] : undefined)
  }
  const reset = () => {
    const found = layer()
    setStore({
      name: found?.name ?? "",
      type: found?.type ?? SECTIONS.find((item) => item.id === creating())?.type ?? "identity",
      text: found?.text ?? "",
      prompt: found?.prompt ?? "",
      editing: !!creating() || (props.edit && found?.origin === "user"),
      rules: rulesOf(found),
      writer: found?.writer ?? "",
    })
  }
  // Only a change of record resets the form (not a refresh of the data around it).
  const record = createMemo(() => `${props.ns ?? ""}|${props.selected}`)
  createEffect(on(record, reset))
  createEffect(() => props.onEditing(store.editing))
  const editable = () => layer()?.origin === "user"
  // Texts filled in per request: OpenCode's, and yours (written by the dynamic generator).
  const dynamic = () => isPerRequest(layer()) || isWrittenDynamic(layer())
  // The form edits a prompt instead of a text: a Dynamic layer of yours.
  const prompted = () => store.type === DYNAMIC && !layer()?.replaces
  // A namespace's copy of a per-request layer has no text: only its name changes.
  const nameOnly = () => isPerRequest(layer())
  // The rules can be edited for your Dynamic layers, and a namespace's copy of one of OpenCode's per-request
  // layers whose sources any layer can read (dynamic_layer_resolution_spec.md §6).
  const rulesEditable = () =>
    prompted() || (!!layer()?.replaces && props.catalog.editableRules.includes(layer()!.replaces!))
  // Your Dynamic layer needs its prompt while a helper source writes from it.
  const needsPrompt = () => prompted() && hasHelper(store.rules)
  // What the rules shown are: OpenCode's, the helper's default, a copy's (inherited or its own), yours.
  const rulesNote = (found: Layer) => {
    if (found.origin !== "user")
      return language.t(
        props.catalog.editableRules.includes(found.id)
          ? "operator.layerRules.note.opencodeCopy"
          : "operator.layerRules.note.opencode",
      )
    if (found.replaces)
      return language.t(found.resolver ? "operator.layerRules.note.instead" : "operator.layerRules.note.follows")
    return language.t(
      JSON.stringify(found.resolver) === JSON.stringify(props.catalog.helperRules)
        ? "operator.layerRules.note.helper"
        : "operator.layerRules.note.own",
    )
  }
  // A copy of one of OpenCode's texts takes OpenCode's current text (after a release changed it).
  const sync = async () => {
    const found = layer()
    if (!found || !props.ns) return
    await client()
      .layer.sync({ ns: props.ns, id: found.id })
      .then(() => data.refresh())
      .catch(data.fail)
  }
  // OpenCode's built-in a copy stands for: in OpenCode itself, else OpenCode's namespace.
  const openOriginal = (id: string) =>
    props.ns && props.ns !== OPENCODE
      ? navigate(`/operator/profile?ns=${OPENCODE}&tab=layers&layer=${encodeURIComponent(id)}`)
      : props.onSelect(id)
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
      // null clears the writer (the generated client's types leave the null out).
      ...(prompted() ? { prompt: store.prompt.trim(), writer: (store.writer || null) as string } : {}),
      ...(rulesEditable() && store.rules ? { resolver: store.rules } : {}),
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
  // Edit a copy of OpenCode's rules: one of your Dynamic layers with the same rules, opened to edit.
  const copyRules = async (ns: string) => {
    const found = layer()
    const rules = rulesOf(found)
    if (!found || !rules) return
    setStore("busy", true)
    await client()
      .layer.create({
        ns,
        name: language.t("operator.layerRules.copyName", { name: found.name }),
        type: DYNAMIC,
        section: "dynamic",
        text: "",
        resolver: rules,
      })
      .then(async (result) => {
        await data.refresh()
        props.onSelect(result.data?.id, ns, true)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  // A copy with rules of its own goes back to OpenCode's (rules equal to them are not kept).
  const followOpenCode = async () => {
    const found = layer()
    const rules = found?.replaces ? props.catalog.resolvers[found.replaces] : undefined
    if (!found || !rules || !props.ns) return
    await client()
      .layer.update({ ns: props.ns, id: found.id, name: found.name, type: found.type, text: "", resolver: rules })
      .then(() => data.refresh())
      .catch(data.fail)
  }
  const remove = async () => {
    const found = layer()
    if (!found) return
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: found.name }),
      description: language.t("operator.profile.deleteLayerBody"),
      confirm: language.t("operator.trash.moveConfirm"),
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
        when={!prompted() && !nameOnly()}
        fallback={
          nameOnly() ? (
            <p data-slot="operator-note">
              {language.t(rulesEditable() ? "operator.layerRules.copyNote" : "operator.profile.perRequestCopy")}
            </p>
          ) : (
            <Show
              when={needsPrompt()}
              fallback={<p data-slot="operator-note">{language.t("operator.layerRules.noPrompt")}</p>}
            >
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
              <Field group label={language.t("operator.layer.writer")} hint={language.t("operator.help.layerWriter")}>
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("operator.layer.writer")}
                  options={[DEFAULT_WRITER, ...writers()]}
                  current={store.writer || DEFAULT_WRITER}
                  label={(name) => (name === DEFAULT_WRITER ? defaultWriter() : name)}
                  onSelect={(name) => setStore("writer", !name || name === DEFAULT_WRITER ? "" : name)}
                />
              </Field>
            </Show>
          )
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
      <Show when={rulesEditable() && store.rules}>
        {(rules) => (
          <>
            <RulesForm
              value={rules()}
              helper={prompted()}
              judges={writers()}
              onChange={(next) => setStore("rules", next)}
            />
            <Show when={layer()}>
              {(found) => (
                <LayerSample
                  layer={found()}
                  catalog={props.catalog}
                  draft={() => store.rules}
                  onSelect={(id) => props.onSelect(id)}
                />
              )}
            </Show>
          </>
        )}
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
                disabled={store.busy || !store.name.trim() || (needsPrompt() && !store.prompt.trim())}
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
            builtin={found().origin !== "user"}
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
                    <button type="button" data-slot="operator-link" onClick={() => openOriginal(original())}>
                      {original().replace("opencode:", "")}
                    </button>
                  </RecordField>
                )}
              </Show>
              <Show when={found().outdated}>
                <RecordField
                  label={language.t("operator.profile.outdated")}
                  help={language.t("operator.help.layerOutdated")}
                >
                  <span class="flex items-center gap-2 flex-wrap">
                    {language.t("operator.profile.outdatedNote")}
                    <ButtonV2 size="small" variant="outline" onClick={() => void sync()}>
                      {language.t("operator.profile.takeOpenCode")}
                    </ButtonV2>
                  </span>
                </RecordField>
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
              <Show when={names.about(found().replaces ? { ...found(), id: found().replaces! } : found())}>
                {(about) => (
                  <RecordField
                    label={language.t("operator.profile.about")}
                    help={language.t("operator.help.layerAbout")}
                  >
                    {about()}
                  </RecordField>
                )}
              </Show>
              <Show when={found().file}>
                {(file) => (
                  <RecordField
                    label={language.t("operator.profile.sourceFile")}
                    help={language.t("operator.help.layerSourceFile")}
                  >
                    <code data-testid="layer-source-file">{file()}</code>
                  </RecordField>
                )}
              </Show>
              <Show when={dynamicKey(found())}>
                {(key) => (
                  <>
                    <RecordField
                      label={language.t("operator.profile.textSource")}
                      help={language.t("operator.help.textSource")}
                    >
                      <span data-testid="layer-text-source">
                        {language.t(`operator.layer.source.${key()}` as "operator.layer.source.written")}
                      </span>
                    </RecordField>
                    <RecordField
                      label={language.t("operator.profile.dependsOn")}
                      help={language.t("operator.help.dependsOn")}
                    >
                      <span class="flex items-center gap-1 flex-wrap" data-testid="layer-depends-on">
                        <For each={DEPENDS_ON[key()] ?? []}>
                          {(factor) => (
                            <Tag
                              title={language.t(
                                `operator.profile.factor.${factor}.hint` as "operator.profile.factor.agent.hint",
                              )}
                            >
                              {language.t(`operator.profile.factor.${factor}` as "operator.profile.factor.agent")}
                            </Tag>
                          )}
                        </For>
                      </span>
                    </RecordField>
                  </>
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
            <Show when={isWrittenDynamic(found()) && hasHelper(found().resolver ?? props.catalog.helperRules)}>
              <dl data-component="record-fields">
                <RecordField
                  label={language.t("operator.profile.prompt")}
                  help={language.t("operator.help.layerPrompt")}
                >
                  <pre data-component="operator-code">{found().prompt}</pre>
                </RecordField>
                <RecordField label={language.t("operator.layer.writer")} help={language.t("operator.help.layerWriter")}>
                  <span data-testid="layer-writer">{found().writer ?? defaultWriter()}</span>
                </RecordField>
              </dl>
            </Show>
            <Show when={dynamic() && rulesOf(found())}>
              {(rules) => (
                <RulesView
                  rules={rules()}
                  note={rulesNote(found())}
                  actions={
                    <>
                      <Show when={found().origin !== "user" && props.catalog.editableRules.includes(found().id)}>
                        <NamespaceAction
                          variant="outline"
                          label={language.t("operator.layerRules.editCopy")}
                          ns={props.ns}
                          namespaces={props.namespaces}
                          disabled={store.busy}
                          run={(ns) => void copyRules(ns)}
                        />
                      </Show>
                      <Show when={found().origin === "user" && found().replaces && found().resolver}>
                        <ButtonV2 variant="outline" onClick={() => void followOpenCode()}>
                          {language.t("operator.layerRules.useOpenCode")}
                        </ButtonV2>
                      </Show>
                    </>
                  }
                />
              )}
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
// Test resolve (dynamic_layer_resolution_spec.md §6): with draft rules, a model and a session, what the
// layer's rules give and the full trace, without sending anything.
function LayerSample(props: {
  layer: Layer
  catalog: Catalog
  onSelect: (id: string) => void
  draft?: () => OperatorResolver | undefined
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const projects = useOperatorProjects()
  const names = useProfileNames()
  const [store, setStore] = createStore({
    project: undefined as string | undefined,
    agent: "build",
    model: AGENT_MODEL,
    session: NO_SESSION,
    busy: false,
    error: "",
    sample: undefined as OperatorPromptSample | undefined,
    sampleProject: "",
  })
  createEffect(
    on(
      () => props.layer.id,
      () => setStore({ sample: undefined, error: "" }),
      { defer: true },
    ),
  )
  // The namespace's projects (OpenCode's layers are found only in its projects), the ones open in
  // this browser first.
  const options = createMemo(() => {
    const keys = new Set(props.catalog.projects.map((item) => item.key))
    const own = projects().filter((item) => keys.has(item.directory))
    return own.length ? own : projects()
  })
  // The project chosen here, else the one chosen on the operator pages (when it is offered), else the first.
  const remembered = useRememberedProject()
  const project = () =>
    store.project ?? options().find((item) => item.directory === remembered())?.directory ?? options()[0]?.directory
  const projectName = (key: string) => projects().find((item) => item.directory === key)?.label ?? shortPath(key)
  // Each agent with where it is defined, and whether it is hidden.
  const agentLabel = (name: string) => {
    const agent = agents.data?.find((item) => item.name === name)
    if (!agent) return name
    const details = [language.t(`operator.agents.source.${agent.source.kind}`)]
    if (agent.hidden) details.push(language.t("operator.agents.hidden"))
    return language.t("operator.profile.sampleAgentOption", { name, details: details.join(", ") })
  }
  const agents = useQuery(() => ({
    queryKey: api.key("agents", project()),
    enabled: !!project(),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: project() })
        .then((result) => result.data ?? []),
  }))
  // The models of the project's providers, and the agent's sessions there (their reads: helper texts,
  // permissions).
  const providers = useQuery(() => ({
    queryKey: api.key("providers", project()),
    enabled: !!project(),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: project() })
        .then((result) => result.data!),
  }))
  const models = createMemo(() => [
    AGENT_MODEL,
    ...(providers.data?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => `${provider.id}/${model.id}`),
    ),
  ])
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "agent", project(), store.agent),
    enabled: !!project(),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ within: project(), agent: store.agent, limit: "50" })
        .then((result) => result.data ?? []),
  }))
  // The built-in the layer is, or is a copy of.
  const suffix = () => (props.layer.replaces ?? props.layer.id).slice(PREFIX.length)
  const generate = async () => {
    const directory = project()
    if (!directory) return
    setStore({ busy: true, error: "" })
    const draft = props.draft?.()
    const at = store.model.indexOf("/")
    await api
      .client()
      .operator.prompt.sample({
        directory,
        agent: store.agent,
        layer: props.layer.id,
        ...(store.model === AGENT_MODEL
          ? {}
          : { provider: store.model.slice(0, at), model: store.model.slice(at + 1) }),
        ...(store.session === NO_SESSION ? {} : { session: store.session }),
        ...(draft ? { resolver: JSON.stringify(draft) } : {}),
      })
      .then((result) => {
        if (!result.data) return
        setStore({ sample: result.data, sampleProject: directory })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  const scoped = (page: string) => navigate(`/operator/${page}?dir=${encodeURIComponent(project() ?? "")}`)
  // The base prompt layer a sample came from (Base prompt by model, or an agent without a prompt).
  const base = () =>
    store.sample?.source.startsWith("base.")
      ? props.catalog.namespace.id === OPENCODE
        ? `${PREFIX}${store.sample.source}`
        : store.sample.source
      : undefined

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
            options={options().map((item) => item.directory)}
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
            label={agentLabel}
            onSelect={(name) => name && setStore({ agent: name, session: NO_SESSION, sample: undefined })}
          />
        </Field>
        <Field group label={language.t("operator.column.model")} hint={language.t("operator.help.sampleModel")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.column.model")}
            options={models()}
            current={store.model}
            label={(value) => (value === AGENT_MODEL ? language.t("operator.layerRules.agentModel") : value)}
            onSelect={(value) => value && setStore({ model: value, sample: undefined })}
          />
        </Field>
        <Field group label={language.t("operator.layerRules.session")} hint={language.t("operator.help.sampleSession")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.layerRules.session")}
            options={[NO_SESSION, ...(sessions.data ?? []).map((item) => item.id)]}
            current={store.session}
            label={(id) =>
              id === NO_SESSION
                ? language.t("operator.layerRules.noSession")
                : ((sessions.data ?? []).find((item) => item.id === id)?.title ?? id)
            }
            onSelect={(id) => id && setStore({ session: id, sample: undefined })}
          />
        </Field>
        <ButtonV2 variant="contrast" disabled={store.busy || !project()} onClick={() => void generate()}>
          {language.t(props.draft ? "operator.layerRules.testResolve" : "operator.profile.sample")}
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
                project: projectName(store.sampleProject),
              })}
            </h4>
            <Show
              when={sample().text}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.sampleEmpty")}</p>}
            >
              <pre data-component="operator-code">{sample().text}</pre>
            </Show>
            <TraceList trace={sample().trace} label={language.t("operator.profile.cameFrom")} />
            <Resolution trace={sample().resolution} parity={sample().parity} />
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
