import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
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
import { SlotEditor, type SlotValue } from "./profile-editor"
import {
  type Catalog,
  copyName,
  copySlots,
  type Layer,
  namespaceDefault,
  PREFIX,
  regroup,
  slotProblem,
} from "./profile-model"

// Profile Definition: profiles (a group and the layers in each of its slots). A profile opens in the
// overlay.
export function ProfileDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const catalog = () => data.query.data
  const [params, setParams] = useSearchParams<{ profile?: string; block?: string }>()
  const groupName = (id: string) => {
    const found = catalog()?.groups.find((group) => group.id === id)
    return found ? names.group(found) : id
  }
  useRecordOverlay(
    () => !!(params.profile || params.block),
    () => <ProfileOverlay ns={props.ns} namespaces={props.namespaces} />,
    () => setParams({ profile: undefined, block: undefined }),
  )

  return (
    <section data-component="operator-panel" data-section="profiles">
      <div data-slot="operator-panel-head">
        <h2 data-slot="operator-panel-title">{language.t("operator.profile.profiles")}</h2>
        <ButtonV2 size="small" variant="outline" onClick={() => setParams({ profile: "new" })}>
          {language.t("operator.profile.newProfile")}
        </ButtonV2>
      </div>
      <p data-slot="operator-note">{language.t("operator.profile.profilesHint")}</p>
      <DataTable
        columnsKey="profiles"
        label={language.t("operator.profile.profiles")}
        rows={catalog()?.profiles ?? []}
        loading={data.query.isPending}
        onRowClick={(profile) => setParams({ profile: profile.id })}
        columns={[
          {
            id: "name",
            header: language.t("operator.column.name"),
            cell: (profile) => (
              <span class="flex items-center gap-2">
                {names.profile(profile)}
                <Show when={profile.builtin}>
                  <Tag>{language.t("operator.profile.builtin")}</Tag>
                </Show>
                <Show when={catalog() && namespaceDefault(catalog()!) === profile.id}>
                  <Tag>{language.t("operator.profile.namespaceDefault")}</Tag>
                </Show>
              </span>
            ),
          },
          {
            id: "group",
            optional: true,
            header: language.t("operator.profile.group"),
            cell: (profile) => groupName(profile.group),
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
  const data = usePromptCatalog(() => props.ns)
  const layers = useAllLayers(() => data.query.data)
  const [params, setParams] = useSearchParams<{ profile?: string; block?: string }>()
  const [editing, setEditing] = createSignal(false)
  const blocks = createMemo<OverlayBlock[]>(() => [
    {
      id: "profiles",
      label: language.t("operator.profile.profiles"),
      icon: "prompt",
      description: language.t("operator.profile.profilesHint"),
      empty: language.t("operator.table.empty"),
      create: { label: language.t("operator.profile.newProfile"), run: () => setParams({ profile: "new" }) },
      records: (data.query.data?.profiles ?? []).map((profile) => ({
        id: profile.id,
        label: names.profile(profile),
        detail: profile.builtin ? language.t("operator.profile.builtin") : undefined,
      })),
    },
  ])

  return (
    <RecordOverlay
      title={language.t("operator.profile.tab.profiles")}
      blocks={blocks()}
      block="profiles"
      record={params.profile}
      editing={editing()}
      onBlock={() => setParams({ profile: undefined, block: "profiles" })}
      onRecord={(_, profile) => setParams({ profile })}
    >
      <Show when={data.query.data}>
        {(catalog) => (
          <ProfileRecord
            ns={props.ns}
            namespaces={props.namespaces}
            catalog={catalog()}
            layers={layers()}
            selected={params.profile!}
            onEditing={setEditing}
            onSelect={(profile) => setParams({ profile, block: profile ? undefined : "profiles" })}
          />
        )}
      </Show>
    </RecordOverlay>
  )
}

// One profile: read-only (its group and slots), with Edit for the namespace's own profiles (Cancel or
// Save then), Duplicate, Use as namespace default and Preview on an agent.
function ProfileRecord(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  selected: string
  onEditing: (editing: boolean) => void
  onSelect: (profile: string | undefined) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
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
  createEffect(on(() => props.selected, reset))
  createEffect(() => props.onEditing(store.editing))
  const problem = () => slotProblem(props.catalog, store.value.slots)
  const groupName = (id: string) => {
    const found = props.catalog.groups.find((group) => group.id === id)
    return found ? names.group(found) : id
  }

  const save = async () => {
    setStore("busy", true)
    const group = props.catalog.groups.find((item) => item.id === store.value.group)
    const body = {
      ns: props.ns,
      name: store.name.trim(),
      group: store.value.group,
      slots: group ? regroup(store.value.slots, group.types).slots : store.value.slots,
    }
    await (fresh() ? client().profile.create(body) : client().profile.update({ ...body, id: props.selected }))
      .then(async (result) => {
        await data.refresh()
        setStore("editing", false)
        props.onSelect(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }
  const makeDefault = async () => {
    await client()
      .update({ ns: props.ns, defaultProfile: props.selected })
      .then(() => data.refresh())
      .catch(data.fail)
  }
  const remove = async () => {
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: source()?.name ?? "" }),
      description: language.t("operator.profile.deleteProfileBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await client()
      .profile.remove({ ns: props.ns, id: props.selected })
      .then(async () => {
        await data.refresh()
        props.onSelect(undefined)
      })
      .catch(data.fail)
  }
  const cancel = () => {
    if (props.selected === "new") return props.onSelect(undefined)
    if (copying()) return props.onSelect(props.selected.slice(5))
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
              ns={props.ns}
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
            title={
              <>
                {names.profile(found())}
                <Show when={found().builtin}>
                  <Tag>{language.t("operator.profile.builtin")}</Tag>
                </Show>
                <Show when={namespaceDefault(props.catalog) === found().id}>
                  <Tag>{language.t("operator.profile.namespaceDefault")}</Tag>
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
                <Show when={namespaceDefault(props.catalog) !== found().id}>
                  <ButtonV2 variant="neutral" onClick={() => void makeDefault()}>
                    {language.t("operator.profile.makeDefault")}
                  </ButtonV2>
                </Show>
                <Show when={!found().builtin}>
                  <CopyToNamespace ns={props.ns} kind="profile" id={found().id} namespaces={props.namespaces} />
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
              ns={props.ns}
              catalog={props.catalog}
              layers={props.layers}
              value={{ group: found().group, slots: found().slots }}
              disabled
              hideGroup
              onChange={() => undefined}
            />
            <Show when={found().builtin}>
              <p data-slot="operator-note">{language.t("operator.profile.builtinProfile")}</p>
            </Show>
            <PreviewOnAgent catalog={props.catalog} profile={found().id} />
          </RecordView>
        )}
      </Show>
    </Show>
  )
}

// "Preview on an agent": opens an agent's Prompt tab showing what this profile would send for it.
function PreviewOnAgent(props: { catalog: Catalog; profile: string }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const api = useOperatorClient()
  const [project, setProject] = createSignal<string>()
  const [agent, setAgent] = createSignal<string>()
  const chosen = () => project() ?? props.catalog.projects[0]?.key
  const agents = useQuery(() => ({
    queryKey: api.key("profile-preview-agents", chosen()),
    enabled: !!chosen(),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: chosen() })
        .then((result) => (result.data ?? []).map((item) => item.name)),
  }))
  const name = () => agent() ?? (agents.data?.includes("build") ? "build" : agents.data?.[0])

  return (
    <Show
      when={props.catalog.projects.length}
      fallback={<p data-slot="operator-note">{language.t("operator.profile.previewNoProject")}</p>}
    >
      <h3 data-slot="operator-panel-title">{language.t("operator.profile.previewOn")}</h3>
      <div class="flex items-end gap-2 flex-wrap">
        <Field
          group
          label={language.t("operator.profile.previewProject")}
          hint={language.t("operator.help.previewProject")}
        >
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.previewProject")}
            options={props.catalog.projects.map((item) => item.key)}
            current={chosen()}
            label={(key) => props.catalog.projects.find((item) => item.key === key)?.name ?? shortPath(key)}
            onSelect={(key) => {
              if (!key) return
              setProject(key)
              setAgent(undefined)
            }}
          />
        </Field>
        <Field
          group
          label={language.t("operator.profile.previewAgent")}
          hint={language.t("operator.help.previewAgent")}
        >
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.profile.previewAgent")}
            options={agents.data ?? []}
            current={name()}
            onSelect={(item) => item && setAgent(item)}
          />
        </Field>
        <ButtonV2
          variant="neutral"
          disabled={!chosen() || !name()}
          onClick={() =>
            navigate(
              `/operator/agents/${encodeURIComponent(name()!)}?dir=${encodeURIComponent(chosen())}&tab=prompt&previewProfile=${encodeURIComponent(props.profile)}`,
            )
          }
        >
          {language.t("operator.profile.preview")}
        </ButtonV2>
      </div>
    </Show>
  )
}
