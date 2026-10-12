import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "../ui/select"
import type { OperatorCapability, OperatorCapabilityKind, OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { FieldHelp } from "../ui/field-help"
import { COPYABLE } from "../pages/capability-scope"

// A new namespace's Capabilities step (capability_scopes_spec.md §7): the namespace to copy from
// (OpenCode by default: its layer and its built-ins; or Start empty), a checklist of what it has by
// kind and its config keys, everything ticked, and a summary. The record creates the namespace, then
// copies the ticked ones into its folder's .opencode.

export type Start = {
  from: string | undefined
  items: Array<{ kind: OperatorCapabilityKind; name: string }>
  config: string[]
}

const EMPTY = "@empty"

const KINDS: OperatorCapabilityKind[] = ["command", "skill", "tool", "mcp", "agent", "plugin"]
const LABEL: Record<OperatorCapabilityKind, string> = {
  command: "operator.capabilities.commandsLabel",
  skill: "operator.capabilities.skillsLabel",
  tool: "operator.capabilities.toolsLabel",
  mcp: "operator.capabilities.mcpLabel",
  agent: "operator.capabilities.agentsLabel",
  plugin: "operator.capabilities.pluginsLabel",
}
const keyOf = (item: { kind: string; name: string }) => `${item.kind}:${item.name}`

export function NamespaceStart(props: {
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  folder: string
  onChange: (start: Start) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [source, setSource] = createSignal("opencode")
  const inventory = useQuery(() => ({
    queryKey: api.key("capability-start", source()),
    enabled: source() !== EMPTY,
    queryFn: () =>
      api
        .client()
        .operator.capability.list({ namespace: source() })
        .then((result) => result.data!),
  }))
  // The source's own items, and OpenCode's copyable built-ins when the source is OpenCode.
  const offered = createMemo<OperatorCapability[]>(() =>
    source() === EMPTY
      ? []
      : (ready(inventory)?.items ?? []).filter(
          (item) => item.origin === "namespace" || (source() === "opencode" && COPYABLE.has(keyOf(item))),
        ),
  )
  const keys = createMemo(() => (source() === EMPTY ? [] : (ready(inventory)?.config ?? [])))
  const [ticked, setTicked] = createStore<Record<string, boolean>>({})
  // Everything is ticked when the list (or the source) changes.
  createEffect(
    on([offered, keys], ([list, config]) =>
      setTicked(
        reconcile(
          Object.fromEntries([
            ...list.map((item) => [keyOf(item), true] as const),
            ...config.map((key) => [`config:${key}`, true] as const),
          ]),
        ),
      ),
    ),
  )
  const start = createMemo<Start>(() => ({
    from: source() === EMPTY ? undefined : source(),
    items: offered()
      .filter((item) => ticked[keyOf(item)])
      .map((item) => ({ kind: item.kind, name: item.name })),
    config: keys().filter((key) => ticked[`config:${key}`]),
  }))
  createEffect(() => props.onChange(start()))
  const count = () => start().items.length + start().config.length

  return (
    <div class="flex flex-col gap-2" data-component="operator-namespace-start">
      <div class="flex items-center">
        <span class="text-12-medium">{language.t("settings.namespaces.start")}</span>
        <FieldHelp field={language.t("settings.namespaces.start")} text={language.t("settings.namespaces.startHint")} />
      </div>
      <SelectV2<string>
        appearance="base"
        aria-label={language.t("settings.namespaces.startFrom")}
        options={[...props.namespaces.map((item) => item.namespace.id), EMPTY]}
        current={source()}
        label={(id) =>
          id === EMPTY
            ? language.t("settings.namespaces.startEmpty")
            : id === "opencode"
              ? language.t("settings.namespaces.startOpenCode")
              : (props.namespaces.find((item) => item.namespace.id === id)?.namespace.name ?? id)
        }
        onSelect={(id) => id && setSource(id)}
      />
      <Show when={source() !== EMPTY}>
        <Show
          when={offered().length || keys().length}
          fallback={<p data-slot="operator-note">{language.t("settings.namespaces.startNothing")}</p>}
        >
          <div class="flex flex-col gap-2" data-testid="namespace-start-items">
            <For each={KINDS.filter((kind) => offered().some((item) => item.kind === kind))}>
              {(kind) => (
                <fieldset class="flex flex-col gap-1">
                  <legend class="text-12-medium">
                    {language.t(LABEL[kind] as "operator.capabilities.commandsLabel")}
                  </legend>
                  <For each={offered().filter((item) => item.kind === kind)}>
                    {(item) => (
                      <CheckboxV2
                        label={kind === "command" ? `/${item.name}` : item.name}
                        checked={!!ticked[keyOf(item)]}
                        onChange={(checked: boolean) => setTicked(keyOf(item), checked)}
                      />
                    )}
                  </For>
                </fieldset>
              )}
            </For>
            <Show when={keys().length}>
              <fieldset class="flex flex-col gap-1">
                <legend class="text-12-medium">{language.t("settings.namespaces.startConfig")}</legend>
                <For each={keys()}>
                  {(key) => (
                    <CheckboxV2
                      label={key}
                      checked={!!ticked[`config:${key}`]}
                      onChange={(checked: boolean) => setTicked(`config:${key}`, checked)}
                    />
                  )}
                </For>
              </fieldset>
            </Show>
          </div>
        </Show>
      </Show>
      <p data-slot="operator-note" data-testid="namespace-start-summary">
        {count()
          ? language.t("settings.namespaces.startSummary", { count: count(), folder: props.folder || "…" })
          : language.t("settings.namespaces.startNone")}
      </p>
    </div>
  )
}
