import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type {
  OperatorProjectGroup,
  OperatorProjectRecord,
  OperatorProjectStatus,
  OperatorPromptProject,
} from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, Index, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { Field } from "../ui/field"
import { RecordField } from "../ui/record-overlay"
import { requestError } from "./config-helpers"
import { usePromptCatalog } from "./profile-data"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
const STATUSES: OperatorProjectStatus[] = ["draft", "active", "paused", "completed", "archived"]
const NONE = "@none"

// Every project's record (description, status, manager, members, groups); a project without one is
// active, with no members (every agent may participate).
export function useProjectRecords() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("project-records"),
    queryFn: () =>
      api
        .client()
        .operator.projectRecord.list()
        .then((result) => result.data ?? []),
  }))
}

export function recordOf(
  records: ReadonlyArray<OperatorProjectRecord> | undefined,
  key: string,
): OperatorProjectRecord {
  return (
    records?.find((item) => item.key === key) ?? { key, description: "", status: "active", members: [], groups: [] }
  )
}

// The project's goal: its linked Project Purpose layer's text, and the other projects that link it.
function useGoal(setting: () => OperatorPromptProject) {
  const catalog = usePromptCatalog(() => setting().namespace)
  const layer = createMemo(() =>
    setting().purpose ? catalog.query.data?.layers.find((item) => item.id === setting().purpose) : undefined,
  )
  const shared = createMemo(() =>
    (catalog.query.data?.projects ?? []).filter(
      (project) => project.purpose && project.purpose === setting().purpose && project.key !== setting().key,
    ),
  )
  return { catalog, layer, shared }
}

// The project's record in its overlay: goal, description, status, manager, members, groups.
export function ProjectRecordFields(props: { setting: OperatorPromptProject }) {
  const language = useLanguage()
  const records = useProjectRecords()
  const record = () => recordOf(records.data, props.setting.key)
  const goal = useGoal(() => props.setting)
  return (
    <>
      <RecordField label={language.t("operator.projectRecord.goal")} help={language.t("operator.help.projectGoal")}>
        <Show
          when={goal.layer()}
          fallback={<span data-slot="operator-note">{language.t("operator.projectRecord.noGoal")}</span>}
        >
          {(layer) => (
            <span class="flex flex-col gap-1" data-testid="project-goal">
              <span style={{ "white-space": "pre-wrap" }}>{layer().text}</span>
              <Show when={goal.shared().length}>
                <span data-slot="operator-note">
                  {language.t("operator.projectRecord.goalShared", {
                    projects: goal
                      .shared()
                      .map((item) => item.name)
                      .join(", "),
                  })}
                </span>
              </Show>
            </span>
          )}
        </Show>
      </RecordField>
      <RecordField
        label={language.t("operator.projectRecord.description")}
        help={language.t("operator.help.projectDescription")}
      >
        <span style={{ "white-space": "pre-wrap" }}>{record().description || "—"}</span>
      </RecordField>
      <RecordField label={language.t("operator.projectRecord.status")} help={language.t("operator.help.projectStatus")}>
        <Tag>{language.t(`operator.projectRecord.status.${record().status}` as Key)}</Tag>
      </RecordField>
      <RecordField
        label={language.t("operator.projectRecord.manager")}
        help={language.t("operator.help.projectManager")}
      >
        {record().manager ?? "—"}
      </RecordField>
      <RecordField
        label={language.t("operator.projectRecord.members")}
        help={language.t("operator.help.projectMembers")}
      >
        <span data-testid="project-members">
          {record().members.length ? record().members.join(", ") : language.t("operator.projectRecord.everyAgent")}
        </span>
      </RecordField>
      <RecordField label={language.t("operator.projectRecord.groups")} help={language.t("operator.help.projectGroups")}>
        <Show when={record().groups.length} fallback="—">
          <span class="flex flex-col gap-0.5">
            <For each={record().groups}>
              {(group) => (
                <span>
                  <strong>{group.name}</strong>: {group.members.join(", ") || "—"}
                </span>
              )}
            </For>
          </span>
        </Show>
      </RecordField>
    </>
  )
}

// Edit the project's record and its goal (the linked Project Purpose layer: changed in place, or a
// new one made and linked when it has none).
export function ProjectRecordForm(props: { setting: OperatorPromptProject; name: string; onDone: () => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const records = useProjectRecords()
  const goal = useGoal(() => props.setting)
  const agents = useQuery(() => ({
    queryKey: api.key("agents", props.setting.key),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: props.setting.key })
        .then((result) => result.data ?? []),
  }))
  // Agents that can be members: the project's agents, but not OpenCode's helpers (always allowed).
  const candidates = createMemo(() =>
    (agents.data ?? [])
      .filter((agent) => !["title", "summary", "compaction"].includes(agent.name))
      .map((agent) => agent.name),
  )
  const initial = recordOf(records.data, props.setting.key)
  const [store, setStore] = createStore({
    goal: goal.layer()?.text ?? "",
    description: initial.description,
    status: initial.status,
    manager: initial.manager ?? NONE,
    members: [...initial.members],
    groups: initial.groups.map((group) => ({ ...group, members: [...group.members] })) as OperatorProjectGroup[],
    busy: false,
    error: "",
  })
  // The goal's text once the catalog has loaded, unless it was already changed here.
  let typed = false
  createEffect(
    on(
      () => goal.layer()?.text,
      (text) => {
        if (!typed && text !== undefined) setStore("goal", text)
      },
    ),
  )
  const toggle = (list: string[], name: string, on: boolean) =>
    on ? [...new Set([...list, name])] : list.filter((item) => item !== name)
  // A manager and group members are picked from the members (every agent when there are none).
  const pickable = () => (store.members.length ? store.members : candidates())

  const save = async () => {
    setStore({ busy: true, error: "" })
    const client = api.client().operator
    try {
      // The goal: the linked layer's text, or a new layer linked to the project.
      const text = store.goal.trim()
      const layer = goal.layer()
      if (layer && text !== layer.text)
        await client.namespace.layer.update(
          { ns: props.setting.namespace, id: layer.id, name: layer.name, type: layer.type, text },
          { throwOnError: true },
        )
      if (!layer && text) {
        const made = await client.namespace.layer.create(
          {
            ns: props.setting.namespace,
            name: language.t("operator.projectRecord.goalName", { name: props.name }),
            type: "purpose",
            text,
            section: "purpose",
          },
          { throwOnError: true },
        )
        await client.projectSettings.update({ key: props.setting.key, purpose: made.data!.id }, { throwOnError: true })
      }
      await client.projectRecord.update(
        {
          key: props.setting.key,
          description: store.description,
          status: store.status,
          // An empty name: no manager.
          manager: store.manager === NONE ? "" : store.manager,
          members: store.members,
          groups: store.groups.map((group) => ({ ...group, name: group.name.trim() || group.id })),
        },
        { throwOnError: true },
      )
      await Promise.all(
        ["project-records", "project-settings", "prompt-catalog", "prompt-preview", "agent-prompt"].map((key) =>
          queryClient.invalidateQueries({ queryKey: api.key(key) }),
        ),
      )
      props.onDone()
    } catch (error) {
      setStore("error", requestError(error))
    } finally {
      setStore("busy", false)
    }
  }

  return (
    <div data-component="operator-form" data-testid="project-record-form">
      <Field label={language.t("operator.projectRecord.goal")} hint={language.t("operator.help.projectGoal")}>
        <TextareaV2
          rows={4}
          value={store.goal}
          onInput={(event) => {
            typed = true
            setStore("goal", event.currentTarget.value)
          }}
        />
      </Field>
      <Show when={goal.shared().length}>
        <p data-slot="operator-note" data-warning="">
          {language.t("operator.projectRecord.goalShared", {
            projects: goal
              .shared()
              .map((item) => item.name)
              .join(", "),
          })}
        </p>
      </Show>
      <Field
        label={language.t("operator.projectRecord.description")}
        hint={language.t("operator.help.projectDescription")}
      >
        <TextareaV2
          rows={3}
          value={store.description}
          onInput={(event) => setStore("description", event.currentTarget.value)}
        />
      </Field>
      <Field group label={language.t("operator.projectRecord.status")} hint={language.t("operator.help.projectStatus")}>
        <SelectV2<OperatorProjectStatus>
          appearance="base"
          aria-label={language.t("operator.projectRecord.status")}
          options={STATUSES}
          current={store.status}
          label={(status) => language.t(`operator.projectRecord.status.${status}` as Key)}
          onSelect={(status) => status && setStore("status", status)}
        />
      </Field>
      <Field
        group
        label={language.t("operator.projectRecord.members")}
        hint={language.t("operator.help.projectMembers")}
      >
        <div data-slot="operator-checklist" data-testid="project-members-edit">
          <For each={candidates()}>
            {(name) => (
              <CheckboxV2
                label={name}
                checked={store.members.includes(name)}
                onChange={(on: boolean) => {
                  setStore("members", toggle(store.members, name, on))
                  if (!on && store.manager === name) setStore("manager", NONE)
                }}
              />
            )}
          </For>
        </div>
        <p data-slot="operator-note">
          {store.members.length
            ? language.t("operator.projectRecord.membersOnly")
            : language.t("operator.projectRecord.everyAgent")}
        </p>
      </Field>
      <Field
        group
        label={language.t("operator.projectRecord.manager")}
        hint={language.t("operator.help.projectManager")}
      >
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.projectRecord.manager")}
          options={[NONE, ...pickable()]}
          current={store.manager}
          label={(name) => (name === NONE ? language.t("operator.projectRecord.noManager") : name)}
          onSelect={(name) => name && setStore("manager", name)}
        />
      </Field>
      <Field group label={language.t("operator.projectRecord.groups")} hint={language.t("operator.help.projectGroups")}>
        <div class="flex flex-col gap-2">
          <Index each={store.groups}>
            {(group, index) => (
              <div data-slot="operator-group-edit">
                <div class="flex items-center gap-2">
                  <TextInputV2
                    appearance="base"
                    value={group().name}
                    aria-label={language.t("operator.projectRecord.groupName")}
                    onInput={(event) => setStore("groups", index, "name", event.currentTarget.value)}
                  />
                  <IconButtonV2
                    variant="ghost-muted"
                    size="small"
                    icon={<Icon name="trash" />}
                    aria-label={language.t("operator.projectRecord.removeGroup")}
                    onClick={() => setStore("groups", (list) => list.filter((_, at) => at !== index))}
                  />
                </div>
                <div data-slot="operator-checklist">
                  <For each={pickable()}>
                    {(name) => (
                      <CheckboxV2
                        label={name}
                        checked={group().members.includes(name)}
                        onChange={(on: boolean) =>
                          setStore("groups", index, "members", toggle([...group().members], name, on))
                        }
                      />
                    )}
                  </For>
                </div>
              </div>
            )}
          </Index>
          <div>
            <ButtonV2
              size="small"
              variant="outline"
              onClick={() =>
                setStore("groups", (list) => [
                  ...list,
                  {
                    id: `group-${Date.now().toString(36)}`,
                    name: language.t("operator.projectRecord.newGroup"),
                    members: [],
                  },
                ])
              }
            >
              {language.t("operator.projectRecord.addGroup")}
            </ButtonV2>
          </div>
        </div>
      </Field>
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div data-slot="operator-actions">
        <ButtonV2 variant="neutral" onClick={props.onDone}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void save()}>
          {language.t("operator.config.save")}
        </ButtonV2>
      </div>
    </div>
  )
}
