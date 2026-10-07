import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { useRememberedProject } from "../scope"
import { NamespaceAction } from "../ui/namespace-picker"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { useAllLayers, usePromptRefresh, useProfileNames, useScopeCatalogs } from "./profile-data"
import { SlotEditor, type SlotValue } from "./profile-editor"
import {
  ALL,
  type Catalog,
  copyName,
  copySlots,
  isHelper,
  type Layer,
  namespaceDefault,
  PREFIX,
  type Profile,
  regroup,
  slotProblem,
} from "./profile-model"
import { useOverlayParams } from "../ui/overlay-nav"

type Row = { ns: string | undefined; item: Profile }

// The key of a record in the overlay: the id, with its namespace when all namespaces are shown.
const keyOf = (row: Row, all: boolean) => (all && row.ns ? `${row.ns}|${row.item.id}` : row.item.id)

// The profiles of the namespaces in scope (each namespace's own, then OpenCode's once), and where
// each is the namespace default.
function useProfileRows(ns: () => string, namespaces: () => ReadonlyArray<OperatorNamespaceSummary>) {
  const catalogs = useScopeCatalogs(ns, namespaces)
  return {
    catalogs,
    rows: createMemo<Row[]>(() =>
      catalogs.scoped(
        (catalog) => catalog.profiles,
        (profile) => profile.builtin,
      ),
    ),
    defaultIn: (row: Row) =>
      (row.ns ? [catalogs.of(row.ns)] : catalogs.list())
        .filter((catalog): catalog is Catalog => !!catalog && namespaceDefault(catalog) === row.item.id)
        .map((catalog) => catalog.namespace.name),
  }
}

// Profile Definition: profiles (a group and the layers in each of its slots) of the namespaces in
// scope. A profile opens in the overlay.
export function ProfileDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const all = () => props.ns === ALL
  const data = useProfileRows(
    () => props.ns,
    () => props.namespaces,
  )
  const [params, setParams] = useSearchParams<{ profile?: string; rns?: string; block?: string }>()
  const groupName = (row: Row) => {
    const found = (data.catalogs.of(row.ns) ?? data.catalogs.first())?.groups.find(
      (group) => group.id === row.item.group,
    )
    return found ? names.group(found) : row.item.group
  }
  const nsName = (id: string | undefined) =>
    id
      ? (props.namespaces.find((item) => item.namespace.id === id)?.namespace.name ?? id)
      : language.t("operator.namespace.builtin")
  useRecordOverlay(
    () => !!(params.profile || params.block),
    () => <ProfileOverlay ns={props.ns} namespaces={props.namespaces} />,
    ["profile", "rns", "block"],
  )

  return (
    <section data-component="operator-panel" data-section="profiles">
      <div data-slot="operator-panel-head">
        <h2 data-slot="operator-panel-title">{language.t("operator.profile.profiles")}</h2>
        <NamespaceAction
          size="small"
          label={language.t("operator.profile.newProfile")}
          ns={all() ? undefined : props.ns}
          namespaces={props.namespaces}
          run={(ns) => setParams({ profile: "new", rns: ns })}
        />
      </div>
      <p data-slot="operator-note">{language.t("operator.profile.profilesHint")}</p>
      <DataTable
        columnsKey="profiles"
        label={language.t("operator.profile.profiles")}
        rows={data.rows()}
        loading={data.catalogs.query.isPending}
        onRowClick={(row) => setParams({ profile: row.item.id, rns: row.ns })}
        columns={[
          {
            id: "name",
            header: language.t("operator.column.name"),
            cell: (row) => (
              <span class="flex items-center gap-2">
                {names.profile(row.item)}
                <Show when={row.item.builtin}>
                  <Tag>{language.t("operator.profile.builtin")}</Tag>
                </Show>
                <Show when={data.defaultIn(row).length}>
                  <Tag>
                    {all()
                      ? language.t("operator.profile.defaultIn", { namespaces: data.defaultIn(row).join(", ") })
                      : language.t("operator.profile.namespaceDefault")}
                  </Tag>
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
            id: "group",
            optional: true,
            header: language.t("operator.profile.group"),
            cell: (row) => groupName(row),
          },
        ]}
      />
    </section>
  )
}

// The overlay of Profile Definition: the profiles, or one profile.
function ProfileOverlay(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const all = () => props.ns === ALL
  const data = useProfileRows(
    () => props.ns,
    () => props.namespaces,
  )
  const [params, setParams] = useOverlayParams<{ profile?: string; rns?: string; block?: string }>()
  const [editing, setEditing] = createSignal(false)
  const recordNs = () => (all() ? params.rns : props.ns)
  const catalog = () => data.catalogs.of(recordNs()) ?? data.catalogs.first()
  const layers = useAllLayers(catalog)
  const blocks = createMemo<OverlayBlock[]>(() => [
    {
      id: "profiles",
      label: language.t("operator.profile.profiles"),
      icon: "prompt",
      description: language.t("operator.profile.profilesHint"),
      empty: language.t("operator.table.empty"),
      create: {
        label: language.t("operator.profile.newProfile"),
        ns: all() ? undefined : props.ns,
        run: (ns) => setParams({ profile: "new", rns: ns }),
      },
      records: data.rows().map((row) => ({
        id: keyOf(row, all()),
        label: names.profile(row.item),
        detail: all()
          ? (props.namespaces.find((entry) => entry.namespace.id === row.ns)?.namespace.name ??
            language.t("operator.namespace.builtin"))
          : row.item.builtin
            ? language.t("operator.profile.builtin")
            : undefined,
      })),
    },
  ])
  const open = (key: string | undefined, ns?: string) => {
    if (!key) return setParams({ profile: undefined, rns: undefined, block: "profiles" })
    const [first, second] = key.split("|")
    if (second) return setParams({ profile: second, rns: first, block: undefined })
    setParams({ profile: first, rns: ns ?? (all() ? undefined : props.ns), block: undefined })
  }
  const owned = () => data.rows().some((row) => row.item.id === params.profile && !!row.ns)

  return (
    <RecordOverlay
      title={language.t("operator.profile.tab.profiles")}
      namespaces={props.namespaces}
      blocks={blocks()}
      block="profiles"
      record={params.profile && all() && params.rns && owned() ? `${params.rns}|${params.profile}` : params.profile}
      editing={editing()}
      onBlock={() => open(undefined)}
      onRecord={(_, key) => open(key)}
    >
      <Show when={catalog()}>
        {(loaded) => (
          <ProfileRecord
            ns={recordNs()}
            namespaces={props.namespaces}
            catalog={loaded()}
            layers={layers()}
            selected={params.profile!}
            defaultIn={(id) => data.defaultIn({ ns: recordNs(), item: { id } as Profile })}
            onEditing={setEditing}
            onSelect={(profile, ns) => open(profile, ns)}
          />
        )}
      </Show>
    </RecordOverlay>
  )
}

// One profile: read-only (its group and slots), with Edit for the namespace's own profiles (Cancel or
// Save then), Duplicate, Use as namespace default and Preview on an agent.
function ProfileRecord(props: {
  // The profile's namespace; none for OpenCode's profiles while all namespaces are shown.
  ns: string | undefined
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  selected: string
  // The namespaces whose default the profile is.
  defaultIn: (id: string) => string[]
  onEditing: (editing: boolean) => void
  onSelect: (profile: string | undefined, ns?: string) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptRefresh()
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  // A new profile, or a duplicate of one (copy:<id>), is created on Save.
  const copying = () => props.selected.startsWith("copy:")
  const fresh = () => props.selected === "new" || copying()
  const source = createMemo(() =>
    props.catalog.profiles.find((item) => item.id === props.selected.replace(/^copy:/, "")),
  )
  const [store, setStore] = createStore({
    name: "",
    value: { group: "", slots: {} } as SlotValue,
    // The slots changed in the view, until the change is saved.
    live: undefined as SlotValue | undefined,
    busy: false,
    editing: false,
  })
  const reset = () => {
    const found = source()
    if (props.selected === "new") {
      const group = props.catalog.groups.find((item) => item.id === `${PREFIX}group.spec`) ?? props.catalog.groups[0]
      return setStore({
        name: "",
        value: { group: group.id, slots: regroup({}, group.types).slots },
        editing: true,
      })
    }
    setStore({
      name: copying()
        ? copyName(
            found ? names.profile(found) : "",
            props.catalog.profiles.map((item) => item.name),
          )
        : (found?.name ?? ""),
      value: { group: found?.group ?? "", slots: copySlots(found?.slots ?? {}) },
      editing: fresh(),
    })
  }
  // Only a change of record resets the form (not a refresh of the data around it).
  const record = createMemo(() => `${props.ns ?? ""}|${props.selected}`)
  createEffect(on(record, reset))
  createEffect(() => props.onEditing(store.editing))
  const problem = () =>
    slotProblem(
      props.catalog,
      store.value.slots,
      props.catalog.groups.find((item) => item.id === store.value.group)?.types,
    )
  // Where Create agent… makes the agent: the project chosen here, else the one chosen on the operator
  // pages (when it is in this namespace), else the namespace's first.
  const remembered = useRememberedProject()
  const [chosen, setProject] = createSignal<string>()
  const project = () =>
    props.catalog.projects.find((item) => item.key === chosen())?.key ??
    props.catalog.projects.find((item) => item.key === remembered())?.key ??
    props.catalog.projects[0]?.key
  const groupName = (id: string) => {
    const found = props.catalog.groups.find((group) => group.id === id)
    return found ? names.group(found) : id
  }

  // The namespace's own profiles change their slots in the view: each change is saved at once.
  const saveSlots = async (value: SlotValue) => {
    const found = source()
    if (!found || found.builtin || !props.ns) return
    setStore("live", value)
    const group = props.catalog.groups.find((item) => item.id === value.group)
    if (slotProblem(props.catalog, value.slots, group?.types)) return
    await client()
      .profile.update({ ns: props.ns, id: found.id, name: found.name, group: value.group, slots: value.slots })
      .then(() => data.refresh())
      .catch(data.fail)
      .finally(() => setStore("live", undefined))
  }

  const save = async () => {
    setStore("busy", true)
    const group = props.catalog.groups.find((item) => item.id === store.value.group)
    const body = {
      ns: props.ns!,
      name: store.name.trim(),
      group: store.value.group,
      slots: group ? regroup(store.value.slots, group.types).slots : store.value.slots,
    }
    await (fresh() ? client().profile.create(body) : client().profile.update({ ...body, id: props.selected }))
      .then(async (result) => {
        await data.refresh()
        setStore("editing", false)
        props.onSelect(result.data?.id, props.ns)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const makeDefault = async (ns: string) => {
    await client()
      .update({ ns, defaultProfile: props.selected })
      .then(() => data.refresh())
      .catch(data.fail)
  }
  const remove = async () => {
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: source()?.name ?? "" }),
      description: language.t("operator.profile.deleteProfileBody"),
      confirm: language.t("operator.trash.moveConfirm"),
      danger: true,
    })
    if (!ok) return
    await client()
      .profile.remove({ ns: props.ns!, id: props.selected })
      .then(async () => {
        await data.refresh()
        props.onSelect(undefined)
      })
      .catch(data.fail)
  }
  const cancel = () => {
    if (props.selected === "new") return props.onSelect(undefined)
    if (copying()) return props.onSelect(props.selected.slice(5), source()?.builtin ? undefined : props.ns)
    reset()
  }

  return (
    <Show
      when={!store.editing}
      fallback={
        <RecordView
          title={
            props.selected === "new"
              ? language.t("operator.profile.newProfile")
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
            <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.help.profileName")}>
              <TextInputV2
                appearance="base"
                value={store.name}
                onInput={(event) => setStore("name", event.currentTarget.value)}
              />
            </Field>
            <SlotEditor
              ns={props.ns!}
              catalog={props.catalog}
              layers={props.layers}
              value={store.value}
              onChange={(value) => setStore("value", value)}
            />
          </div>
        </RecordView>
      }
    >
      <Show when={source()} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchProfile")}</p>}>
        {(found) => (
          <RecordView
            builtin={found().builtin}
            title={
              <>
                {names.profile(found())}
                <Show when={props.defaultIn(found().id).length}>
                  <Tag>
                    {props.ns
                      ? language.t("operator.profile.namespaceDefault")
                      : language.t("operator.profile.defaultIn", {
                          namespaces: props.defaultIn(found().id).join(", "),
                        })}
                  </Tag>
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
                <NamespaceAction
                  label={language.t("operator.profile.duplicate")}
                  ns={props.ns}
                  namespaces={props.namespaces}
                  run={(ns) => props.onSelect(`copy:${found().id}`, ns)}
                />
                <Show
                  when={
                    !isHelper(props.catalog, found()) && (!props.ns || namespaceDefault(props.catalog) !== found().id)
                  }
                >
                  <NamespaceAction
                    variant="neutral"
                    label={language.t("operator.profile.makeDefault")}
                    ns={props.ns}
                    namespaces={props.namespaces}
                    run={(ns) => void makeDefault(ns)}
                  />
                </Show>
                <Show when={!found().builtin}>
                  <CopyToNamespace ns={props.ns!} kind="profile" id={found().id} namespaces={props.namespaces} />
                  <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                    {language.t("operator.agent.delete")}
                  </ButtonV2>
                </Show>
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.profile.group")} help={language.t("operator.profile.groupHint")}>
                {groupName(found().group)}
              </RecordField>
            </dl>
            <SlotEditor
              ns={props.ns ?? props.catalog.namespace.id}
              catalog={props.catalog}
              layers={props.layers}
              value={store.live ?? { group: found().group, slots: found().slots }}
              disabled={found().builtin || !props.ns}
              hideGroup
              onChange={(value) => void saveSlots(value)}
            />
            <Show
              when={found().builtin}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.liveSlots")}</p>}
            >
              <p data-slot="operator-note">{language.t("operator.profile.builtinProfile")}</p>
            </Show>
            <ProfileProject catalog={props.catalog} profile={found().id} project={project()} onProject={setProject} />
          </RecordView>
        )}
      </Show>
    </Show>
  )
}

// Create agent…: a new agent of the chosen project that uses this profile (a helper agent, for a
// helper profile).
function ProfileProject(props: {
  catalog: Catalog
  profile: string
  project: string | undefined
  onProject: (project: string) => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  return (
    <Show
      when={props.catalog.projects.length}
      fallback={<p data-slot="operator-note">{language.t("operator.profile.previewNoProject")}</p>}
    >
      <div class="flex items-end gap-2 flex-wrap">
        <Field group label={language.t("operator.profile.inProject")} hint={language.t("operator.help.profileProject")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.inProject")}
            options={props.catalog.projects.map((item) => item.key)}
            current={props.project}
            label={(key) => props.catalog.projects.find((item) => item.key === key)?.name ?? shortPath(key)}
            onSelect={(key) => key && props.onProject(key)}
          />
        </Field>
        <ButtonV2
          variant="outline"
          disabled={!props.project}
          onClick={() =>
            navigate(
              `/operator/agents/new?dir=${encodeURIComponent(props.project!)}&profile=${encodeURIComponent(props.profile)}`,
            )
          }
        >
          {language.t("operator.profile.createAgent")}
        </ButtonV2>
      </div>
    </Show>
  )
}
