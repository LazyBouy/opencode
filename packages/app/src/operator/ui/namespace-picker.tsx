import { useSearchParams } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { SelectV2 } from "./select"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { createEffect, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useNamespaces } from "../pages/profile-data"
import { ALL } from "../pages/profile-model"
import { FieldHelp } from "./field-help"

// The namespace scope pages share (Projects, Prompt Profile): all namespaces, or one. It is the
// viewer's choice, kept in this browser and in the URL (?ns=), until they change it.
export { ALL }
const KEY = "opencode.namespaceScope"

function stored() {
  try {
    return localStorage.getItem(KEY) ?? ALL
  } catch {
    return ALL
  }
}

const [chosen, setChosen] = createSignal(stored())

function remember(ns: string) {
  setChosen(ns)
  try {
    localStorage.setItem(KEY, ns)
  } catch {
    // The choice still holds until the page reloads.
  }
}

export function useNamespaceScope() {
  const namespaces = useNamespaces()
  const [params, setParams] = useSearchParams<{ ns?: string }>()
  // A link that names a namespace (?ns=) becomes the choice.
  createEffect(() => {
    if (params.ns && params.ns !== chosen()) remember(params.ns)
  })
  // A namespace that no longer exists falls back to all of them.
  const ns = () => {
    const current = params.ns ?? chosen()
    if (current === ALL || !namespaces.data) return current
    return namespaces.data.some((item) => item.namespace.id === current) ? current : ALL
  }
  return {
    ns,
    all: () => ns() === ALL,
    namespaces: (): ReadonlyArray<OperatorNamespaceSummary> => namespaces.data ?? [],
    // The namespaces in scope: all of them, or the chosen one.
    scoped: (): ReadonlyArray<OperatorNamespaceSummary> =>
      (namespaces.data ?? []).filter((item) => ns() === ALL || item.namespace.id === ns()),
    name: (id: string) => namespaces.data?.find((item) => item.namespace.id === id)?.namespace.name ?? id,
    set: (next: string) => {
      remember(next)
      setParams({ ns: next })
    },
  }
}

// The namespace selector at the top right of a page. `all: false` for a page that shows one namespace
// (it then shows `current`, the page's choice when all namespaces are in scope).
export function NamespacePicker(props: { onChange?: (ns: string) => void; all?: boolean; current?: string }) {
  const language = useLanguage()
  const scope = useNamespaceScope()
  const options = () => [...(props.all === false ? [] : [ALL]), ...scope.namespaces().map((item) => item.namespace.id)]
  return (
    <span class="inline-flex items-center">
      <SelectV2<string>
        appearance="base"
        aria-label={language.t("operator.profile.namespace")}
        options={options()}
        current={props.current ?? scope.ns()}
        label={(id) => (id === ALL ? language.t("operator.namespace.all") : scope.name(id))}
        onSelect={(id) => {
          if (!id) return
          scope.set(id)
          props.onChange?.(id)
        }}
      />
      <FieldHelp field={language.t("operator.profile.namespace")} text={language.t("operator.help.namespacePicker")} />
    </span>
  )
}

// An action that needs a namespace (New, Make editable copy, Duplicate, …): a button when the page
// shows one namespace, a menu of the namespaces when it shows all of them.
export function NamespaceAction(props: {
  label: string
  ns: string | undefined
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  variant?: "neutral" | "outline" | "contrast"
  size?: "small" | "normal"
  disabled?: boolean
  run: (ns: string) => void
}) {
  const language = useLanguage()
  return (
    <Show
      when={!props.ns}
      fallback={
        <ButtonV2
          size={props.size}
          variant={props.variant ?? "outline"}
          disabled={props.disabled}
          onClick={() => props.run(props.ns!)}
        >
          {props.label}
        </ButtonV2>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="bottom-end">
        <MenuV2.Trigger as={ButtonV2} size={props.size} variant={props.variant ?? "outline"} disabled={props.disabled}>
          {props.label}
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("operator.namespace.in")}</MenuV2.GroupLabel>
              <For each={props.namespaces}>
                {(item) => (
                  <MenuV2.Item onSelect={() => props.run(item.namespace.id)}>{item.namespace.name}</MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
