import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useConfirm } from "../ui/confirm"
import { Field } from "../ui/field"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { requestError } from "./config-helpers"

export type PromptText = {
  id: string
  kind: "base" | "reminder" | "notice" | "generator" | "tool"
  builtin: string
  global?: string
  project?: string
}

// The text a prompt has where `scope` is being edited: that scope's override, else what it inherits.
export function effectiveText(entry: PromptText, scope: Scope) {
  if (scope === "project") return entry.project ?? entry.global ?? entry.builtin
  return entry.global ?? entry.builtin
}

export function usePromptCatalog(directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("prompt-catalog", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.prompt.catalog({ directory: directory() })
        .then((result) => result.data!),
  }))
}

// Every text OpenCode adds on its own (or every tool description), each with an editor for its
// global and project overrides. An empty override turns the text off.
export function PromptTexts(props: {
  directory: string
  tools?: boolean
  selected?: string
  onSelect: (id: string) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const catalog = usePromptCatalog(() => props.directory)
  const [store, setStore] = createStore({ scope: "project" as Scope, text: "", filter: "", error: "", busy: false })

  const entries = createMemo<PromptText[]>(() => {
    const data = catalog.data
    if (!data) return []
    if (!props.tools) return data.prompts.map((item) => ({ ...item }))
    return data.tools.map((tool) => ({ ...tool, id: `tool.${tool.id}`, kind: "tool" as const }))
  })
  const visible = createMemo(() => {
    const filter = store.filter.trim().toLowerCase()
    return filter ? entries().filter((item) => item.id.toLowerCase().includes(filter)) : entries()
  })
  const groups = createMemo(() =>
    ["base", "reminder", "notice", "generator", "tool"]
      .map((kind) => ({ kind, items: visible().filter((item) => item.kind === kind) }))
      .filter((group) => group.items.length > 0),
  )
  const entry = createMemo(() => entries().find((item) => item.id === props.selected))
  const override = () => {
    const current = entry()
    return current ? current[store.scope] : undefined
  }

  // Load the text for the chosen prompt and scope; unsaved edits are replaced.
  createEffect(
    on([() => entry()?.id, () => store.scope, () => entry()?.global, () => entry()?.project], () => {
      const current = entry()
      setStore({ text: current ? effectiveText(current, store.scope) : "", error: "" })
    }),
  )

  const describe = (item: PromptText) =>
    item.kind === "tool"
      ? (item.builtin.split("\n")[0] ?? "")
      : language.t(`operator.prompts.id.${item.id}` as Parameters<typeof language.t>[0])

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: api.key("prompt-catalog", props.directory) }),
      queryClient.invalidateQueries({ queryKey: api.key("prompt-preview", props.directory) }),
    ])

  const write = async (text: string) => {
    const current = entry()
    if (!current) return
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.prompt.write({ id: current.id, directory: props.directory, scope: store.scope, text })
      .then(async () => {
        showToast({ title: language.t("operator.prompts.saved", { id: current.id }) })
        await refresh()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  const reset = async () => {
    const current = entry()
    if (!current) return
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.prompt.remove({ id: current.id, directory: props.directory, scope: store.scope })
      .then(refresh)
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  const turnOff = async () => {
    const current = entry()
    if (!current) return
    const ok = await confirm({
      title: language.t("operator.prompts.offTitle", { id: current.id }),
      description: language.t("operator.prompts.offBody"),
      confirm: language.t("operator.prompts.off"),
      danger: true,
    })
    if (ok) await write("")
  }

  const state = (item: PromptText) => {
    const value = item.project ?? item.global
    if (value === undefined) return undefined
    return value === "" ? "off" : item.project !== undefined ? "project" : "global"
  }

  return (
    <div data-slot="operator-columns">
      <section data-component="operator-panel">
        <Show when={props.tools}>
          <div data-slot="operator-toolbar">
            <TextInputV2
              type="search"
              appearance="base"
              value={store.filter}
              placeholder={language.t("operator.capabilities.search")}
              aria-label={language.t("operator.capabilities.search")}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
            />
          </div>
        </Show>
        <For each={groups()}>
          {(group) => (
            <>
              <h2 data-slot="operator-panel-title">
                {language.t(`operator.prompts.kind.${group.kind}` as Parameters<typeof language.t>[0])}
              </h2>
              <ul data-component="operator-layers">
                <For each={group.items}>
                  {(item) => (
                    <li data-slot="operator-layer" data-selected={props.selected === item.id ? "" : undefined}>
                      <button type="button" data-slot="operator-layer-open" onClick={() => props.onSelect(item.id)}>
                        <span class="flex flex-col min-w-0">
                          <code>{item.id}</code>
                          <span data-slot="operator-cell-clamp">{describe(item)}</span>
                        </span>
                        <Show when={state(item)}>
                          {(value) => (
                            <Tag variant={value() === "off" ? "neutral" : "accent"}>
                              {language.t(`operator.prompts.state.${value()}`)}
                            </Tag>
                          )}
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </>
          )}
        </For>
      </section>

      <section data-component="operator-panel">
        <Show when={entry()} fallback={<p data-slot="operator-note">{language.t("operator.prompts.pick")}</p>}>
          {(current) => (
            <>
              <h2 data-slot="operator-panel-title">
                <code>{current().id}</code>
              </h2>
              <p data-slot="operator-note">{describe(current())}</p>
              <div data-component="operator-form">
                <Field group label={language.t("operator.agentForm.scope")}>
                  <ScopeSwitch value={store.scope} onChange={(scope) => setStore("scope", scope)} />
                </Field>
                <Field
                  label={language.t("operator.prompts.text")}
                  hint={
                    override() === undefined
                      ? language.t("operator.prompts.inherited")
                      : override() === ""
                        ? language.t("operator.prompts.isOff")
                        : language.t("operator.prompts.overridden")
                  }
                >
                  <TextareaV2
                    class="operator-editor"
                    rows={16}
                    value={store.text}
                    placeholder={current().id === "base" ? language.t("operator.prompts.basePlaceholder") : undefined}
                    onInput={(event) => setStore("text", event.currentTarget.value)}
                  />
                </Field>
              </div>
              <Show when={store.error}>
                <pre data-slot="operator-error" role="alert">
                  {store.error}
                </pre>
              </Show>
              <div data-slot="operator-actions">
                <ButtonV2
                  variant="neutral"
                  disabled={store.busy || override() === undefined}
                  onClick={() => void reset()}
                >
                  {language.t("operator.prompts.reset")}
                </ButtonV2>
                <ButtonV2 variant="danger" disabled={store.busy || override() === ""} onClick={() => void turnOff()}>
                  {language.t("operator.prompts.off")}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  disabled={store.busy || !store.text.trim() || store.text === effectiveText(current(), store.scope)}
                  onClick={() => void write(store.text)}
                >
                  {language.t("operator.config.save")}
                </ButtonV2>
              </div>
              <Show when={current().builtin}>
                <details data-slot="operator-details">
                  <summary>{language.t("operator.prompts.builtin")}</summary>
                  <pre data-component="operator-code">{current().builtin}</pre>
                </details>
              </Show>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}
