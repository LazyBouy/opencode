import { useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { OrderedList } from "../ui/ordered-list"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { usePromptCatalog, useProfileNames } from "./profile-data"
import { type Catalog, copyName, groupProblem, REQUIRED } from "./profile-model"

type Block = "types" | "groups"
type Params = { type?: string; group?: string; block?: string }

// Group Definition: group types (kinds of layer) and groups (orders of types). A record opens in
// the overlay.
export function GroupDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const catalog = () => data.query.data
  const [params, setParams] = useSearchParams<Params>()
  useRecordOverlay(
    () => !!(params.type || params.group || params.block),
    () => <GroupOverlay ns={props.ns} namespaces={props.namespaces} />,
    () => setParams({ type: undefined, group: undefined, block: undefined }),
  )

  return (
    <div class="flex flex-col gap-4 min-w-0">
      <section data-component="operator-panel" data-section="types">
        <div data-slot="operator-panel-head">
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.types")}</h2>
          <ButtonV2 size="small" variant="outline" onClick={() => setParams({ type: "new", block: "types" })}>
            {language.t("operator.profile.newType")}
          </ButtonV2>
        </div>
        <p data-slot="operator-note">{language.t("operator.profile.typesHint")}</p>
        <DataTable
          columnsKey="profile-types"
          label={language.t("operator.profile.types")}
          rows={catalog()?.types ?? []}
          loading={data.query.isPending}
          onRowClick={(type) => setParams({ type: type.id, block: "types" })}
          columns={[
            {
              id: "name",
              header: language.t("operator.column.name"),
              cell: (type) => (
                <span class="flex items-center gap-2">
                  {names.type(type)}
                  <Show when={type.builtin}>
                    <Tag>{language.t("operator.profile.builtin")}</Tag>
                  </Show>
                </span>
              ),
            },
            {
              id: "about",
              optional: true,
              header: language.t("operator.column.description"),
              cell: (type) => <span data-slot="operator-cell-clamp">{names.typeAbout(type)}</span>,
            },
          ]}
        />
      </section>
      <section data-component="operator-panel" data-section="groups">
        <div data-slot="operator-panel-head">
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.groups")}</h2>
          <ButtonV2 size="small" variant="outline" onClick={() => setParams({ group: "new", block: "groups" })}>
            {language.t("operator.profile.newGroup")}
          </ButtonV2>
        </div>
        <p data-slot="operator-note">{language.t("operator.profile.groupsHint")}</p>
        <DataTable
          columnsKey="profile-groups"
          label={language.t("operator.profile.groups")}
          rows={catalog()?.groups ?? []}
          loading={data.query.isPending}
          onRowClick={(group) => setParams({ group: group.id, block: "groups" })}
          columns={[
            {
              id: "name",
              header: language.t("operator.column.name"),
              cell: (group) => (
                <span class="flex items-center gap-2">
                  {names.group(group)}
                  <Show when={group.builtin}>
                    <Tag>{language.t("operator.profile.builtin")}</Tag>
                  </Show>
                </span>
              ),
            },
            {
              id: "types",
              optional: true,
              header: language.t("operator.profile.order"),
              cell: (group) => (
                <span data-slot="operator-cell-clamp">
                  {group.types.map((type) => names.typeId(catalog(), type)).join(" → ")}
                </span>
              ),
            },
            {
              id: "used",
              optional: true,
              header: language.t("operator.profile.usedIn"),
              cell: (group) => profilesOf(catalog(), group.id, names.profile),
            },
          ]}
        />
      </section>
    </div>
  )
}

// The profiles that use a group, by name.
function profilesOf(
  catalog: Catalog | undefined,
  group: string,
  name: (profile: Catalog["profiles"][number]) => string,
) {
  return (catalog?.profiles ?? [])
    .filter((profile) => profile.group === group)
    .map(name)
    .join(", ")
}

// The overlay of Group Definition: Group types and Groups on the left, their records on the right.
function GroupOverlay(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const [params, setParams] = useSearchParams<Params>()
  const [editing, setEditing] = createSignal(false)
  const block = (): Block =>
    params.type ? "types" : params.group ? "groups" : params.block === "groups" ? "groups" : "types"
  const blocks = createMemo<OverlayBlock[]>(() => [
    {
      id: "types",
      label: language.t("operator.profile.types"),
      icon: "dot-grid",
      description: language.t("operator.profile.typesHint"),
      empty: language.t("operator.table.empty"),
      create: {
        label: language.t("operator.profile.newType"),
        run: () => setParams({ type: "new", group: undefined }),
      },
      records: (data.query.data?.types ?? []).map((type) => ({
        id: type.id,
        label: names.type(type),
        detail: type.builtin ? language.t("operator.profile.builtin") : undefined,
      })),
    },
    {
      id: "groups",
      label: language.t("operator.profile.groups"),
      icon: "bullet-list",
      description: language.t("operator.profile.groupsHint"),
      empty: language.t("operator.table.empty"),
      create: {
        label: language.t("operator.profile.newGroup"),
        run: () => setParams({ group: "new", type: undefined }),
      },
      records: (data.query.data?.groups ?? []).map((group) => ({
        id: group.id,
        label: names.group(group),
        detail: group.builtin ? language.t("operator.profile.builtin") : undefined,
      })),
    },
  ])
  const select = (id: Block, record: string | undefined) =>
    setParams(
      id === "types"
        ? { type: record, group: undefined, block: "types" }
        : { group: record, type: undefined, block: "groups" },
    )

  return (
    <RecordOverlay
      title={language.t("operator.profile.tab.groups")}
      blocks={blocks()}
      block={block()}
      record={block() === "types" ? params.type : params.group}
      editing={editing()}
      onBlock={(id) => select(id as Block, undefined)}
      onRecord={(id, record) => select(id as Block, record)}
    >
      <Show when={data.query.data}>
        {(catalog) => (
          <Show
            when={block() === "types"}
            fallback={
              <GroupRecord
                ns={props.ns}
                namespaces={props.namespaces}
                catalog={catalog()}
                selected={params.group!}
                onEditing={setEditing}
                onSelect={(group) => select("groups", group)}
              />
            }
          >
            <TypeRecord
              ns={props.ns}
              namespaces={props.namespaces}
              catalog={catalog()}
              selected={params.type!}
              onEditing={setEditing}
              onSelect={(type) => select("types", type)}
            />
          </Show>
        )}
      </Show>
    </RecordOverlay>
  )
}

function TypeRecord(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  selected: string
  onEditing: (editing: boolean) => void
  onSelect: (type: string | undefined) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const creating = () => props.selected === "new"
  const type = createMemo(() => props.catalog.types.find((item) => item.id === props.selected))
  const [store, setStore] = createStore({ name: "", description: "", busy: false, editing: false })
  const reset = () =>
    setStore({ name: type()?.name ?? "", description: type()?.description ?? "", editing: creating() })
  createEffect(on(() => props.selected, reset))
  createEffect(() => props.onEditing(store.editing))

  const save = async () => {
    setStore("busy", true)
    const body = { ns: props.ns, name: store.name.trim(), description: store.description }
    await (creating() ? client().type.create(body) : client().type.update({ ...body, id: props.selected }))
      .then(async (result) => {
        await data.refresh()
        setStore("editing", false)
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const remove = async () => {
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: type()?.name ?? "" }),
      description: language.t("operator.profile.deleteTypeBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await client()
      .type.remove({ ns: props.ns, id: props.selected })
      .then(async () => {
        await data.refresh()
        props.onSelect(undefined)
      })
      .catch(data.fail)
  }

  return (
    <Show
      when={!store.editing}
      fallback={
        <RecordView
          title={
            creating()
              ? language.t("operator.profile.newType")
              : language.t("operator.profile.editing", { name: type()?.name ?? "" })
          }
          actions={
            <>
              <ButtonV2 variant="neutral" onClick={() => (creating() ? props.onSelect(undefined) : reset())}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="contrast" disabled={store.busy || !store.name.trim()} onClick={() => void save()}>
                {language.t("operator.config.save")}
              </ButtonV2>
            </>
          }
        >
          <div data-component="operator-form">
            <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.help.typeName")}>
              <TextInputV2
                appearance="base"
                value={store.name}
                onInput={(event) => setStore("name", event.currentTarget.value)}
              />
            </Field>
            <Field label={language.t("operator.column.description")} hint={language.t("operator.help.typeDescription")}>
              <TextareaV2
                rows={4}
                value={store.description}
                onInput={(event) => setStore("description", event.currentTarget.value)}
              />
            </Field>
          </div>
        </RecordView>
      }
    >
      <Show when={type()} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchType")}</p>}>
        {(found) => (
          <RecordView
            title={
              <>
                {names.type(found())}
                <Show when={found().builtin}>
                  <Tag>{language.t("operator.profile.builtin")}</Tag>
                </Show>
              </>
            }
            actions={
              <Show when={!found().builtin}>
                <ButtonV2 variant="contrast" onClick={() => setStore("editing", true)}>
                  {language.t("operator.profile.edit")}
                </ButtonV2>
                <CopyToNamespace ns={props.ns} kind="type" id={found().id} namespaces={props.namespaces} />
                <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                  {language.t("operator.agent.delete")}
                </ButtonV2>
              </Show>
            }
          >
            <dl data-component="record-fields">
              <RecordField
                label={language.t("operator.column.description")}
                help={language.t("operator.help.typeDescription")}
              >
                {names.typeAbout(found()) || "—"}
              </RecordField>
              <RecordField
                label={language.t("operator.profile.layersOfType")}
                help={language.t("operator.help.typeLayers")}
              >
                {
                  props.catalog.layers.filter((layer) => layer.type === found().id && layer.origin !== "automatic")
                    .length
                }
              </RecordField>
            </dl>
            <Show when={found().builtin}>
              <p data-slot="operator-note">{language.t("operator.profile.builtinType")}</p>
            </Show>
          </RecordView>
        )}
      </Show>
    </Show>
  )
}

function GroupRecord(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  selected: string
  onEditing: (editing: boolean) => void
  onSelect: (group: string | undefined) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  // A new group, or a duplicate of one (copy:<id>), is created on Save.
  const fresh = () => props.selected === "new" || props.selected.startsWith("copy:")
  const source = createMemo(() => props.catalog.groups.find((item) => item.id === props.selected.replace(/^copy:/, "")))
  const [store, setStore] = createStore({ name: "", types: [] as string[], busy: false, editing: false })
  const reset = () => {
    const found = source()
    if (props.selected === "new") return setStore({ name: "", types: [...REQUIRED], editing: true })
    setStore({
      name: props.selected.startsWith("copy:")
        ? copyName(
            found ? names.group(found) : "",
            props.catalog.groups.map((item) => item.name),
          )
        : (found?.name ?? ""),
      types: [...(found?.types ?? [])],
      editing: fresh(),
    })
  }
  createEffect(on(() => props.selected, reset))
  createEffect(() => props.onEditing(store.editing))
  const problem = () => groupProblem(store.types)

  const save = async () => {
    setStore("busy", true)
    const body = { ns: props.ns, name: store.name.trim(), types: store.types }
    await (fresh() ? client().group.create(body) : client().group.update({ ...body, id: props.selected }))
      .then(async (result) => {
        await data.refresh()
        setStore("editing", false)
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const remove = async () => {
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: source()?.name ?? "" }),
      description: language.t("operator.profile.deleteGroupBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await client()
      .group.remove({ ns: props.ns, id: props.selected })
      .then(async () => {
        await data.refresh()
        props.onSelect(undefined)
      })
      .catch(data.fail)
  }
  const cancel = () => {
    if (props.selected === "new") return props.onSelect(undefined)
    if (props.selected.startsWith("copy:")) return props.onSelect(props.selected.slice(5))
    reset()
  }

  return (
    <Show
      when={!store.editing}
      fallback={
        <RecordView
          title={
            props.selected === "new"
              ? language.t("operator.profile.newGroup")
              : language.t("operator.profile.editing", { name: store.name })
          }
          actions={
            <>
              <ButtonV2 variant="neutral" onClick={cancel}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                disabled={store.busy || !store.name.trim() || !!problem()}
                onClick={() => void save()}
              >
                {language.t("operator.config.save")}
              </ButtonV2>
            </>
          }
        >
          <div data-component="operator-form">
            <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.help.groupName")}>
              <TextInputV2
                appearance="base"
                value={store.name}
                onInput={(event) => setStore("name", event.currentTarget.value)}
              />
            </Field>
            <Field group label={language.t("operator.profile.order")} hint={language.t("operator.profile.orderHint")}>
              <OrderedList
                label={language.t("operator.profile.order")}
                items={store.types}
                name={(id) => names.typeId(props.catalog, id)}
                required={(id) => REQUIRED.includes(id)}
                onChange={(types) => setStore("types", types)}
              />
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.profile.addType")}
                placeholder={language.t("operator.profile.addType")}
                options={props.catalog.types.map((type) => type.id).filter((id) => !store.types.includes(id))}
                label={(id) => names.typeId(props.catalog, id)}
                onSelect={(id) => id && setStore("types", [...store.types, id])}
              />
            </Field>
          </div>
          <Show when={problem()}>
            {(found) => (
              <p data-slot="operator-error" role="alert">
                {found().kind === "required"
                  ? language.t("operator.profile.needsType", { type: names.typeId(props.catalog, found().type!) })
                  : language.t("operator.profile.typeTwice")}
              </p>
            )}
          </Show>
        </RecordView>
      }
    >
      <Show when={source()} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchGroup")}</p>}>
        {(found) => (
          <RecordView
            title={
              <>
                {names.group(found())}
                <Show when={found().builtin}>
                  <Tag>{language.t("operator.profile.builtin")}</Tag>
                </Show>
              </>
            }
            actions={
              <>
                <Show when={!found().builtin}>
                  <ButtonV2 variant="contrast" onClick={() => setStore("editing", true)}>
                    {language.t("operator.profile.edit")}
                  </ButtonV2>
                </Show>
                <ButtonV2 variant="outline" onClick={() => props.onSelect(`copy:${found().id}`)}>
                  {language.t("operator.profile.duplicate")}
                </ButtonV2>
                <Show when={!found().builtin}>
                  <CopyToNamespace ns={props.ns} kind="group" id={found().id} namespaces={props.namespaces} />
                  <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                    {language.t("operator.agent.delete")}
                  </ButtonV2>
                </Show>
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.profile.order")} help={language.t("operator.profile.orderHint")}>
                <OrderedList
                  label={language.t("operator.profile.order")}
                  items={found().types}
                  name={(id) => names.typeId(props.catalog, id)}
                  required={(id) => REQUIRED.includes(id)}
                  disabled
                  onChange={() => undefined}
                />
              </RecordField>
              <RecordField label={language.t("operator.profile.usedIn")} help={language.t("operator.help.groupUsedIn")}>
                {profilesOf(props.catalog, found().id, names.profile) || "—"}
              </RecordField>
            </dl>
            <Show when={found().builtin}>
              <p data-slot="operator-note">{language.t("operator.profile.builtinGroup")}</p>
            </Show>
          </RecordView>
        )}
      </Show>
    </Show>
  )
}
