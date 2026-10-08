import { useNavigate, useSearchParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorCapability, OperatorCapabilityKind, OperatorCapabilityOrigin } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createUniqueId, For, type JSX, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { asList, ready, useOperatorClient } from "../data"
import { useMoveToTrash } from "../ui/confirm"
import { FieldHelp } from "../ui/field-help"
import { ALL, useNamespaceScope } from "../ui/namespace-picker"
import { requestError } from "./config-helpers"

// The Capabilities page's scope (capability_scopes_spec.md §9): a project's effective set, or a
// namespace's own layer. Every row shows where its definition comes from and its state, and the actions
// a scope allows: override, disable, revert (project or namespace), delete (its own), create.

export type View = "project" | "namespace"

// OpenCode's built-ins a namespace or project can copy (capability_scopes_spec.md §7).
export const COPYABLE = new Set([
  "command:init",
  "command:review",
  "agent:build",
  "agent:plan",
  "agent:general",
  "agent:explore",
  "skill:customize-opencode",
])
type Language = ReturnType<typeof useLanguage>

export function useCapabilityScope() {
  const [params, setParams] = useSearchParams<{ cscope?: string }>()
  const namespaces = useNamespaceScope()
  const view = (): View => (params.cscope === "namespace" ? "namespace" : "project")
  // The namespace view needs one namespace: with all of them in scope, OpenCode.
  const namespace = () => (namespaces.ns() === ALL ? "opencode" : namespaces.ns())
  return {
    view,
    namespace,
    namespaces,
    setView: (next: View) => setParams({ cscope: next === "namespace" ? "namespace" : undefined }),
  }
}

// Project | Namespace, and the namespace when it is the namespace view.
export function CapabilityScopePicker() {
  const language = useLanguage()
  const scope = useCapabilityScope()
  return (
    <span class="inline-flex items-center gap-2">
      <SegmentedControlV2
        aria-label={language.t("operator.capabilities.scope")}
        value={scope.view()}
        onChange={(value) => {
          if (value === "project" || value === "namespace") scope.setView(value)
        }}
      >
        <SegmentedControlItemV2 value="project">
          {language.t("operator.capabilities.scope.project")}
        </SegmentedControlItemV2>
        <SegmentedControlItemV2 value="namespace">
          {language.t("operator.capabilities.scope.namespace")}
        </SegmentedControlItemV2>
      </SegmentedControlV2>
      <Show when={scope.view() === "namespace"}>
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.profile.namespace")}
          options={scope.namespaces.namespaces().map((item) => item.namespace.id)}
          current={scope.namespace()}
          label={(id) => scope.namespaces.name(id)}
          onSelect={(id) => id && scope.namespaces.set(id)}
        />
      </Show>
      <FieldHelp field={language.t("operator.capabilities.scope")} text={language.t("operator.help.capabilityScope")} />
    </span>
  )
}

export function useInventory(directory: () => string | undefined, namespace: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("capabilities", directory(), namespace() ?? ""),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.capability.list({ directory: directory(), ...(namespace() ? { namespace: namespace() } : {}) })
        .then((result) => result.data!),
  }))
}

// An item of the inventory by kind and name.
export function itemOf(
  items: ReadonlyArray<OperatorCapability> | undefined,
  kind: OperatorCapabilityKind,
  name: string,
) {
  return items?.find((item) => item.kind === kind && item.name === name)
}

export function OriginChip(props: { origin: OperatorCapabilityOrigin | undefined }) {
  const language = useLanguage()
  return (
    <Show when={props.origin}>
      {(origin) => (
        <Tag variant={origin() === "opencode" ? "neutral" : "accent"} data-origin={origin()}>
          {language.t(`operator.capabilities.from.${origin()}`)}
        </Tag>
      )}
    </Show>
  )
}

// The state in words: "Inherited", "Overrides the namespace's", "Turned off here", "Defined here".
export function stateText(language: Language, item: OperatorCapability | undefined) {
  if (!item) return ""
  if (item.state === "disabled")
    return language.t(`operator.capabilities.off.${item.disabledAt?.origin ?? item.origin}`)
  if (item.state === "overridden")
    return language.t(`operator.capabilities.overrides.${item.hides.at(-1)?.origin ?? "opencode"}`)
  return language.t(`operator.capabilities.state.${item.state}`)
}

// The actions on one capability at the page's scope.
export function useCapabilityActions(directory: () => string | undefined, namespace: () => string | undefined) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const moveToTrash = useMoveToTrash()
  const [state, setState] = createStore({ busy: "" })
  const run = async (action: "override" | "disable" | "revert" | "takeOpenCode", item: OperatorCapability) => {
    setState("busy", `${item.kind}:${item.name}`)
    const body = {
      directory: directory(),
      kind: item.kind,
      name: item.name,
      ...(namespace() ? { namespace: namespace() } : {}),
    }
    const client = api.client().operator.capability
    const request =
      action === "override"
        ? client.override(body, { throwOnError: true })
        : action === "disable"
          ? client.disable(body, { throwOnError: true })
          : action === "takeOpenCode"
            ? client.takeOpenCode(body, { throwOnError: true })
            : client.revert(body, { throwOnError: true })
    await request
      .then(async () => {
        showToast({ title: language.t(`operator.capabilities.done.${action}`, { name: item.name }) })
        await queryClient.invalidateQueries({ queryKey: api.key() })
      })
      .catch((error: unknown) =>
        showToast({
          title: language.t("operator.capabilities.failed", { name: item.name }),
          description: requestError(error),
        }),
      )
      .finally(() => setState("busy", ""))
  }
  const remove = (item: OperatorCapability, done?: () => void) =>
    moveToTrash(item.name, () =>
      api
        .client()
        .operator.capability.remove(
          {
            directory: directory(),
            kind: item.kind,
            name: item.name,
            ...(namespace() ? { namespace: namespace() } : {}),
          },
          { throwOnError: true },
        )
        .then(async () => {
          showToast({ title: language.t("operator.trash.moved", { name: item.name }) })
          done?.()
          await queryClient.invalidateQueries({ queryKey: api.key() })
        })
        .catch((error: unknown) =>
          showToast({ title: language.t("operator.trash.failed"), description: requestError(error) }),
        ),
    )
  // A namespace's capability copied into another namespace.
  const copy = async (item: OperatorCapability, to: string, toName: string) => {
    setState("busy", `${item.kind}:${item.name}`)
    await api
      .client()
      .operator.capability.copy(
        { directory: directory(), kind: item.kind, name: item.name, namespace: namespace()!, to },
        { throwOnError: true },
      )
      .then(async () => {
        showToast({ title: language.t("operator.capabilities.done.copy", { name: item.name, namespace: toName }) })
        await queryClient.invalidateQueries({ queryKey: api.key() })
      })
      .catch((error: unknown) =>
        showToast({
          title: language.t("operator.capabilities.failed", { name: item.name }),
          description: requestError(error),
        }),
      )
      .finally(() => setState("busy", ""))
  }
  return { run, remove, copy, busy: (item: OperatorCapability) => state.busy === `${item.kind}:${item.name}` }
}

// Edits a definition the scope owns: its file, or its config entry as JSON (a dialog).
function EditDialog(props: {
  item: OperatorCapability
  directory: () => string | undefined
  namespace: () => string | undefined
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const [store, setStore] = createStore({ location: "", text: "", loaded: false, busy: false, error: "" })
  const where = () => ({
    directory: props.directory(),
    kind: props.item.kind,
    name: props.item.name,
    ...(props.namespace() ? { namespace: props.namespace() } : {}),
  })
  onMount(() => {
    void api
      .client()
      .operator.capability.source(where(), { throwOnError: true })
      .then((result) => setStore({ location: result.data.location, text: result.data.text, loaded: true }))
      .catch((error: unknown) => setStore({ error: requestError(error), loaded: true }))
  })
  const save = async () => {
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.capability.edit({ ...where(), text: store.text }, { throwOnError: true })
      .then(async () => {
        showToast({ title: language.t("operator.capabilities.saved", { name: props.item.name }) })
        await queryClient.invalidateQueries({ queryKey: api.key() })
        dialog.close()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{language.t("operator.capabilities.editTitle", { name: props.item.name })}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-2" data-component="operator-capability-edit">
          <p data-slot="operator-note">
            <code>{store.location}</code>
          </p>
          <TextareaV2
            class="operator-editor"
            rows={18}
            spellcheck={false}
            value={store.text}
            aria-label={language.t("operator.capabilities.editLabel")}
            onInput={(event) => setStore("text", event.currentTarget.value)}
          />
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.busy || !store.loaded} onClick={() => void save()}>
          {language.t("operator.config.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

// The buttons a capability gets at the page's scope.
export function CapabilityActions(props: {
  item: OperatorCapability | undefined
  view: View
  directory: () => string | undefined
  namespace: () => string | undefined
  onGone?: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const scope = useNamespaceScope()
  const actions = useCapabilityActions(props.directory, props.namespace)
  const here = () => (props.view === "namespace" ? "namespace" : "project")
  const others = () => scope.namespaces().filter((item) => item.namespace.id !== props.namespace())
  const reserved = (item: OperatorCapability) => item.kind === "command" && item.name === "merge"
  // Of OpenCode's built-ins only these can be copied; its tools (and its other agents) are code.
  const copyable = (item: OperatorCapability) => item.origin !== "opencode" || COPYABLE.has(`${item.kind}:${item.name}`)
  return (
    <Show when={props.item}>
      {(item) => (
        <>
          <Show when={item().origin !== here() && item().state !== "disabled" && !reserved(item()) && copyable(item())}>
            <ButtonV2
              variant="outline"
              disabled={actions.busy(item())}
              onClick={() => void actions.run("override", item())}
            >
              {language.t(`operator.capabilities.override.${props.view}`)}
            </ButtonV2>
          </Show>
          <Show when={item().origin !== here() && item().state !== "disabled" && !reserved(item())}>
            <ButtonV2
              variant="outline"
              disabled={actions.busy(item())}
              onClick={() => void actions.run("disable", item())}
            >
              {language.t(`operator.capabilities.disable.${props.view}`)}
            </ButtonV2>
          </Show>
          <Show
            when={
              item().state === "overridden" || (item().state === "disabled" && item().disabledAt?.origin === here())
            }
          >
            <ButtonV2
              variant="outline"
              disabled={actions.busy(item())}
              onClick={() => void actions.run("revert", item())}
            >
              {language.t("operator.capabilities.revert")}
            </ButtonV2>
          </Show>
          <Show when={item().origin === here() && item().basedOn?.changed}>
            <ButtonV2
              variant="outline"
              disabled={actions.busy(item())}
              onClick={() => void actions.run("takeOpenCode", item())}
            >
              {language.t("operator.capabilities.takeOpenCode")}
            </ButtonV2>
          </Show>
          <Show when={item().origin === here() && item().kind !== "plugin"}>
            <ButtonV2
              variant="outline"
              onClick={() =>
                void dialog.push(() => (
                  <EditDialog item={item()} directory={props.directory} namespace={props.namespace} />
                ))
              }
            >
              {language.t("operator.capabilities.edit")}
            </ButtonV2>
          </Show>
          <Show when={props.view === "namespace" && item().origin === "namespace" && others().length}>
            <MenuV2 gutter={6} modal={false} placement="bottom-end">
              <MenuV2.Trigger as={ButtonV2} variant="outline" disabled={actions.busy(item())}>
                {language.t("operator.capabilities.copyTo")}
              </MenuV2.Trigger>
              <MenuV2.Portal>
                <MenuV2.Content>
                  <MenuV2.Group>
                    <MenuV2.GroupLabel>{language.t("operator.capabilities.copyToLabel")}</MenuV2.GroupLabel>
                    <For each={others()}>
                      {(other) => (
                        <MenuV2.Item
                          onSelect={() => void actions.copy(item(), other.namespace.id, other.namespace.name)}
                        >
                          {other.namespace.name}
                        </MenuV2.Item>
                      )}
                    </For>
                  </MenuV2.Group>
                </MenuV2.Content>
              </MenuV2.Portal>
            </MenuV2>
          </Show>
          <Show when={item().origin === here() && item().state === "local"}>
            <ButtonV2 variant="danger" onClick={() => void actions.remove(item(), props.onGone)}>
              {language.t("operator.trash.delete")}
            </ButtonV2>
          </Show>
        </>
      )}
    </Show>
  )
}

const TOOL_TEMPLATE = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Describe what the tool does",
  args: {
    input: tool.schema.string().describe("What the tool needs"),
  },
  async execute(args) {
    return args.input
  },
})
`

const PLUGIN_TEMPLATE = `import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async () => {
  return {}
}
`

// New capability at the page's scope (a dialog). Agents use the agent form.
export function useCreateCapability(directory: () => string | undefined, namespace: () => string | undefined) {
  const dialog = useDialog()
  const navigate = useNavigate()
  return (kind: OperatorCapabilityKind) => {
    if (kind === "agent") {
      navigate(`/operator/agents/new?dir=${encodeURIComponent(directory() ?? "")}`)
      return
    }
    void dialog.show(() => <CreateDialog kind={kind} directory={directory} namespace={namespace} />)
  }
}

function CreateDialog(props: {
  kind: Exclude<OperatorCapabilityKind, "agent">
  directory: () => string | undefined
  namespace: () => string | undefined
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const id = createUniqueId()
  const [store, setStore] = createStore({
    name: "",
    description: "",
    text: props.kind === "tool" ? TOOL_TEMPLATE : props.kind === "plugin" ? PLUGIN_TEMPLATE : "",
    agent: "",
    model: "",
    subtask: false,
    mcpType: "local" as "local" | "remote",
    command: "",
    url: "",
    busy: false,
    error: "",
  })
  const agents = useQuery(() => ({
    queryKey: api.key("agents", props.directory()),
    enabled: props.kind === "command" && !!props.directory(),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: props.directory() })
        .then((result) => asList(result.data)),
  }))
  const create = async () => {
    setStore({ busy: true, error: "" })
    const mcp =
      props.kind === "mcp"
        ? store.mcpType === "local"
          ? { type: "local", command: store.command.trim().split(/\s+/).filter(Boolean) }
          : { type: "remote", url: store.url.trim() }
        : undefined
    await api
      .client()
      .operator.capability.create(
        {
          directory: props.directory(),
          operatorCapabilityCreate: {
            kind: props.kind,
            name: store.name.trim(),
            ...(props.namespace() ? { namespace: props.namespace() } : {}),
            ...(store.description.trim() ? { description: store.description.trim() } : {}),
            ...(props.kind === "mcp" ? { mcp } : { text: store.text }),
            ...(props.kind === "command"
              ? {
                  ...(store.agent ? { agent: store.agent } : {}),
                  ...(store.model.trim() ? { model: store.model.trim() } : {}),
                  ...(store.subtask ? { subtask: true } : {}),
                }
              : {}),
          },
        },
        { throwOnError: true },
      )
      .then(async () => {
        showToast({ title: language.t("operator.capabilities.created", { name: store.name.trim() }) })
        await queryClient.invalidateQueries({ queryKey: api.key() })
        dialog.close()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  const field = (key: string, label: string, help: string, input: () => JSX.Element) => (
    <div class="flex flex-col gap-1">
      <div class="flex items-center">
        <label class="text-12-medium" for={`${id}-${key}`}>
          {label}
        </label>
        <FieldHelp field={label} text={help} />
      </div>
      {input()}
    </div>
  )
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>
          {language.t(`operator.capabilities.new.${props.kind}`)}
          {" · "}
          {props.namespace()
            ? language.t("operator.capabilities.inNamespace", { name: props.namespace()! })
            : language.t("operator.capabilities.inProject")}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-3" data-component="operator-capability-create">
          {field("name", language.t("operator.column.name"), language.t("operator.help.capabilityName"), () => (
            <TextInputV2
              id={`${id}-name`}
              appearance="base"
              value={store.name}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          ))}
          <Show when={props.kind === "command" || props.kind === "skill"}>
            {field(
              "description",
              language.t("operator.column.description"),
              language.t("operator.help.capabilityDescription"),
              () => (
                <TextInputV2
                  id={`${id}-description`}
                  appearance="base"
                  value={store.description}
                  onInput={(event) => setStore("description", event.currentTarget.value)}
                />
              ),
            )}
          </Show>
          <Show when={props.kind === "command"}>
            {field("agent", language.t("operator.column.agent"), language.t("operator.help.commandAgent"), () => (
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.column.agent")}
                options={["", ...(ready(agents) ?? []).map((agent) => agent.name)]}
                current={store.agent}
                label={(name) => name || language.t("operator.capabilities.currentAgent")}
                onSelect={(name) => setStore("agent", name ?? "")}
              />
            ))}
            {field("model", language.t("operator.column.model"), language.t("operator.help.commandModel"), () => (
              <TextInputV2
                id={`${id}-model`}
                appearance="base"
                placeholder="provider/model"
                value={store.model}
                onInput={(event) => setStore("model", event.currentTarget.value)}
              />
            ))}
            <CheckboxV2
              label={language.t("operator.capabilities.subtask")}
              checked={store.subtask}
              onChange={(checked: boolean) => setStore("subtask", checked)}
            />
          </Show>
          <Show when={props.kind === "mcp"}>
            <SegmentedControlV2
              aria-label={language.t("operator.capabilities.mcpType")}
              value={store.mcpType}
              onChange={(value) => {
                if (value === "local" || value === "remote") setStore("mcpType", value)
              }}
            >
              <SegmentedControlItemV2 value="local">
                {language.t("operator.capabilities.mcpLocal")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="remote">
                {language.t("operator.capabilities.mcpRemote")}
              </SegmentedControlItemV2>
            </SegmentedControlV2>
            <Show
              when={store.mcpType === "local"}
              fallback={field(
                "url",
                language.t("operator.capabilities.mcpUrl"),
                language.t("operator.help.mcpUrl"),
                () => (
                  <TextInputV2
                    id={`${id}-url`}
                    appearance="base"
                    placeholder="https://"
                    value={store.url}
                    onInput={(event) => setStore("url", event.currentTarget.value)}
                  />
                ),
              )}
            >
              {field(
                "command",
                language.t("operator.capabilities.mcpCommand"),
                language.t("operator.help.mcpCommand"),
                () => (
                  <TextInputV2
                    id={`${id}-command`}
                    appearance="base"
                    placeholder="npx -y @modelcontextprotocol/server-everything"
                    value={store.command}
                    onInput={(event) => setStore("command", event.currentTarget.value)}
                  />
                ),
              )}
            </Show>
          </Show>
          <Show when={props.kind !== "mcp"}>
            <Show when={props.kind === "plugin"}>
              <p data-slot="operator-note" data-warning="">
                {language.t("operator.capabilities.pluginWarning")}
              </p>
            </Show>
            {field(
              "text",
              language.t(`operator.capabilities.text.${props.kind}`),
              language.t(`operator.help.capabilityText.${props.kind}`),
              () => (
                <TextareaV2
                  id={`${id}-text`}
                  class="operator-editor"
                  rows={props.kind === "tool" || props.kind === "plugin" ? 14 : 8}
                  spellcheck={false}
                  value={store.text}
                  onInput={(event) => setStore("text", event.currentTarget.value)}
                />
              ),
            )}
          </Show>
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.busy || !store.name.trim()} onClick={() => void create()}>
          {language.t("operator.capabilities.create")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
