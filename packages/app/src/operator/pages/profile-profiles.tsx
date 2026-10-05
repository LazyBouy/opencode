import { useNavigate, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { CopyToNamespace } from "../ui/copy-to"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { useAllLayers, usePromptCatalog, useProfileNames } from "./profile-data"
import { SlotEditor, type SlotValue } from "./profile-editor"
import {
  type Catalog,
  copyName,
  copySlots,
  type Layer,
  PREFIX,
  profileUsers,
  regroup,
  slotProblem,
} from "./profile-model"

const HELPER = `${PREFIX}profile.helper`

// Profile Definition: profiles (a group and the layers in each of its slots), and what uses each.
export function ProfileDefinition(props: { ns: string; namespaces: ReadonlyArray<OperatorNamespaceSummary> }) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const catalog = () => data.query.data
  const layers = useAllLayers(catalog)
  const [params, setParams] = useSearchParams<{ profile?: string }>()
  const groupName = (id: string) => {
    const found = catalog()?.groups.find((group) => group.id === id)
    return found ? names.group(found) : id
  }

  return (
    <div data-slot="operator-columns">
      <section data-component="operator-panel">
        <div data-slot="operator-panel-head">
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.profiles")}</h2>
          <ButtonV2 size="small" variant="outline" onClick={() => setParams({ profile: "new" })}>
            {language.t("operator.profile.newProfile")}
          </ButtonV2>
        </div>
        <p data-slot="operator-note">{language.t("operator.profile.profilesHint")}</p>
        <DataTable
          label={language.t("operator.profile.profiles")}
          rows={catalog()?.profiles ?? []}
          loading={data.query.isPending}
          onRowClick={(profile) => setParams({ profile: profile.id })}
          columns={[
            {
              id: "name",
              header: language.t("operator.column.name"),
              cell: (profile) => (
                <span class="flex items-center gap-2" data-selected={params.profile === profile.id ? "" : undefined}>
                  {names.profile(profile)}
                  <Show when={profile.builtin}>
                    <Tag>{language.t("operator.profile.builtin")}</Tag>
                  </Show>
                  <Show when={catalog()?.namespace.defaultProfile === profile.id}>
                    <Tag>{language.t("operator.profile.namespaceDefault")}</Tag>
                  </Show>
                </span>
              ),
            },
            { id: "group", header: language.t("operator.profile.group"), cell: (profile) => groupName(profile.group) },
            {
              id: "used",
              header: language.t("operator.profile.usedBy"),
              cell: (profile) => (
                <span data-slot="operator-cell-clamp">{usedBy(catalog(), profile.id).join(", ")}</span>
              ),
            },
          ]}
        />
      </section>
      <section data-component="operator-panel" data-slot="operator-sticky">
        <Show
          when={catalog() && params.profile ? catalog() : undefined}
          fallback={<p data-slot="operator-note">{language.t("operator.profile.pickProfile")}</p>}
        >
          {(loaded) => (
            <ProfilePanel
              ns={props.ns}
              namespaces={props.namespaces}
              catalog={loaded()}
              layers={layers()}
              selected={params.profile!}
              onSelect={(profile) => setParams({ profile })}
            />
          )}
        </Show>
      </section>
    </div>
  )

  // Short "used by" text for the table: agents that name the profile, projects whose default it is.
  function usedBy(loaded: Catalog | undefined, id: string) {
    if (!loaded) return []
    const users = profileUsers(loaded, id)
    return [
      ...(users.namespace ? [language.t("operator.profile.namespaceDefault")] : []),
      ...(id === HELPER ? [language.t("operator.profile.helperAgents")] : []),
      ...users.projects.map((project) => language.t("operator.profile.projectName", { name: project.name })),
      ...users.agents.map((agent) => agent.name),
    ]
  }
}

function ProfilePanel(props: {
  ns: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  catalog: Catalog
  layers: ReadonlyArray<Layer>
  selected: string
  onSelect: (profile: string | undefined) => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const names = useProfileNames()
  const data = usePromptCatalog(() => props.ns)
  const api = useOperatorClient()
  const client = () => api.client().operator.namespace
  const confirm = useConfirm()
  const copying = () => props.selected.startsWith("copy:")
  const fresh = () => props.selected === "new" || copying()
  const source = createMemo(() =>
    props.catalog.profiles.find((item) => item.id === (copying() ? props.selected.slice(5) : props.selected)),
  )
  const [store, setStore] = createStore({ name: "", value: { group: "", slots: {} } as SlotValue, busy: false })
  createEffect(
    on([() => props.selected, source], () => {
      const found = source()
      if (props.selected === "new") {
        const group = props.catalog.groups.find((item) => item.id === `${PREFIX}group.spec`) ?? props.catalog.groups[0]
        return setStore({ name: "", value: { group: group.id, slots: regroup({}, group.types).slots } })
      }
      if (!found) return
      setStore({
        name: copying()
          ? copyName(
              names.profile(found),
              props.catalog.profiles.map((item) => item.name),
            )
          : found.name,
        value: { group: found.group, slots: copySlots(found.slots) },
      })
    }),
  )
  const readOnly = () => !fresh() && !!source()?.builtin
  const problem = () => slotProblem(props.catalog, store.value.slots)
  const users = createMemo(() => (fresh() ? undefined : profileUsers(props.catalog, props.selected)))

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
      title: language.t("operator.profile.deleteTitle", { name: store.name }),
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

  return (
    <Show
      when={fresh() || source()}
      fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchProfile")}</p>}
    >
      <div data-slot="operator-panel-head">
        <h2 data-slot="operator-panel-title">
          {props.selected === "new"
            ? language.t("operator.profile.newProfile")
            : readOnly()
              ? names.profile(source()!)
              : store.name || language.t("operator.profile.newProfile")}
        </h2>
        <Show when={!fresh()}>
          <ButtonV2 size="small" variant="outline" onClick={() => props.onSelect(`copy:${props.selected}`)}>
            {language.t("operator.profile.duplicate")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={readOnly()}>
        <p data-slot="operator-note">{language.t("operator.profile.builtinProfile")}</p>
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
        <SlotEditor
          ns={props.ns}
          catalog={props.catalog}
          layers={props.layers}
          value={store.value}
          disabled={readOnly()}
          onChange={(value) => setStore("value", value)}
        />
      </div>
      <div data-slot="operator-actions">
        <Show when={!fresh()}>
          <Show when={!readOnly()}>
            <CopyToNamespace ns={props.ns} kind="profile" id={props.selected} namespaces={props.namespaces} />
          </Show>
          <Show when={props.catalog.namespace.defaultProfile !== props.selected}>
            <ButtonV2 variant="neutral" onClick={() => void makeDefault()}>
              {language.t("operator.profile.makeDefault")}
            </ButtonV2>
          </Show>
          <Show when={!readOnly()}>
            <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
              {language.t("operator.agent.delete")}
            </ButtonV2>
          </Show>
        </Show>
        <Show when={!readOnly()}>
          <ButtonV2
            variant="contrast"
            disabled={store.busy || !store.name.trim() || !!problem()}
            onClick={() => void save()}
          >
            {language.t("operator.config.save")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={users()}>
        {(found) => (
          <>
            <h3 data-slot="operator-panel-title">{language.t("operator.profile.usedBy")}</h3>
            <Show
              when={found().namespace || found().projects.length || found().agents.length || props.selected === HELPER}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.unused")}</p>}
            >
              <ul data-component="operator-list">
                <Show when={found().namespace}>
                  <li>{language.t("operator.profile.defaultOf", { namespace: props.catalog.namespace.name })}</li>
                </Show>
                <Show when={props.selected === HELPER}>
                  <li>{language.t("operator.profile.helperAgents")}</li>
                </Show>
                <For each={found().projects}>
                  {(project) => (
                    <li>
                      {language.t("operator.profile.projectDefault", { name: project.name })}
                      <span data-slot="operator-note"> · {shortPath(project.key)}</span>
                    </li>
                  )}
                </For>
                <For each={found().agents}>
                  {(agent) => (
                    <li>
                      <span>
                        {agent.name}
                        <span data-slot="operator-note"> · {shortPath(agent.project)}</span>
                      </span>
                      <button
                        type="button"
                        data-slot="operator-link"
                        onClick={() =>
                          navigate(
                            `/operator/agents/${encodeURIComponent(agent.name)}?dir=${encodeURIComponent(agent.project)}&tab=prompt`,
                          )
                        }
                      >
                        {language.t("operator.profile.openAgent")}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <PreviewOnAgent catalog={props.catalog} profile={props.selected} />
          </>
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
      <div class="flex items-center gap-2 flex-wrap">
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
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.profile.previewAgent")}
          options={agents.data ?? []}
          current={name()}
          onSelect={(item) => item && setAgent(item)}
        />
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
