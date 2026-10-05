import { useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { OrderedList } from "../ui/ordered-list"
import { usePromptCatalog, useProfileNames } from "./profile-data"
import { type Catalog, copyName, groupProblem, REQUIRED } from "./profile-model"

// Group Definition: group types (categories of layer) and groups (orderings of types).
export function GroupDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const catalog = () => data.query.data
  const [params, setParams] = useSearchParams<{ type?: string; group?: string }>()

  return (
    <div data-slot="operator-columns">
      <div class="flex flex-col gap-4 min-w-0">
        <section data-component="operator-panel">
          <div data-slot="operator-panel-head">
            <h2 data-slot="operator-panel-title">{language.t("operator.profile.types")}</h2>
            <ButtonV2 size="small" variant="outline" onClick={() => setParams({ type: "new", group: undefined })}>
              {language.t("operator.profile.newType")}
            </ButtonV2>
          </div>
          <p data-slot="operator-note">{language.t("operator.profile.typesHint")}</p>
          <DataTable
            label={language.t("operator.profile.types")}
            rows={catalog()?.types ?? []}
            loading={data.query.isPending}
            onRowClick={(type) => setParams({ type: type.id, group: undefined })}
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
                header: language.t("operator.column.description"),
                cell: (type) => <span data-slot="operator-cell-clamp">{names.typeAbout(type)}</span>,
              },
            ]}
          />
        </section>
        <section data-component="operator-panel">
          <div data-slot="operator-panel-head">
            <h2 data-slot="operator-panel-title">{language.t("operator.profile.groups")}</h2>
            <ButtonV2 size="small" variant="outline" onClick={() => setParams({ group: "new", type: undefined })}>
              {language.t("operator.profile.newGroup")}
            </ButtonV2>
          </div>
          <p data-slot="operator-note">{language.t("operator.profile.groupsHint")}</p>
          <DataTable
            label={language.t("operator.profile.groups")}
            rows={catalog()?.groups ?? []}
            loading={data.query.isPending}
            onRowClick={(group) => setParams({ group: group.id, type: undefined })}
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
                header: language.t("operator.profile.order"),
                cell: (group) => (
                  <span data-slot="operator-cell-clamp">
                    {group.types.map((type) => names.typeId(catalog(), type)).join(" → ")}
                  </span>
                ),
              },
              {
                id: "used",
                header: language.t("operator.profile.usedIn"),
                cell: (group) =>
                  (catalog()?.profiles ?? [])
                    .filter((profile) => profile.group === group.id)
                    .map((profile) => names.profile(profile))
                    .join(", "),
              },
            ]}
          />
        </section>
      </div>
      <section data-component="operator-panel" data-slot="operator-sticky">
        <Show when={catalog()} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
          {(loaded) => (
            <Show
              when={params.type || params.group}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.pickGroup")}</p>}
            >
              <Show
                when={params.type}
                fallback={
                  <GroupEditor
                    ns={props.ns}
                    namespaces={props.namespaces}
                    catalog={loaded()}
                    selected={params.group!}
                    onSelect={(group) => setParams({ group })}
                  />
                }
              >
                <TypeEditor
                  ns={props.ns}
                  namespaces={props.namespaces}
                  catalog={loaded()}
                  selected={params.type!}
                  onSelect={(type) => setParams({ type })}
                />
              </Show>
            </Show>
          )}
        </Show>
      </section>
    </div>
  )
}

function TypeEditor(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  selected: string
  onSelect: (type: string | undefined) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const type = createMemo(() => props.catalog.types.find((item) => item.id === props.selected))
  const [store, setStore] = createStore({ name: "", description: "", busy: false })
  createEffect(on(type, (found) => setStore({ name: found?.name ?? "", description: found?.description ?? "" })))

  const save = async () => {
    setStore("busy", true)
    const body = { ns: props.ns, name: store.name.trim(), description: store.description }
    await (
      props.selected === "new" ? client().type.create(body) : client().type.update({ ...body, id: props.selected })
    )
      .then(async (result) => {
        await data.refresh()
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const remove = async () => {
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: store.name }),
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
      when={!type()?.builtin}
      fallback={
        <>
          <h2 data-slot="operator-panel-title">{names.type(type()!)}</h2>
          <p data-slot="operator-note">{names.typeAbout(type()!)}</p>
          <p data-slot="operator-note">{language.t("operator.profile.builtinType")}</p>
        </>
      }
    >
      <h2 data-slot="operator-panel-title">
        {props.selected === "new" ? language.t("operator.profile.newType") : store.name}
      </h2>
      <div data-component="operator-form">
        <Field label={language.t("operator.agentForm.name")}>
          <TextInputV2
            appearance="base"
            value={store.name}
            onInput={(event) => setStore("name", event.currentTarget.value)}
          />
        </Field>
        <Field label={language.t("operator.column.description")}>
          <TextareaV2
            rows={4}
            value={store.description}
            onInput={(event) => setStore("description", event.currentTarget.value)}
          />
        </Field>
      </div>
      <div data-slot="operator-actions">
        <Show when={props.selected !== "new"}>
          <CopyToNamespace ns={props.ns} kind="type" id={props.selected} namespaces={props.namespaces} />
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

function GroupEditor(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  selected: string
  onSelect: (group: string | undefined) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const source = createMemo(() => {
    const id = props.selected.startsWith("copy:") ? props.selected.slice(5) : props.selected
    return props.catalog.groups.find((item) => item.id === id)
  })
  const fresh = () => props.selected === "new" || props.selected.startsWith("copy:")
  const [store, setStore] = createStore({ name: "", types: [] as string[], busy: false })
  createEffect(
    on([() => props.selected, source], () => {
      const found = source()
      if (props.selected === "new") return setStore({ name: "", types: [...REQUIRED] })
      if (!found) return
      setStore({
        name: props.selected.startsWith("copy:")
          ? copyName(
              names.group(found),
              props.catalog.groups.map((item) => item.name),
            )
          : found.name,
        types: [...found.types],
      })
    }),
  )
  const readOnly = () => !fresh() && !!source()?.builtin
  const problem = () => groupProblem(store.types)

  const save = async () => {
    setStore("busy", true)
    const body = { ns: props.ns, name: store.name.trim(), types: store.types }
    await (fresh() ? client().group.create(body) : client().group.update({ ...body, id: props.selected }))
      .then(async (result) => {
        await data.refresh()
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const remove = async () => {
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: store.name }),
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

  return (
    <>
      <div data-slot="operator-panel-head">
        <h2 data-slot="operator-panel-title">
          {props.selected === "new"
            ? language.t("operator.profile.newGroup")
            : readOnly()
              ? names.group(source()!)
              : store.name}
        </h2>
        <Show when={!fresh()}>
          <ButtonV2 size="small" variant="outline" onClick={() => props.onSelect(`copy:${props.selected}`)}>
            {language.t("operator.profile.duplicate")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={readOnly()}>
        <p data-slot="operator-note">{language.t("operator.profile.builtinGroup")}</p>
      </Show>
      <div data-component="operator-form">
        <Show when={!readOnly()}>
          <Field label={language.t("operator.agentForm.name")}>
            <TextInputV2
              appearance="base"
              value={store.name}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </Field>
        </Show>
        <Field group label={language.t("operator.profile.order")} hint={language.t("operator.profile.orderHint")}>
          <OrderedList
            label={language.t("operator.profile.order")}
            items={store.types}
            name={(id) => names.typeId(props.catalog, id)}
            required={(id) => REQUIRED.includes(id)}
            disabled={readOnly()}
            onChange={(types) => setStore("types", types)}
          />
          <Show when={!readOnly()}>
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.profile.addType")}
              placeholder={language.t("operator.profile.addType")}
              options={props.catalog.types.map((type) => type.id).filter((id) => !store.types.includes(id))}
              label={(id) => names.typeId(props.catalog, id)}
              onSelect={(id) => id && setStore("types", [...store.types, id])}
            />
          </Show>
        </Field>
      </div>
      <Show when={!readOnly()}>
        <Show when={problem()}>
          {(found) => (
            <p data-slot="operator-error" role="alert">
              {found().kind === "required"
                ? language.t("operator.profile.needsType", { type: names.typeId(props.catalog, found().type!) })
                : language.t("operator.profile.typeTwice")}
            </p>
          )}
        </Show>
        <div data-slot="operator-actions">
          <Show when={!fresh()}>
            <CopyToNamespace ns={props.ns} kind="group" id={props.selected} namespaces={props.namespaces} />
            <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
              {language.t("operator.agent.delete")}
            </ButtonV2>
          </Show>
          <ButtonV2
            variant="contrast"
            disabled={store.busy || !store.name.trim() || !!problem()}
            onClick={() => void save()}
          >
            {language.t("operator.config.save")}
          </ButtonV2>
        </div>
      </Show>
    </>
  )
}
