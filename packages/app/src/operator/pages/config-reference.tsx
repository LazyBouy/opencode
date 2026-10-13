import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import type { OperatorConfigOption } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { DetailOverlay } from "../ui/detail-overlay"
import { FieldHelp } from "../ui/field-help"
import { ListSearch, Pager } from "../ui/list-controls"
import { LONG, pageOf } from "../ui/paged"
import type { ConfigSource } from "./config-effective"
import { maskSecrets } from "./config-helpers"
import { type Filter, groupsOf, setIn, shortValue } from "./config-reference-model"

// The Config reference (specs/docs/issues/003): every option OpenCode's config accepts, from the server's config
// schema (GET /operator/config/reference), under a Config page's effective settings: the project's, a namespace's
// and Global's. Closed until opened (remembered); Full screen opens it in an overlay. Searched by path and
// description, grouped by top-level key (10 options a page), with All options / Set in this config. An option set
// in the effective config shows its value (secrets masked) and the level its top-level key comes from.

type Props = {
  /** The effective config. */
  config: unknown
  origins: Record<string, string>
  variables?: Record<string, string>
  label: (source: Pick<ConfigSource, "kind" | "path" | "variable">) => string
  /** Inside Settings, under the section's own heading. */
  nested?: boolean
}

export function ConfigReference(props: Props) {
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = persisted(Persist.global("operator.configReference"), createStore({ open: false }))
  const title = () => language.t("operator.configReference.title")
  const fullScreen = () => {
    const open = dialog.active ? dialog.push : dialog.show
    void open(() => (
      <DetailOverlay
        title={title()}
        sections={[{ id: "reference", label: title(), icon: "sliders" }]}
        section="reference"
        records={[]}
        record=""
        onSection={() => undefined}
        onRecord={() => undefined}
      >
        <ReferenceBody {...props} overlay />
      </DetailOverlay>
    ))
  }
  return (
    <section data-component="operator-panel" data-testid="config-reference">
      <div data-slot="operator-panel-head">
        <Dynamic component={props.nested ? "h4" : "h2"} data-slot="operator-panel-title" class="flex items-center">
          <button
            type="button"
            data-slot="operator-disclosure"
            aria-expanded={store.open}
            onClick={() => setStore("open", !store.open)}
          >
            <Icon name={store.open ? "chevron-down" : "chevron-right"} size="small" />
            {title()}
          </button>
          <FieldHelp field={title()} text={language.t("operator.help.configReference")} />
        </Dynamic>
        <ButtonV2 size="small" variant="neutral" data-action="config-reference-full" onClick={fullScreen}>
          <Icon name="expand" size="small" />
          {language.t("operator.configReference.fullScreen")}
        </ButtonV2>
      </div>
      <Show when={store.open}>
        <ReferenceBody {...props} />
      </Show>
    </section>
  )
}

function ReferenceBody(props: Props & { overlay?: boolean }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const reference = useQuery(() => ({
    queryKey: api.key("config-reference"),
    staleTime: Infinity,
    queryFn: () =>
      api
        .client()
        .operator.config.reference({ throwOnError: true })
        .then((result) => result.data!),
  }))
  const [store, setStore] = createStore({
    query: "",
    filter: "all" as Filter,
    // A group's open state and page, until the search changes.
    open: {} as Record<string, boolean>,
    pages: {} as Record<string, number>,
  })
  const config = createMemo(() => maskSecrets(props.config ?? {}))
  const options = () => ready(reference) ?? []
  const groups = createMemo(() => groupsOf(options(), { query: store.query, filter: store.filter, config: config() }))
  const shown = () => groups().reduce((count, group) => count + group.options.length, 0)
  // Searching opens every group with a match.
  const isOpen = (key: string) => store.open[key] ?? !!store.query.trim()
  const search = (query: string) => setStore({ query, open: {}, pages: {} })

  return (
    <div class="flex flex-col gap-3" data-testid="config-reference-body">
      <div class="flex flex-wrap items-center gap-2">
        <ListSearch label={language.t("operator.configReference.search")} query={store.query} onQuery={search} />
        <SegmentedControlV2
          aria-label={language.t("operator.configReference.filter")}
          value={store.filter}
          onChange={(value) => value && setStore({ filter: value as Filter, open: {}, pages: {} })}
        >
          <SegmentedControlItemV2 value="all">{language.t("operator.configReference.all")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="set">{language.t("operator.configReference.set")}</SegmentedControlItemV2>
        </SegmentedControlV2>
        <span data-slot="operator-note" data-testid="config-reference-count">
          {language.t("operator.configReference.count", { count: shown(), total: options().length })}
        </span>
      </div>
      <Show when={reference.isSuccess} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
        <Show
          when={groups().length}
          fallback={<p data-slot="operator-panel-empty">{language.t("operator.configReference.none")}</p>}
        >
          <ul data-component="operator-config-groups">
            <For each={groups()}>
              {(group) => {
                const page = () =>
                  pageOf(group.options, {
                    text: (item) => item.path,
                    sorted: false,
                    page: store.pages[group.key] ?? 0,
                    size: LONG,
                  })
                return (
                  <li data-testid="config-reference-group" data-group={group.key}>
                    <button
                      type="button"
                      data-slot="operator-disclosure"
                      aria-expanded={isOpen(group.key)}
                      onClick={() => setStore("open", group.key, !isOpen(group.key))}
                    >
                      <Icon name={isOpen(group.key) ? "chevron-down" : "chevron-right"} size="small" />
                      <code>{group.key}</code>
                      <span data-slot="operator-note">
                        {language.t("operator.configReference.groupCount", { count: group.options.length })}
                      </span>
                    </button>
                    <Show when={group.head}>{(head) => <p data-slot="operator-note">{head().description}</p>}</Show>
                    <Show when={isOpen(group.key)}>
                      <ul data-component="operator-config-options">
                        <For each={page().items}>
                          {(option) => <OptionView option={option} {...props} config={config()} />}
                        </For>
                      </ul>
                      <Pager page={page()} onPage={(at) => setStore("pages", group.key, at)} />
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

function OptionView(props: Props & { option: OperatorConfigOption; overlay?: boolean }) {
  const language = useLanguage()
  const found = createMemo(() => setIn(props.config, props.option.path))
  const kind = () => props.origins[props.option.group]
  const level = () =>
    kind() ? props.label({ kind: kind()!, path: "", variable: props.variables?.[props.option.group] }) : undefined
  const copy = () =>
    void navigator.clipboard
      .writeText(props.option.example)
      .then(() =>
        showToast({ variant: "success", icon: "circle-check", title: language.t("operator.configReference.copied") }),
      )
      .catch(() => showToast({ title: language.t("operator.toolPrompt.copyFailed") }))
  // The level links to the Effective settings above it (not in the overlay, which covers them).
  const toEffective = (event: MouseEvent) =>
    (event.currentTarget as HTMLElement)
      .closest('[data-component="operator-config-editor"], [data-testid="namespace-config"]')
      ?.querySelector('[data-testid="config-effective"]')
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  return (
    <li data-component="operator-config-option" data-testid="config-option" data-path={props.option.path}>
      <div data-slot="operator-config-option-head">
        <code data-slot="operator-config-option-path">{props.option.path}</code>
        <Tag>{props.option.type}</Tag>
        <Show when={props.option.deprecated}>
          <Tag>{language.t("operator.configReference.deprecated")}</Tag>
        </Show>
        <Show when={props.option.fork}>
          <span title={language.t("operator.configReference.forkHint")}>
            <Tag variant="accent">{language.t("operator.configReference.fork")}</Tag>
          </span>
        </Show>
      </div>
      <p class="text-12-regular">{props.option.description}</p>
      <dl data-component="record-fields">
        <Show when={props.option.values}>
          {(values) => (
            <>
              <dt>{language.t("operator.configReference.values")}</dt>
              <dd>
                <code>{values().join(" | ")}</code>
              </dd>
            </>
          )}
        </Show>
        <dt>{language.t("operator.configReference.default")}</dt>
        <dd>
          <Show when={props.option.default} fallback={language.t("operator.configReference.noDefault")}>
            {(value) => <code>{value()}</code>}
          </Show>
        </dd>
        <Show when={found().length}>
          <dt>{language.t("operator.configReference.inThisConfig")}</dt>
          <dd data-testid="config-option-set" class="flex flex-col gap-1">
            <For each={found().slice(0, 5)}>
              {(item) => (
                <span>
                  <code>{item.path}</code> = <code>{shortValue(item.value)}</code>
                </span>
              )}
            </For>
            <Show when={found().length > 5}>
              <span data-slot="operator-note">
                {language.t("operator.configReference.more", { count: found().length - 5 })}
              </span>
            </Show>
            <Show when={level()}>
              {(text) => (
                <span>
                  <Show when={!props.overlay} fallback={<Tag>{text()}</Tag>}>
                    <button
                      type="button"
                      data-slot="operator-link"
                      title={language.t("operator.configReference.toEffective")}
                      onClick={toEffective}
                    >
                      {text()}
                    </button>
                  </Show>
                </span>
              )}
            </Show>
          </dd>
        </Show>
        <Show when={props.option.docs}>
          {(docs) => (
            <>
              <dt>{language.t("operator.configReference.docs")}</dt>
              <dd>
                <a href={docs()} target="_blank" rel="noreferrer">
                  {docs()}
                </a>
              </dd>
            </>
          )}
        </Show>
      </dl>
      <details data-slot="operator-config-option-example">
        <summary class="text-12-medium">{language.t("operator.configReference.example")}</summary>
        <pre data-component="operator-code">{props.option.example}</pre>
      </details>
      <div data-slot="operator-actions">
        <ButtonV2 size="small" variant="ghost" onClick={copy}>
          <Icon name="copy" size="small" />
          {language.t("operator.configReference.copy")}
        </ButtonV2>
      </div>
    </li>
  )
}
