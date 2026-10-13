import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorHelper, OperatorHelperModel, OperatorHelperRole } from "@opencode-ai/sdk/v2/client"
import { useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { useOperatorProjects } from "../project"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { useProjectModels } from "../ui/model-defaults"
import { SelectV2 } from "../ui/select"
import { TextCounters } from "../ui/text-counters"
import { AgentModelFields, type ModelForm } from "./agent-model-fields"
import { useInventory } from "./capability-scope"
import { requestError } from "./config-helpers"
import { useNamespaces } from "./profile-data"
import { useHelpers } from "./helper-data"
import { browserZone, formsOf, type TriggerForm, triggersOf } from "./helper-trigger-model"
import { TriggersEditor } from "./helper-triggers"

// A helper's form (agent_types_spec.md §4.3): its namespace (instead of Save in), name, description, model (Small
// model by default: the small model of the project it serves, the namespace's default project here), its text
// (a helper profile holding one helper layer, edited in place) with counters, and its step and time limits.
// Callable by agents (the `helper` tool, with a one-line usage), and its Actions (§4.6): the tools and system
// actions its runs may use; any tool but a read-only one is added only after "This helper will run … unattended".
// Its roles (§4.4), and its triggers (§4.9): schedules and events that start it on its own.

export const STEPS = { default: 5, max: 20 }
export const TIMEOUT = { default: 120, min: 10, max: 600 }
// As helpers.ts has them.
export const SYSTEM_ACTIONS = ["list_sessions", "archive_session", "trash_session", "notify", "memory"]
export const READ_ONLY = ["read", "glob", "grep", "webfetch", "list_sessions", "memory"]
// What a helper that writes a Dynamic layer may declare.
export const LAYER_ACTIONS = ["read", "glob", "grep", "webfetch", "list_sessions"]
// The built-in roles a helper can take over in its namespace (§4.4).
export const ROLES = ["title", "compaction", "summary", "agent-generator", "purpose-generator", "dynamic-generator"]
const NOT_DECLARABLE = ["question", "task", "helper", "invalid"]

type Form = ModelForm & {
  namespace: string
  name: string
  description: string
  text: string
  steps: string
  timeout: string
  callable: boolean
  usage: string
  actions: string[]
  roles: string[]
  triggers: TriggerForm[]
}

function formOf(namespace: string, helper: OperatorHelper | undefined): Form {
  const source = helper?.model.source
  return {
    namespace: helper?.namespace ?? namespace,
    name: helper?.name ?? "",
    description: helper?.description ?? "",
    modelSource: source === "default" || source === "pick" ? source : "small",
    model: helper?.model.model ?? "",
    variant: helper?.model.variant ?? "",
    text: helper?.text ?? "",
    steps: String(helper?.steps ?? STEPS.default),
    timeout: String(helper?.timeout ?? TIMEOUT.default),
    callable: helper?.callable ?? false,
    usage: helper?.usage ?? "",
    actions: [...(helper?.actions ?? [])],
    roles: [...(helper?.roles ?? [])],
    triggers: formsOf(helper?.triggers ?? [], browserZone()),
  }
}

function modelOf(form: Form): OperatorHelperModel {
  return {
    source: form.modelSource,
    ...(form.modelSource === "pick" ? { model: form.model.trim() } : {}),
    ...(form.modelSource !== "default" && form.variant ? { variant: form.variant } : {}),
  }
}

export function HelperForm(props: {
  /** The namespace a new helper starts in. */
  namespace: string
  /** Editing this helper (its namespace and name stay). */
  helper?: OperatorHelper
  onSaved: (helper: OperatorHelper) => void
  onCancel: () => void
  /** Shown first (the agent form's Type). */
  before?: JSX.Element
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const namespaces = useNamespaces()
  const projects = useOperatorProjects()
  const [store, setStore] = createStore({ form: formOf(props.namespace, props.helper), error: "", saving: false })
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setStore("form", key, value)
  const editing = () => !!props.helper

  // The project a helper serves by default: its namespace's default project.
  const summary = () => namespaces.data?.find((item) => item.namespace.id === store.form.namespace)
  const project = () => summary()?.defaultProject
  const projectName = () => projects().find((item) => item.directory === project())?.label ?? project() ?? ""
  const chain = useProjectModels(project)
  // The model the counters count for.
  const model = () => {
    const found = ready(chain)?.chain
    if (store.form.modelSource === "pick") return store.form.model || undefined
    return (store.form.modelSource === "small" ? found?.small : found?.model)?.effective.model || undefined
  }

  // What it may declare: the tools of the project it serves, and the fork's system actions.
  const confirm = useConfirm()
  // Roles (§4.4): one helper per role in a namespace; taking one moves it here.
  const helpers = useHelpers(() => store.form.namespace)
  const holderOf = (role: string) =>
    (ready(helpers) ?? []).find(
      (item) => !item.builtin && item.name !== props.helper?.name && (item.roles as string[]).includes(role),
    )
  const roleLabel = (role: string) => language.t(`operator.helper.role.${role}` as "operator.helper.role.title")
  const [rolePicker, setRolePicker] = createSignal(1)
  const inventory = useInventory(project, () => undefined)
  const tools = createMemo(() =>
    [
      ...new Set(
        (inventory.data?.items ?? [])
          .filter((item) => item.kind === "tool")
          .map((item) => item.name)
          .filter((name) => !NOT_DECLARABLE.includes(name) && !SYSTEM_ACTIONS.includes(name)),
      ),
    ].toSorted(),
  )
  const available = () => [...SYSTEM_ACTIONS, ...tools()].filter((name) => !store.form.actions.includes(name))
  const declare = async (name: string) => {
    if (!READ_ONLY.includes(name)) {
      const ok = await confirm({
        title: language.t("operator.helper.unattendedTitle", { tool: name }),
        description: language.t("operator.helper.unattendedBody"),
        confirm: language.t("operator.helper.unattendedConfirm"),
        danger: true,
      })
      if (!ok) return
    }
    set("actions", [...store.form.actions, name])
  }
  const [picker, setPicker] = createSignal(1)
  const actionLabel = (name: string) =>
    SYSTEM_ACTIONS.includes(name)
      ? language.t(`operator.helper.action.${name}` as "operator.helper.action.notify")
      : name

  const save = async () => {
    setStore({ saving: true, error: "" })
    const client = api.client()
    const fields = {
      description: store.form.description.trim(),
      model: modelOf(store.form),
      text: store.form.text,
      steps: Number(store.form.steps),
      timeout: Number(store.form.timeout),
      callable: store.form.callable,
      usage: store.form.usage.trim(),
      actions: [...store.form.actions],
      roles: [...store.form.roles] as OperatorHelperRole[],
      triggers: triggersOf(store.form.triggers),
    }
    const request = props.helper
      ? client.operator.helper.update(
          { ns: props.helper.namespace, name: props.helper.name, ...fields },
          { throwOnError: true },
        )
      : client.operator.helper.create(
          {
            ns: store.form.namespace,
            name: store.form.name.trim(),
            ...fields,
            ...(fields.description ? {} : { description: undefined }),
          },
          { throwOnError: true },
        )
    await request
      .then((result) => {
        void queryClient.invalidateQueries({ queryKey: api.key("helpers") })
        props.onSaved(result.data)
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <section data-component="operator-panel">
      <div data-component="operator-form">
        {props.before}
        <Field group label={language.t("operator.helper.namespace")} hint={language.t("operator.help.helperNamespace")}>
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.helper.namespace")}
            disabled={editing()}
            options={(namespaces.data ?? []).map((item) => item.namespace.id)}
            current={store.form.namespace}
            label={(id) => namespaces.data?.find((item) => item.namespace.id === id)?.namespace.name ?? id}
            onSelect={(id) => id && set("namespace", id)}
          />
        </Field>
        <Show when={!editing()}>
          <Field label={language.t("operator.agentForm.name")} hint={language.t("operator.helper.nameHint")}>
            <TextInputV2
              appearance="base"
              value={store.form.name}
              onInput={(event) => set("name", event.currentTarget.value)}
            />
          </Field>
        </Show>
        <Field label={language.t("operator.column.description")} hint={language.t("operator.help.helperDescription")}>
          <TextInputV2
            appearance="base"
            value={store.form.description}
            onInput={(event) => set("description", event.currentTarget.value)}
          />
        </Field>
        <AgentModelFields
          form={store.form}
          set={(key, value) => set(key, value)}
          directory={project()}
          scope="project"
          editing={editing()}
          prefill={false}
          where={projectName()}
        />
        <Field label={language.t("operator.helper.text")} hint={language.t("operator.help.helperText")}>
          <TextCounters text={store.form.text} model={model()} directory={project()} />
          <TextareaV2
            class="operator-editor"
            aria-label={language.t("operator.helper.text")}
            rows={10}
            value={store.form.text}
            onInput={(event) => set("text", event.currentTarget.value)}
          />
        </Field>
        <div data-slot="operator-form-row">
          <Field
            label={language.t("operator.helper.steps")}
            hint={language.t("operator.help.helperSteps", { max: STEPS.max })}
          >
            <TextInputV2
              appearance="base"
              inputMode="numeric"
              value={store.form.steps}
              onInput={(event) => set("steps", event.currentTarget.value)}
            />
          </Field>
          <Field
            label={language.t("operator.helper.timeout")}
            hint={language.t("operator.help.helperTimeout", { min: TIMEOUT.min, max: TIMEOUT.max })}
          >
            <TextInputV2
              appearance="base"
              inputMode="numeric"
              value={store.form.timeout}
              onInput={(event) => set("timeout", event.currentTarget.value)}
            />
          </Field>
        </div>
        <Field group label={language.t("operator.helper.callable")} hint={language.t("operator.help.helperCallable")}>
          <Switch checked={store.form.callable} onChange={(checked) => set("callable", checked)}>
            {language.t("operator.helper.callableSwitch")}
          </Switch>
        </Field>
        <Show when={store.form.callable}>
          <Field label={language.t("operator.helper.usage")} hint={language.t("operator.help.helperUsage")}>
            <TextInputV2
              appearance="base"
              value={store.form.usage}
              onInput={(event) => set("usage", event.currentTarget.value)}
            />
          </Field>
        </Show>
        <Field group label={language.t("operator.helper.roles")} hint={language.t("operator.help.helperRoles")}>
          <div class="flex flex-wrap items-center gap-2" data-testid="helper-roles">
            <Show
              when={store.form.roles.length}
              fallback={<span data-slot="operator-note">{language.t("operator.helper.noRoles")}</span>}
            >
              <For each={store.form.roles}>
                {(role) => (
                  <Tag>
                    {roleLabel(role)}
                    <button
                      type="button"
                      data-slot="operator-tag-remove"
                      aria-label={language.t("operator.helper.removeRole", { role: roleLabel(role) })}
                      onClick={() =>
                        set(
                          "roles",
                          store.form.roles.filter((item) => item !== role),
                        )
                      }
                    >
                      ×
                    </button>
                  </Tag>
                )}
              </For>
            </Show>
          </div>
          <Show when={!store.form.actions.length}>
            <Show when={rolePicker()} keyed>
              {(_) => (
                <SelectV2<string>
                  appearance="base"
                  aria-label={language.t("operator.helper.addRole")}
                  placeholder={language.t("operator.helper.addRole")}
                  options={ROLES.filter((role) => !store.form.roles.includes(role))}
                  current={undefined}
                  label={roleLabel}
                  onSelect={(role) => {
                    setRolePicker((value) => value + 1)
                    if (role) set("roles", [...store.form.roles, role])
                  }}
                />
              )}
            </Show>
          </Show>
          <For each={store.form.roles}>
            {(role) => (
              <p data-slot="operator-note" data-testid={`role-contract-${role}`}>
                <strong>{roleLabel(role)}:</strong>{" "}
                {language.t(`operator.helper.contract.${role}` as "operator.helper.contract.title")}
                <Show when={holderOf(role)}>
                  {(holder) => <> {language.t("operator.helper.roleMoves", { name: holder().name })}</>}
                </Show>
              </p>
            )}
          </For>
          <Show when={store.form.namespace === "opencode" && store.form.roles.length}>
            <p data-slot="operator-note" data-warning="" role="status" data-testid="role-opencode-warning">
              {language.t("operator.helper.opencodeWarning", { roles: store.form.roles.map(roleLabel).join(", ") })}
            </p>
          </Show>
        </Field>
        <Field group label={language.t("operator.helper.actions")} hint={language.t("operator.help.helperActions")}>
          <div class="flex flex-wrap items-center gap-2" data-testid="helper-actions">
            <Show
              when={store.form.actions.length}
              fallback={<span data-slot="operator-note">{language.t("operator.helper.noActions")}</span>}
            >
              <For each={store.form.actions}>
                {(name) => (
                  <Tag>
                    {actionLabel(name)}
                    <button
                      type="button"
                      data-slot="operator-tag-remove"
                      aria-label={language.t("operator.helper.removeAction", { action: name })}
                      onClick={() =>
                        set(
                          "actions",
                          store.form.actions.filter((item) => item !== name),
                        )
                      }
                    >
                      ×
                    </button>
                  </Tag>
                )}
              </For>
            </Show>
          </div>
          <Show when={store.form.roles.length}>
            <p data-slot="operator-note">{language.t("operator.helper.rolesNoActions")}</p>
          </Show>
          {/* Made again after each pick, so it always starts empty (and the same action can be picked again). */}
          <Show when={!store.form.roles.length && picker()} keyed>
            {(_) => (
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.helper.addAction")}
                placeholder={language.t("operator.helper.addAction")}
                options={available()}
                current={undefined}
                label={actionLabel}
                onSelect={(name) => {
                  setPicker((value) => value + 1)
                  if (name) void declare(name)
                }}
              />
            )}
          </Show>
        </Field>
        <Field group label={language.t("operator.helper.triggers")} hint={language.t("operator.help.helperTriggers")}>
          <TriggersEditor triggers={store.form.triggers} onChange={(next) => set("triggers", next)} />
        </Field>
      </div>
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div data-slot="operator-actions">
        <ButtonV2 variant="neutral" onClick={() => props.onCancel()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={store.saving || (!editing() && !store.form.name.trim())}
          onClick={() => void save()}
        >
          {editing() ? language.t("common.save") : language.t("operator.helper.create")}
        </ButtonV2>
      </div>
    </section>
  )
}
