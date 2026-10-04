import { useNavigate, useSearchParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQuery } from "@tanstack/solid-query"
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
  type Catalog,
  copyName,
  defaultFor,
  GROUP_ORDER,
  type GroupType,
  move,
  OPENCODE,
  type Profile,
  profileProblem,
  REQUIRED,
} from "./profile-model"

const HELPER_AGENTS = ["title", "summary", "compaction"]

type Draft = {
  id?: string
  name: string
  projects: Projects
  slots: Partial<Record<GroupType, string>>
  custom: string[]
  builtin: boolean
  defaults: string[]
}

// Prompt profiles: the groups an agent's system prompt is built from, and where each is the default.
export function ProfileDefinition() {
  const language = useLanguage()
  const data = usePromptProfile()
  const names = useProfileNames()
  const [params, setParams] = useSearchParams<{ profile?: string }>()
  const catalog = () => data.query.data
  const where = (profile: Profile) =>
    defaultFor(catalog()!, profile.id)
      .map((key) =>
        key === "global"
          ? language.t("operator.profile.global")
          : (catalog()!.projects.find((item) => item.key === key)?.name ?? key),
      )
      .join(", ")

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
                <span class="flex items-center gap-2">
                  {names.profile(profile)}
                  <Show when={profile.builtin}>
                    <Tag>{language.t("operator.profile.builtin")}</Tag>
                  </Show>
                </span>
              ),
            },
            {
              id: "scope",
              header: language.t("operator.profile.scope"),
              cell: (profile) =>
                scopeLabel(profile.projects, catalog()?.projects ?? [], language.t("operator.scope.all")),
            },
            {
              id: "groups",
              header: language.t("operator.profile.groups"),
              align: "end",
              cell: (profile) => profile.groups.length,
            },
            { id: "default", header: language.t("operator.profile.defaultFor"), cell: where },
          ]}
        />
      </section>
      <section data-component="operator-panel" data-slot="operator-sticky">
        <Show
          when={catalog() && params.profile ? catalog() : undefined}
          fallback={<p data-slot="operator-note">{language.t("operator.profile.pickProfile")}</p>}
        >
          {(loaded) => (
            <ProfileEditor catalog={loaded()} id={params.profile!} onSelect={(id) => setParams({ profile: id })} />
          )}
        </Show>
      </section>
    </div>
  )
}

function ProfileEditor(props: { catalog: Catalog; id: string; onSelect: (id: string | undefined) => void }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const names = useProfileNames()
  const data = usePromptProfile()
  const api = useOperatorClient()
  const confirm = useConfirm()
  const typeOf = (id: string) => props.catalog.groups.find((group) => group.id === id)?.type

  const draft = createMemo<Draft | undefined>(() => {
    if (props.id === "new") {
      const builtin = props.catalog.profiles.find((item) => item.id === "default")!
      return { ...fromProfile(builtin), id: undefined, name: "", builtin: false, defaults: [] }
    }
    const copy = props.id.startsWith("copy:")
    const found = props.catalog.profiles.find((item) => item.id === (copy ? props.id.slice(5) : props.id))
    if (!found) return undefined
    if (copy)
      return {
        ...fromProfile(found),
        id: undefined,
        name: copyName(
          names.profile(found),
          props.catalog.profiles.map((item) => item.name),
        ),
        builtin: false,
        defaults: [],
      }
    return fromProfile(found)
  })
  const [store, setStore] = createStore({ draft: draft(), busy: false })
  createEffect(on(draft, (next) => setStore({ draft: next })))

  function fromProfile(profile: Profile): Draft {
    const slots: Partial<Record<GroupType, string>> = {}
    profile.groups.forEach((id) => {
      const type = typeOf(id)
      if (type && type !== "custom") slots[type] = id
    })
    return {
      id: profile.id,
      name: profile.name,
      projects: profile.projects,
      slots,
      custom: profile.groups.filter((id) => typeOf(id) === "custom"),
      builtin: profile.builtin,
      defaults: defaultFor(props.catalog, profile.id),
    }
  }

  const groups = () => {
    const current = store.draft
    if (!current) return []
    return GROUP_ORDER.flatMap((type) =>
      type === "custom" ? current.custom : current.slots[type] ? [current.slots[type]!] : [],
    )
  }
  const problem = () => profileProblem(props.catalog, groups())
  const ofType = (type: GroupType) => props.catalog.groups.filter((group) => group.type === type)

  // Agents of every known project, to show who uses the profile.
  const agents = useQuery(() => ({
    queryKey: api.key(
      "profile-agents",
      props.catalog.projects.map((item) => item.key),
    ),
    queryFn: async () => {
      const folders = props.catalog.projects.filter((item) => item.key !== OPENCODE)
      const lists = await Promise.all(
        folders.map((project) =>
          api
            .client()
            .operator.agent.list({ directory: project.key })
            .then((result) =>
              (result.data ?? []).map((agent) => ({
                name: agent.name,
                project: agent.source.kind === "builtin" ? OPENCODE : project.key,
                folder: project.key,
                profile: (agent.settings.promptProfile as { profile?: string } | undefined)?.profile,
              })),
            )
            .catch(() => []),
        ),
      )
      const seen = new Set<string>()
      return lists.flat().filter((agent) => {
        const key = `${agent.project}:${agent.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    },
  }))
  const usedBy = createMemo(() => {
    const id = store.draft?.id
    if (!id) return []
    const defaults = props.catalog.defaults
    return (agents.data ?? []).filter(
      (agent) =>
        (agent.profile ??
          defaults.projects[agent.project] ??
          defaults.global ??
          (HELPER_AGENTS.includes(agent.name) ? "helper" : "default")) === id,
    )
  })

  const save = async () => {
    const current = store.draft
    if (!current) return
    setStore("busy", true)
    const client = api.client().operator.promptProfile
    const saved = current.builtin
      ? { id: current.id! }
      : await (
          current.id
            ? client.profile.update({
                id: current.id,
                name: current.name.trim(),
                projects: current.projects === "*" ? ("*" as const) : [...current.projects],
                groups: groups(),
              })
            : client.profile.create({
                name: current.name.trim(),
                projects: current.projects === "*" ? ("*" as const) : [...current.projects],
                groups: groups(),
              })
        )
          .then((result) => result.data)
          .catch((error: unknown) => {
            data.fail(error)
            return undefined
          })
    if (!saved) return setStore("busy", false)
    const before = defaultFor(props.catalog, saved.id)
    const changed = before.length !== current.defaults.length || before.some((key) => !current.defaults.includes(key))
    const done = changed
      ? await client
          .defaults({
            ...(current.defaults.includes("global")
              ? { global: saved.id }
              : props.catalog.defaults.global && props.catalog.defaults.global !== saved.id
                ? { global: props.catalog.defaults.global }
                : {}),
            projects: Object.fromEntries([
              ...Object.entries(props.catalog.defaults.projects).filter(
                (pair) => pair[1] !== saved.id && !current.defaults.includes(pair[0]),
              ),
              ...current.defaults.filter((key) => key !== "global").map((key) => [key, saved.id] as const),
            ]),
          })
          .then(() => true)
          .catch((error: unknown) => {
            data.fail(error)
            return false
          })
      : true
    await data.refresh()
    setStore("busy", false)
    if (done) props.onSelect(saved.id)
  }

  const remove = async () => {
    const current = store.draft
    if (!current?.id) return
    const ok = await confirm({
      title: language.t("operator.profile.deleteProfileTitle", { name: current.name }),
      description: language.t("operator.profile.deleteProfileBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.promptProfile.profile.remove({ id: current.id })
      .then(async () => {
        await data.refresh()
        props.onSelect(undefined)
      })
      .catch(data.fail)
  }

  const toggleDefault = (key: string, on: boolean) =>
    setStore("draft", "defaults", (list) => (on ? [...list, key] : list.filter((item) => item !== key)))

  return (
    <Show when={store.draft} fallback={<p data-slot="operator-note">{language.t("operator.profile.noSuchProfile")}</p>}>
      {(current) => (
        <>
          <div data-slot="operator-panel-head">
            <h2 data-slot="operator-panel-title">
              {current().id
                ? names.profile({ id: current().id!, name: current().name, builtin: current().builtin })
                : language.t("operator.profile.newProfile")}
            </h2>
            <Show when={current().id}>
              <ButtonV2 size="small" variant="outline" onClick={() => props.onSelect(`copy:${current().id}`)}>
                {language.t("operator.profile.duplicate")}
              </ButtonV2>
            </Show>
          </div>
          <Show when={current().builtin}>
            <p data-slot="operator-note">{language.t("operator.profile.builtinProfile")}</p>
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
            <Field group label={language.t("operator.profile.scope")}>
              <ProjectScope
                value={current().projects}
                projects={props.catalog.projects}
                disabled={current().builtin}
                onChange={(value) => setStore("draft", "projects", value)}
              />
            </Field>
            <For each={GROUP_ORDER}>
              {(type) => (
                <Show
                  when={type !== "custom"}
                  fallback={
                    <Field group label={language.t("operator.profile.customGroups")}>
                      <ol data-component="operator-layers">
                        <For each={current().custom}>
                          {(id, index) => (
                            <li data-slot="operator-layer">
                              <span data-slot="operator-layer-open">
                                <span data-slot="operator-layer-name">
                                  {names.group(
                                    props.catalog.groups.find((group) => group.id === id) ?? {
                                      id,
                                      name: id,
                                      builtin: false,
                                    },
                                  )}
                                </span>
                              </span>
                              <Show when={!current().builtin}>
                                <IconButtonV2
                                  variant="ghost-muted"
                                  size="small"
                                  aria-label={language.t("operator.profile.up", { name: id })}
                                  icon={<Icon name="arrow-up" />}
                                  onClick={() => setStore("draft", "custom", move(current().custom, index(), -1))}
                                />
                                <IconButtonV2
                                  variant="ghost-muted"
                                  size="small"
                                  aria-label={language.t("operator.profile.down", { name: id })}
                                  icon={<Icon name="chevron-down" />}
                                  onClick={() => setStore("draft", "custom", move(current().custom, index(), 1))}
                                />
                                <IconButtonV2
                                  variant="ghost-muted"
                                  size="small"
                                  aria-label={language.t("operator.profile.removeFrom", { name: id })}
                                  icon={<Icon name="close-small" />}
                                  onClick={() =>
                                    setStore(
                                      "draft",
                                      "custom",
                                      current().custom.filter((item) => item !== id),
                                    )
                                  }
                                />
                              </Show>
                            </li>
                          )}
                        </For>
                      </ol>
                      <Show when={!current().builtin}>
                        <SelectV2<string>
                          appearance="base"
                          aria-label={language.t("operator.profile.addGroup")}
                          placeholder={language.t("operator.profile.addGroup")}
                          options={ofType("custom")
                            .map((group) => group.id)
                            .filter((id) => !current().custom.includes(id))}
                          label={(id) => names.group(props.catalog.groups.find((group) => group.id === id)!)}
                          onSelect={(id) => id && setStore("draft", "custom", [...current().custom, id])}
                        />
                      </Show>
                    </Field>
                  }
                >
                  <Field group label={names.type(type)}>
                    <SelectV2<string>
                      appearance="base"
                      aria-label={names.type(type)}
                      disabled={current().builtin}
                      options={[...(REQUIRED.includes(type) ? [] : [""]), ...ofType(type).map((group) => group.id)]}
                      current={current().slots[type] ?? ""}
                      label={(id) =>
                        id
                          ? names.group(props.catalog.groups.find((group) => group.id === id)!)
                          : language.t("operator.profile.none")
                      }
                      onSelect={(id) => setStore("draft", "slots", type, id || undefined)}
                    />
                  </Field>
                </Show>
              )}
            </For>
            <Field
              group
              label={language.t("operator.profile.defaultFor")}
              hint={language.t("operator.profile.defaultHint")}
            >
              <div data-slot="operator-scope-list">
                <CheckboxV2
                  label={language.t("operator.profile.global")}
                  checked={current().defaults.includes("global")}
                  onChange={(checked: boolean) => toggleDefault("global", checked)}
                />
                <For each={props.catalog.projects}>
                  {(project) => (
                    <CheckboxV2
                      label={project.name}
                      checked={current().defaults.includes(project.key)}
                      onChange={(checked: boolean) => toggleDefault(project.key, checked)}
                    />
                  )}
                </For>
              </div>
            </Field>
          </div>
          <Show when={problem()}>
            {(found) => (
              <p data-slot="operator-error" role="alert">
                {found().kind === "required"
                  ? language.t("operator.profile.needsGroup", { type: names.type(found().type!) })
                  : language.t("operator.profile.repeated", { layer: found().layer! })}
              </p>
            )}
          </Show>
          <div data-slot="operator-actions">
            <Show when={current().id && !current().builtin}>
              <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                {language.t("operator.agent.delete")}
              </ButtonV2>
            </Show>
            <ButtonV2
              variant="contrast"
              disabled={store.busy || !current().name.trim() || !!problem()}
              onClick={() => void save()}
            >
              {language.t("operator.config.save")}
            </ButtonV2>
          </div>
          <Show when={current().id}>
            <h3 data-slot="operator-panel-title">{language.t("operator.profile.usedBy")}</h3>
            <Show
              when={usedBy().length}
              fallback={<p data-slot="operator-note">{language.t("operator.profile.unused")}</p>}
            >
              <ul data-component="operator-list">
                <For each={usedBy()}>
                  {(agent) => (
                    <li>
                      <span>
                        {agent.name}
                        <span data-slot="operator-note">
                          {" "}
                          · {props.catalog.projects.find((item) => item.key === agent.project)?.name ?? agent.project}
                        </span>
                      </span>
                      <button
                        type="button"
                        data-slot="operator-link"
                        onClick={() =>
                          navigate(
                            `/operator/agents/${encodeURIComponent(agent.name)}?dir=${encodeURIComponent(agent.folder)}&tab=prompt`,
                          )
                        }
                      >
                        {language.t("operator.profile.preview")}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </>
      )}
    </Show>
  )
}
