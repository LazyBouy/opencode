import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { shortPath } from "../format"
import { useAllLayers, usePromptCatalog, useProfileNames } from "./profile-data"
import { type Catalog, type Layer, origin, profilesUsing, type Section, SECTIONS, WRITTEN } from "./profile-model"

// Layer Definition: every layer of the namespace by section, with the built-in ones beside it.
export function LayerDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const catalog = () => data.query.data
  const all = useAllLayers(catalog)
  // The org purpose is not a layer to pick: it comes from the namespace (Settings → Namespaces).
  const layers = createMemo(() => all().filter((layer) => layer.origin !== "automatic"))
  const [params, setParams] = useSearchParams<{ layer?: string; q?: string }>()

  // The section each layer shows in. OpenCode's texts and copies of them show in their own section.
  const sectionOf = (layer: Layer): Section => layer.section
  const sections = createMemo(() => {
    const query = (params.q ?? "").trim().toLowerCase()
    const shown = layers().filter(
      (layer) =>
        !query || `${layer.id} ${layer.name} ${names.layer(layer)} ${layer.text}`.toLowerCase().includes(query),
    )
    return SECTIONS.map((section) => ({
      ...section,
      rows: shown.filter((layer) => sectionOf(layer) === section.id),
    }))
  })

  const usedIn = (layer: Layer) => {
    const loaded = catalog()
    if (!loaded) return ""
    const profiles = profilesUsing(loaded, layer.id).map((profile) => names.profile(profile))
    const projects = loaded.projects.filter((project) => project.purpose === layer.id).map((project) => project.name)
    return [...profiles, ...projects.map((name) => language.t("operator.profile.projectName", { name }))].join(", ")
  }
  const originLabel = (layer: Layer) => {
    const kind = origin(layer)
    if (kind === "copy") {
      const original = layers().find((item) => item.id === layer.replaces)
      return language.t("operator.profile.origin.copy", {
        name: original ? names.layer(original) : (layer.replaces ?? ""),
      })
    }
    return language.t(`operator.profile.origin.${kind}`)
  }

  return (
    <div data-slot="operator-columns">
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
                label={names.section(section.id)}
                rows={section.rows}
                loading={data.query.isPending}
                empty={
                  section.id === "purpose"
                    ? language.t("operator.profile.noPurposes")
                    : language.t("operator.profile.noLayers")
                }
                onRowClick={(row) => setParams({ layer: row.id })}
                columns={[
                  {
                    id: "name",
                    header: language.t("operator.column.name"),
                    value: (row) => names.layer(row),
                    cell: (row) => (
                      <span class="flex items-center gap-2" data-selected={params.layer === row.id ? "" : undefined}>
                        {names.layer(row)}
                        <Show when={row.delivery}>
                          {(delivery) => <Tag>{language.t(`operator.profile.delivery.${delivery()}`)}</Tag>}
                        </Show>
                      </span>
                    ),
                  },
                  {
                    id: "type",
                    header: language.t("operator.profile.type"),
                    value: (row) => row.type,
                    cell: (row) => names.typeId(catalog(), row.type),
                  },
                  {
                    id: "origin",
                    header: language.t("operator.profile.origin"),
                    cell: (row) => originLabel(row),
                  },
                  {
                    id: "used",
                    header: language.t("operator.profile.usedIn"),
                    cell: (row) => <span data-slot="operator-cell-clamp">{usedIn(row)}</span>,
                  },
                ]}
              />
            </section>
          )}
        </For>
      </div>
      <section data-component="operator-panel" data-slot="operator-sticky">
        <Show
          when={catalog() && params.layer ? catalog() : undefined}
          fallback={<p data-slot="operator-note">{language.t("operator.profile.pickLayer")}</p>}
        >
          {(loaded) => (
            <LayerPanel
              ns={props.ns}
              namespaces={props.namespaces}
              selected={params.layer!}
              catalog={loaded()}
              layers={layers()}
              onSelect={(layer) => setParams({ layer })}
              onOpenMemory={() => navigate("/operator/memory")}
              onOpenProjects={() => navigate("/operator/projects")}
            />
          )}
        </Show>
      </section>
    </div>
  )
}

function LayerPanel(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  selected: string
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  onSelect: (layer: string | undefined) => void
  onOpenMemory: () => void
  onOpenProjects: () => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const creating = () => SECTIONS.find((item) => `new:${item.id}` === props.selected)?.id
  const layer = createMemo(() => props.layers.find((item) => item.id === props.selected))
  const [store, setStore] = createStore({ name: "", type: "", text: "", busy: false })
  createEffect(
    on([() => props.selected, layer], () => {
      const found = layer()
      const section = creating()
      setStore({
        name: found?.name ?? "",
        type: found?.type ?? SECTIONS.find((item) => item.id === section)?.type ?? "identity",
        text: found?.text ?? "",
      })
    }),
  )
  const editable = () => !!creating() || layer()?.origin === "user"
  // A layer's type changes only in Custom; copies keep their built-in's type.
  const typeEditable = () => (creating() ?? layer()?.section) === "custom" && !layer()?.replaces

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

  const types = () => props.catalog.types.filter((type) => type.id !== "purpose")
  const linked = () => props.catalog.projects.filter((project) => project.purpose === props.selected)

  return (
    <Show
      when={editable()}
      fallback={
        <Show when={layer()} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchLayer")}</p>}>
          {(found) => (
            <>
              <h2 data-slot="operator-panel-title">{names.layer(found())}</h2>
              <p data-slot="operator-note">
                {names.typeId(props.catalog, found().type)}
                <Show when={found().delivery}>
                  {(delivery) => <> · {language.t(`operator.profile.delivery.${delivery()}`)}</>}
                </Show>
              </p>
              <Show when={names.about(found())}>{(about) => <p data-slot="operator-note">{about()}</p>}</Show>
              <Show when={found().id === "opencode:generated.instructions"}>
                <ButtonV2 size="small" variant="outline" onClick={props.onOpenMemory}>
                  {language.t("operator.prompts.openMemory")}
                </ButtonV2>
              </Show>
              <Show when={found().origin === "builtin"}>
                <div data-slot="operator-actions">
                  <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void copy()}>
                    {language.t("operator.profile.makeCopy")}
                  </ButtonV2>
                </div>
                <p data-slot="operator-note">{language.t("operator.profile.copyNote")}</p>
                <Show when={found().text}>
                  <pre data-component="operator-code">{found().text}</pre>
                </Show>
              </Show>
            </>
          )}
        </Show>
      }
    >
      <h2 data-slot="operator-panel-title">
        {creating()
          ? creating() === "purpose"
            ? language.t("operator.profile.newPurpose")
            : language.t("operator.profile.newIn", { section: names.section(creating()!) })
          : store.name}
      </h2>
      <Show when={layer()?.replaces}>
        {(original) => (
          <p data-slot="operator-note">
            {language.t("operator.profile.copyOf")}{" "}
            <button type="button" data-slot="operator-link" onClick={() => props.onSelect(original())}>
              {original().replace("opencode:", "")}
            </button>
            . {language.t("operator.profile.copyNote")}
          </p>
        )}
      </Show>
      <div data-component="operator-form">
        <Field label={language.t("operator.agentForm.name")}>
          <TextInputV2
            appearance="base"
            value={store.name}
            onInput={(event) => setStore("name", event.currentTarget.value)}
          />
        </Field>
        <Field group label={language.t("operator.profile.type")}>
          <Show when={typeEditable()} fallback={<span>{names.typeId(props.catalog, store.type)}</span>}>
            <SelectV2<string>
              appearance="base"
              options={types().map((type) => type.id)}
              current={store.type}
              label={(id) => names.typeId(props.catalog, id)}
              onSelect={(id) => id && setStore("type", id)}
            />
          </Show>
        </Field>
        <Field
          label={language.t("operator.prompts.text")}
          hint={language.t("operator.profile.chars", { count: store.text.length })}
        >
          <TextareaV2
            class="operator-editor"
            rows={14}
            value={store.text}
            onInput={(event) => setStore("text", event.currentTarget.value)}
          />
        </Field>
      </div>
      <Show when={linked().length}>
        <p data-slot="operator-note">
          {language.t("operator.profile.linkedBy", {
            projects: linked()
              .map((project) => shortPath(project.key))
              .join(", "),
          })}{" "}
          <button type="button" data-slot="operator-link" onClick={props.onOpenProjects}>
            {language.t("operator.page.projects.title")}
          </button>
        </p>
      </Show>
      <div data-slot="operator-actions">
        <Show when={!creating()}>
          <CopyToNamespace
            ns={props.ns}
            kind="layer"
            id={props.selected}
            namespaces={props.namespaces}
            onCopied={() => void data.refresh()}
          />
          <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
            {language.t("operator.agent.delete")}
          </ButtonV2>
        </Show>
        <ButtonV2 variant="contrast" disabled={store.busy || !store.name.trim()} onClick={() => void save()}>
          {language.t("operator.config.save")}
        </ButtonV2>
      </div>
    </Show>
  )
}
