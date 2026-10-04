import { useSearchParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { type Projects, ProjectScope, scopeLabel } from "../ui/project-scope"
import { usePromptProfile, useProfileNames } from "./profile-data"
import {
  allowedIn,
  type Catalog,
  copyName,
  GROUP_ORDER,
  type Group,
  type GroupType,
  type Layer,
  MANDATORY,
  move,
} from "./profile-model"

type Draft = { id?: string; name: string; type: GroupType; projects: Projects; layers: string[]; builtin: boolean }

// Prompt groups: ordered lists of layers, listed in the order a profile holds them.
export function GroupDefinition() {
  const language = useLanguage()
  const data = usePromptProfile()
  const names = useProfileNames()
  const [params, setParams] = useSearchParams<{ group?: string }>()
  const catalog = () => data.query.data
  const groups = createMemo(() =>
    (catalog()?.groups ?? []).toSorted(
      (a, b) =>
        GROUP_ORDER.indexOf(a.type) - GROUP_ORDER.indexOf(b.type) ||
        Number(b.builtin) - Number(a.builtin) ||
        a.name.localeCompare(b.name),
    ),
  )
  const usedBy = (group: Group) =>
    (catalog()?.profiles ?? [])
      .filter((profile) => profile.groups.includes(group.id))
      .map((item) => names.profile(item))

  return (
    <div data-slot="operator-columns">
      <section data-component="operator-panel">
        <div data-slot="operator-panel-head">
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.groups")}</h2>
          <ButtonV2 size="small" variant="outline" onClick={() => setParams({ group: "new" })}>
            {language.t("operator.profile.newGroup")}
          </ButtonV2>
        </div>
        <p data-slot="operator-note">{language.t("operator.profile.groupsHint")}</p>
        <DataTable
          label={language.t("operator.profile.groups")}
          rows={groups()}
          loading={data.query.isPending}
          onRowClick={(group) => setParams({ group: group.id })}
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
            { id: "type", header: language.t("operator.profile.type"), cell: (group) => names.type(group.type) },
            {
              id: "scope",
              header: language.t("operator.profile.scope"),
              cell: (group) => scopeLabel(group.projects, catalog()?.projects ?? [], language.t("operator.scope.all")),
            },
            {
              id: "layers",
              header: language.t("operator.profile.layers"),
              align: "end",
              cell: (group) => group.layers.length,
            },
            {
              id: "profiles",
              header: language.t("operator.profile.usedIn"),
              cell: (group) => usedBy(group).join(", "),
            },
          ]}
        />
      </section>
      <section data-component="operator-panel" data-slot="operator-sticky">
        <Show
          when={catalog() && params.group ? catalog() : undefined}
          fallback={<p data-slot="operator-note">{language.t("operator.profile.pickGroup")}</p>}
        >
          {(loaded) => (
            <GroupEditor
              catalog={loaded()}
              id={params.group!}
              onDone={(id) => setParams({ group: id })}
              onDuplicate={(group) =>
                setParams({
                  group: `copy:${group.id}`,
                })
              }
            />
          )}
        </Show>
      </section>
    </div>
  )
}

function GroupEditor(props: {
  catalog: Catalog
  id: string
  onDone: (id: string | undefined) => void
  onDuplicate: (group: Group) => void
}) {
  const language = useLanguage()
  const names = useProfileNames()
  const data = usePromptProfile()
  const api = useOperatorClient()
  const confirm = useConfirm()
  const draft = createMemo<Draft | undefined>(() => {
    if (props.id === "new") return { name: "", type: "role", projects: "*", layers: [], builtin: false }
    const copy = props.id.startsWith("copy:")
    const found = props.catalog.groups.find((group) => group.id === (copy ? props.id.slice(5) : props.id))
    if (!found) return undefined
    if (copy)
      return {
        name: copyName(
          names.group(found),
          props.catalog.groups.map((group) => group.name),
        ),
        type: found.type,
        projects: found.projects,
        layers: [...found.layers],
        builtin: false,
      }
    return {
      id: found.id,
      name: found.name,
      type: found.type,
      projects: found.projects,
      layers: [...found.layers],
      builtin: found.builtin,
    }
  })
  const [store, setStore] = createStore({ draft: draft(), busy: false, add: "" })
  createEffect(on(draft, (next) => setStore({ draft: next, add: "" })))
  const layer = (id: string) => props.catalog.layers.find((item) => item.id === id)
  // Layers this type takes that are not in the group yet.
  const addable = createMemo(() => {
    const current = store.draft
    if (!current) return []
    return props.catalog.layers.filter((item) => allowedIn(current.type, item) && !current.layers.includes(item.id))
  })
  const locked = (id: string) => store.draft?.type === "purpose" && MANDATORY.includes(id)

  const save = async () => {
    const draft = store.draft
    if (!draft) return
    setStore("busy", true)
    const body = {
      name: draft.name.trim(),
      type: draft.type,
      projects: draft.projects === "*" ? ("*" as const) : [...draft.projects],
      // A Purpose group always starts with the org value and the project goal.
      layers:
        draft.type === "purpose"
          ? [...MANDATORY, ...draft.layers.filter((id) => !MANDATORY.includes(id))]
          : draft.layers.filter((id) => !MANDATORY.includes(id)),
    }
    const client = api.client().operator.promptProfile
    await (draft.id ? client.group.update({ id: draft.id, ...body }) : client.group.create(body))
      .then(async (result) => {
        await data.refresh()
        props.onDone(result.data?.id)
      })
      .catch(data.fail)
      .finally(() => setStore("busy", false))
  }

  const remove = async () => {
    const draft = store.draft
    if (!draft?.id) return
    const ok = await confirm({
      title: language.t("operator.profile.deleteGroupTitle", { name: draft.name }),
      description: language.t("operator.profile.deleteGroupBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.promptProfile.group.remove({ id: draft.id })
      .then(async () => {
        await data.refresh()
        props.onDone(undefined)
      })
      .catch(data.fail)
  }

  return (
    <Show when={store.draft} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchGroup")}</p>}>
      {(current) => (
        <>
          <div data-slot="operator-panel-head">
            <h2 data-slot="operator-panel-title">
              {current().id
                ? names.group({ ...current(), id: current().id! })
                : language.t("operator.profile.newGroup")}
            </h2>
            <Show when={current().id}>
              <ButtonV2
                size="small"
                variant="outline"
                onClick={() => props.onDuplicate(props.catalog.groups.find((group) => group.id === current().id)!)}
              >
                {language.t("operator.profile.duplicate")}
              </ButtonV2>
            </Show>
          </div>
          <Show when={current().builtin}>
            <p data-slot="operator-note">{language.t("operator.profile.builtinGroup")}</p>
          </Show>
          <div data-component="operator-form">
            <Field label={language.t("operator.agentForm.name")}>
              <TextInputV2
                appearance="base"
                value={current().name}
                disabled={current().builtin}
                onInput={(event) => setStore("draft", "name", event.currentTarget.value)}
              />
            </Field>
            <Field group label={language.t("operator.profile.type")}>
              <SelectV2<GroupType>
                appearance="base"
                disabled={current().builtin || !!current().id}
                options={[...GROUP_ORDER]}
                current={current().type}
                label={(type) => names.type(type)}
                onSelect={(type) =>
                  type &&
                  setStore("draft", {
                    type,
                    layers: current().layers.filter((id) => {
                      const found = layer(id)
                      return found ? allowedIn(type, found) : false
                    }),
                  })
                }
              />
            </Field>
            <Field group label={language.t("operator.profile.scope")}>
              <ProjectScope
                value={current().projects}
                projects={props.catalog.projects}
                disabled={current().builtin}
                onChange={(value) => setStore("draft", "projects", value)}
              />
            </Field>
            <Field
              group
              label={language.t("operator.profile.layers")}
              hint={language.t("operator.profile.layersOrderHint")}
            >
              <ol data-component="operator-layers" aria-label={language.t("operator.profile.layers")}>
                <Show when={current().type === "purpose"}>
                  <For each={MANDATORY.filter((id) => !current().layers.includes(id))}>
                    {(id) => <GroupLayerRow name={names.layer({ id, name: id })} locked />}
                  </For>
                </Show>
                <For each={current().layers}>
                  {(id, index) => (
                    <GroupLayerRow
                      name={layer(id) ? names.layer(layer(id)!) : id}
                      locked={locked(id)}
                      disabled={current().builtin}
                      onUp={() => setStore("draft", "layers", move(current().layers, index(), -1))}
                      onDown={() => setStore("draft", "layers", move(current().layers, index(), 1))}
                      onRemove={() =>
                        setStore(
                          "draft",
                          "layers",
                          current().layers.filter((item) => item !== id),
                        )
                      }
                    />
                  )}
                </For>
              </ol>
              <Show when={!current().builtin}>
                <SelectV2<Layer>
                  appearance="base"
                  aria-label={language.t("operator.profile.addLayer")}
                  placeholder={language.t("operator.profile.addLayer")}
                  options={addable()}
                  value={(item) => item.id}
                  label={(item) => `${names.layer(item)} · ${names.section(item.section)}`}
                  onSelect={(item) => item && setStore("draft", "layers", [...current().layers, item.id])}
                />
              </Show>
            </Field>
          </div>
          <Show when={!current().builtin}>
            <div data-slot="operator-actions">
              <Show when={current().id}>
                <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                  {language.t("operator.agent.delete")}
                </ButtonV2>
              </Show>
              <ButtonV2 variant="contrast" disabled={store.busy || !current().name.trim()} onClick={() => void save()}>
                {language.t("operator.config.save")}
              </ButtonV2>
            </div>
          </Show>
        </>
      )}
    </Show>
  )
}

function GroupLayerRow(props: {
  name: string
  locked?: boolean
  disabled?: boolean
  onUp?: () => void
  onDown?: () => void
  onRemove?: () => void
}) {
  const language = useLanguage()
  return (
    <li data-slot="operator-layer">
      <span data-slot="operator-layer-open">
        <span data-slot="operator-layer-name">{props.name}</span>
        <Show when={props.locked}>
          <Tag>{language.t("operator.prompts.mandatory")}</Tag>
        </Show>
      </span>
      <Show when={!props.locked && !props.disabled}>
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          aria-label={language.t("operator.profile.up", { name: props.name })}
          icon={<Icon name="arrow-up" />}
          onClick={props.onUp}
        />
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          aria-label={language.t("operator.profile.down", { name: props.name })}
          icon={<Icon name="chevron-down" />}
          onClick={props.onDown}
        />
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          aria-label={language.t("operator.profile.removeFrom", { name: props.name })}
          icon={<Icon name="close-small" />}
          onClick={props.onRemove}
        />
      </Show>
    </li>
  )
}
