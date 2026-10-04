import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorIdentityLayer } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { useAgents } from "./agents"
import { requestError } from "./config-helpers"

type Draft = {
  scope: Scope
  file?: string
  name: string
  kind: "org" | "user"
  agents: string
  maxLength: string
  enabled: boolean
  content: string
}

const blank = (): Draft => ({
  scope: "project",
  name: "",
  kind: "user",
  agents: "",
  maxLength: "",
  enabled: true,
  content: "",
})

// Identity layers: markdown files added at the top of every system prompt, in order.
export function IdentityLayers(props: { directory: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const directory = () => props.directory
  const agents = useAgents()
  const [store, setStore] = createStore({ draft: blank(), editing: false, error: "", preview: "build" })

  const layers = useQuery(() => ({
    queryKey: api.key("identity", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.identity.list({ directory: directory() })
        .then((result) => result.data ?? []),
  }))
  const preview = useQuery(() => ({
    queryKey: api.key("identity-preview", directory(), store.preview),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.identity.preview({ directory: directory(), agent: store.preview })
        .then((result) => result.data?.text ?? ""),
  }))
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: api.key("identity", directory()) })
    await queryClient.invalidateQueries({ queryKey: api.key("identity-preview", directory()) })
  }
  const fail = (error: unknown) => setStore("error", requestError(error))

  const edit = (layer: OperatorIdentityLayer) =>
    setStore({
      editing: true,
      error: "",
      draft: {
        scope: layer.scope,
        file: layer.file,
        name: layer.name,
        kind: layer.kind === "org" ? "org" : "user",
        agents: (layer.agents ?? []).join(", "),
        maxLength: layer.maxLength == null ? "" : String(layer.maxLength),
        enabled: layer.enabled,
        content: layer.content,
      },
    })

  const save = async () => {
    const draft = store.draft
    const agentsList = draft.agents
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    const current = layers.data?.find((item) => item.scope === draft.scope && item.file === draft.file)
    await api
      .client()
      .operator.identity.save({
        directory: directory(),
        scope: draft.scope,
        file: draft.file,
        name: draft.name.trim(),
        kind: draft.kind,
        priority: current?.priority,
        agents: agentsList,
        maxLength: draft.maxLength.trim() ? Number(draft.maxLength) : undefined,
        enabled: draft.enabled,
        content: draft.content,
      })
      .then(async (result) => {
        showToast({ title: language.t("operator.profile.saved", { name: draft.name }) })
        await refresh()
        if (result.data) edit(result.data)
      })
      .catch(fail)
  }

  const remove = async () => {
    const draft = store.draft
    if (!draft.file) return
    const ok = await confirm({
      title: language.t("operator.profile.deleteTitle", { name: draft.name }),
      description: language.t("operator.profile.deleteBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.identity.remove({ directory: directory(), scope: draft.scope, file: draft.file })
      .then(async () => {
        setStore({ draft: blank(), editing: false })
        await refresh()
      })
      .catch(fail)
  }

  // Moves a layer one place within its own scope; the new order becomes its priority.
  const move = async (layer: OperatorIdentityLayer, by: number) => {
    const files = (layers.data ?? []).filter((item) => item.scope === layer.scope).map((item) => item.file)
    const index = files.indexOf(layer.file)
    const target = index + by
    if (target < 0 || target >= files.length) return
    files.splice(index, 1)
    files.splice(target, 0, layer.file)
    await api
      .client()
      .operator.identity.reorder({ directory: directory(), scope: layer.scope, files })
      .then(refresh)
      .catch(fail)
  }

  const agentNames = createMemo(() => (agents.data ?? []).filter((agent) => !agent.disabled).map((agent) => agent.name))

  return (
    <>
      <div data-slot="operator-toolbar">
        <p data-slot="operator-note">{language.t("operator.profile.identityHint")}</p>
        <ButtonV2
          size="small"
          variant="contrast"
          onClick={() => setStore({ draft: blank(), editing: true, error: "" })}
        >
          {language.t("operator.profile.new")}
        </ButtonV2>
      </div>
      <div data-slot="operator-columns">
        <section data-component="operator-panel">
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.layers")}</h2>
          <p data-slot="operator-note">{language.t("operator.profile.layersHint")}</p>
          <Show
            when={(layers.data ?? []).length > 0}
            fallback={<p data-slot="operator-note">{language.t("operator.profile.empty")}</p>}
          >
            <ol data-component="operator-layers">
              <For each={layers.data ?? []}>
                {(layer) => (
                  <li
                    data-slot="operator-layer"
                    data-selected={
                      store.editing && store.draft.file === layer.file && store.draft.scope === layer.scope
                        ? ""
                        : undefined
                    }
                  >
                    <button type="button" data-slot="operator-layer-open" onClick={() => edit(layer)}>
                      <Tag variant={layer.kind === "project" ? "accent" : "neutral"}>
                        {language.t(`operator.profile.kind.${layer.kind}`)}
                      </Tag>
                      <span data-slot="operator-layer-name">{layer.name}</span>
                      <Show when={layer.agents}>
                        {(only) => <Tag>{language.t("operator.profile.only", { agents: only().join(", ") })}</Tag>}
                      </Show>
                      <Show when={!layer.enabled}>
                        <Tag>{language.t("operator.agent.off")}</Tag>
                      </Show>
                    </button>
                    <IconButtonV2
                      variant="ghost-muted"
                      size="small"
                      aria-label={language.t("operator.profile.up", { name: layer.name })}
                      icon={<Icon name="arrow-up" />}
                      onClick={() => void move(layer, -1)}
                    />
                    <IconButtonV2
                      variant="ghost-muted"
                      size="small"
                      aria-label={language.t("operator.profile.down", { name: layer.name })}
                      icon={<Icon name="chevron-down" />}
                      onClick={() => void move(layer, 1)}
                    />
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>

        <section data-component="operator-panel">
          <Show when={store.editing} fallback={<p data-slot="operator-note">{language.t("operator.profile.pick")}</p>}>
            <h2 data-slot="operator-panel-title">
              {store.draft.file ? language.t("operator.profile.edit") : language.t("operator.profile.new")}
            </h2>
            <div data-component="operator-form">
              <Show when={!store.draft.file}>
                <Field group label={language.t("operator.agentForm.scope")}>
                  <ScopeSwitch value={store.draft.scope} onChange={(scope) => setStore("draft", "scope", scope)} />
                </Field>
              </Show>
              <Field label={language.t("operator.agentForm.name")}>
                <TextInputV2
                  appearance="base"
                  value={store.draft.name}
                  onInput={(event) => setStore("draft", "name", event.currentTarget.value)}
                />
              </Field>
              <Show when={store.draft.scope === "global"}>
                <Field
                  group
                  label={language.t("operator.profile.kindLabel")}
                  hint={language.t("operator.profile.kindHint")}
                >
                  <SegmentedControlV2
                    value={store.draft.kind}
                    onChange={(value) => value && setStore("draft", "kind", value as Draft["kind"])}
                  >
                    <SegmentedControlItemV2 value="org">
                      {language.t("operator.profile.kind.org")}
                    </SegmentedControlItemV2>
                    <SegmentedControlItemV2 value="user">
                      {language.t("operator.profile.kind.user")}
                    </SegmentedControlItemV2>
                  </SegmentedControlV2>
                </Field>
              </Show>
              <Field label={language.t("operator.profile.agents")} hint={language.t("operator.profile.agentsHint")}>
                <TextInputV2
                  appearance="base"
                  value={store.draft.agents}
                  placeholder="build, plan"
                  onInput={(event) => setStore("draft", "agents", event.currentTarget.value)}
                />
              </Field>
              <div data-slot="operator-form-row">
                <Field
                  label={language.t("operator.profile.maxLength")}
                  hint={language.t("operator.profile.maxLengthHint")}
                >
                  <TextInputV2
                    appearance="base"
                    inputMode="numeric"
                    value={store.draft.maxLength}
                    onInput={(event) => setStore("draft", "maxLength", event.currentTarget.value)}
                  />
                </Field>
                <Field group label={language.t("operator.profile.enabled")}>
                  <Switch checked={store.draft.enabled} onChange={(checked) => setStore("draft", "enabled", checked)}>
                    {language.t("operator.profile.enabledHint")}
                  </Switch>
                </Field>
              </div>
              <Field
                label={language.t("operator.profile.content")}
                hint={language.t("operator.profile.contentHint", { count: store.draft.content.length })}
              >
                <TextareaV2
                  class="operator-editor"
                  rows={12}
                  value={store.draft.content}
                  onInput={(event) => setStore("draft", "content", event.currentTarget.value)}
                />
              </Field>
            </div>
            <Show when={store.error}>
              <pre data-slot="operator-error" role="alert">
                {store.error}
              </pre>
            </Show>
            <div data-slot="operator-actions">
              <Show when={store.draft.file}>
                <ButtonV2 variant="danger" onClick={() => void remove()}>
                  {language.t("operator.agent.delete")}
                </ButtonV2>
              </Show>
              <ButtonV2
                variant="contrast"
                disabled={!store.draft.name.trim() || !store.draft.content.trim()}
                onClick={() => void save()}
              >
                {language.t("operator.config.save")}
              </ButtonV2>
            </div>
          </Show>
        </section>
      </div>

      <section data-component="operator-panel">
        <div data-slot="operator-panel-head">
          <h2 data-slot="operator-panel-title">{language.t("operator.profile.preview")}</h2>
          <SelectV2<string>
            appearance="inline"
            aria-label={language.t("operator.column.agent")}
            options={agentNames()}
            current={store.preview}
            onSelect={(name) => name && setStore("preview", name)}
          />
        </div>
        <p data-slot="operator-note">{language.t("operator.profile.previewHint")}</p>
        <pre data-component="operator-code">{preview.data || language.t("operator.profile.previewEmpty")}</pre>
      </section>
    </>
  )
}
