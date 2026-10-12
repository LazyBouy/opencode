import { useFilteredList } from "@opencode-ai/ui/hooks"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorModelChain, OperatorNamespaceModels } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { type Component, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import "@/components/settings-v2/settings-v2.css"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { popularProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { FieldHelp } from "../ui/field-help"
import { Pager } from "../ui/list-controls"
import { type Direction, isLong, LONG, pageOf } from "../ui/paged"
import "./models.css"

// Settings → Models (default_models_spec.md §4): upstream's list of models, each shown or hidden in the chat's
// model picker, plus the server-wide defaults. Two fields name the default and the small default model (or
// what OpenCode decides now), each with Let OpenCode decide; every row gets a Default and a Small radio, one
// selection per column across providers, for shown models only (the user, 2026-10-11): a default can't be
// hidden until another is chosen. Both write Global's config, which namespaces and projects can override
// on Providers & Models. Upstream's tab (components/settings-v2/models.tsx) is left as it is; this list behaves
// the same (settings/models-list.test.ts keeps the two in step).

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]
type Key = "model" | "small_model"

const PROVIDER_ICON_SIZE = 16

/** The list's options, as upstream's tab has them: filter keys, order, groups by provider, popular first. */
export const listOptions = (items: () => ModelItem[]) => ({
  items: (_filter: string) => items(),
  key: (x: ModelItem) => `${x.provider.id}:${x.id}`,
  filterKeys: ["provider.name", "name", "id"],
  sortBy: (a: ModelItem, b: ModelItem) => a.name.localeCompare(b.name),
  groupBy: (x: ModelItem) => x.provider.id,
  sortGroupsBy: (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
    const aIndex = popularProviders.indexOf(a.category)
    const bIndex = popularProviders.indexOf(b.category)
    const aPopular = aIndex >= 0
    const bPopular = bIndex >= 0

    if (aPopular && !bPopular) return -1
    if (!aPopular && bPopular) return 1
    if (aPopular && bPopular) return aIndex - bIndex

    const aName = a.items[0].provider.name
    const bName = b.items[0].provider.name
    return aName.localeCompare(bName)
  },
})

/** provider/model → its parts (a model id may hold slashes: the provider is up to the first one). */
export const splitModel = (value: string) => {
  const at = value.indexOf("/")
  return { providerID: value.slice(0, at), modelID: value.slice(at + 1) }
}

/** Settings' chain of the default and small model (no namespace). */
export function useSettingsModels() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("model-defaults", "settings"),
    queryFn: () =>
      api
        .client()
        .operator.model.namespace({})
        .then((result) => result.data as OperatorNamespaceModels),
  }))
}

export const SettingsModelsOperator: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const serverSdk = useServerSDK()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const settings = useSettingsModels()
  const [store, setStore] = persisted(
    Persist.serverGlobal(serverSdk().scope, "settings-v2.models.providers"),
    createStore({ collapsed: {} as Record<string, boolean> }),
  )
  // The last change, with Undo. It's shown in the tab: a toast is outside the settings dialog, and clicking
  // it would close the dialog.
  const [last, setLast] = createSignal<{ key: Key; before: string | null; text: string }>()
  const list = useFilteredList<ModelItem>(listOptions(() => models.list()))
  // Each long provider group's order and page.
  const [paging, setPaging] = createStore<Record<string, { direction: Direction; page: number }>>({})

  const chainOf = (key: Key) => (key === "model" ? ready(settings)?.chain.model : ready(settings)?.chain.small)
  // What Settings itself sets (its first level), not what the environment may set after it.
  const setting = (key: Key) => {
    const link = chainOf(key)?.levels.find((item) => item.level === "settings")
    return link?.set ? link.model : undefined
  }
  const nameOf = (value: string) => {
    const found = models.find(splitModel(value))
    return found ? { name: found.name, provider: found.provider.name, providerID: found.provider.id } : undefined
  }
  const label = (value: string) => nameOf(value)?.name ?? value
  const fieldName = (key: Key) =>
    key === "model" ? language.t("operator.settingsModels.default") : language.t("operator.settingsModels.small")

  // Runs OpenCode's own logic again on the server for both fields (it reads the connected providers and the TUI's
  // recent models each time), and reads what Settings sets.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: api.key("model-defaults") }),
      queryClient.invalidateQueries({ queryKey: api.key("providers") }),
    ])

  const write = async (key: Key, model: string | null, undo = false) => {
    const before = setting(key) ?? null
    return (
      api
        .client()
        // null removes the key (the generated client types drop it)
        .operator.model.write({ level: "settings", key, model: model as string }, { throwOnError: true })
        .then(async () => {
          await queryClient.invalidateQueries({ queryKey: api.key() })
          if (undo) {
            setLast(undefined)
            return
          }
          const title = model
            ? language.t(key === "model" ? "operator.settingsModels.setDefault" : "operator.settingsModels.setSmall", {
                model: label(model),
              })
            : language.t("operator.settingsModels.cleared", { field: fieldName(key) })
          setLast({ key, before, text: title })
          showToast({ title })
        })
        .catch((error: unknown) =>
          showToast({ title: language.t("operator.settingsModels.failed"), description: requestError(error) }),
        )
    )
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
        <section class="operator-settings-defaults" data-testid="settings-model-defaults">
          <For each={["model", "small_model"] as Key[]}>
            {(key) => (
              <DefaultField
                key={key}
                label={fieldName(key)}
                chain={chainOf(key)}
                setting={setting(key)}
                name={nameOf}
                onClear={() => void write(key, null)}
              />
            )}
          </For>
          <p class="operator-settings-defaults-note">{language.t("operator.settingsModels.note")}</p>
          <span>
            <ButtonV2
              size="small"
              variant="outline"
              data-testid="settings-models-refresh"
              disabled={settings.isFetching}
              onClick={() => void refresh()}
            >
              {language.t("operator.settingsModels.refresh")}
            </ButtonV2>
          </span>
          <Show when={last()}>
            {(change) => (
              <p class="operator-settings-defaults-change" data-testid="settings-model-change" role="status">
                <span>{change().text}</span>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() => void write(change().key, change().before, true)}
                >
                  {language.t("operator.settingsModels.undo")}
                </ButtonV2>
              </p>
            )}
          </Show>
        </section>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={list.filter()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => list.clear()}
            />
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
        <Show
          when={!list.grouped.loading}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("dialog.model.empty")}</span>
                <Show when={list.filter()}>
                  <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                </Show>
              </div>
            }
          >
            <div class="operator-settings-model-columns" aria-hidden="true">
              <span class="operator-settings-model-cell">{language.t("operator.settingsModels.show")}</span>
              <span class="operator-settings-model-cell">{language.t("operator.settingsModels.defaultColumn")}</span>
              <span class="operator-settings-model-cell">{language.t("operator.settingsModels.smallColumn")}</span>
            </div>
            <For each={list.grouped.latest}>
              {(group) => {
                const searching = () => list.filter().length > 0
                const expanded = () => searching() || !store.collapsed[group.category]
                // A provider with more than 10 models (OpenRouter): A→Z / Z→A and pages of 10.
                const long = () => isLong(group.items.length)
                const paged = () =>
                  pageOf(group.items, {
                    text: (item) => item.name,
                    direction: paging[group.category]?.direction ?? "asc",
                    page: paging[group.category]?.page ?? 0,
                    size: LONG,
                  })
                const items = () => (long() ? paged().items : group.items)

                return (
                  <div
                    class="settings-v2-section"
                    data-component="settings-models-provider"
                    data-expanded={expanded() ? "" : undefined}
                  >
                    <h3 class="settings-v2-models-group-header">
                      <button
                        type="button"
                        class="settings-v2-models-group-trigger"
                        aria-expanded={expanded()}
                        disabled={searching()}
                        onClick={() => setStore("collapsed", group.category, expanded())}
                      >
                        <span class="settings-v2-models-group-chevron">
                          <Show
                            when={expanded()}
                            fallback={
                              <svg width="5" height="6" viewBox="0 0 5 6" fill="none" aria-hidden="true">
                                <path
                                  d="M0.75194 5.31663C0.41861 5.51103 0 5.27063 0 4.88473V0.500754C0 0.114854 0.41861 -0.125577 0.75194 0.0688635L4.5096 2.26084C4.8404 2.45378 4.8404 2.93168 4.5096 3.12462L0.75194 5.31663Z"
                                  fill="currentColor"
                                />
                              </svg>
                            }
                          >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M5.37624 6.75194C5.18184 6.41861 5.42224 6 5.80814 6H10.1921C10.578 6 10.8184 6.41861 10.624 6.75194L8.43203 10.5096C8.23909 10.8404 7.76119 10.8404 7.56825 10.5096L5.37624 6.75194Z"
                                fill="currentColor"
                              />
                            </svg>
                          </Show>
                        </span>
                        <span class="settings-v2-models-group-label">
                          <ProviderIcon
                            id={group.category}
                            width={PROVIDER_ICON_SIZE}
                            height={PROVIDER_ICON_SIZE}
                            class="settings-v2-models-provider-icon shrink-0"
                          />
                          <span class="settings-v2-section-title">{group.items[0].provider.name}</span>
                        </span>
                      </button>
                    </h3>
                    <Show when={expanded()}>
                      <Show when={long()}>
                        <div class="operator-settings-model-sort">
                          <ButtonV2
                            size="small"
                            variant="outline"
                            data-testid="list-sort"
                            onClick={() =>
                              setPaging(group.category, {
                                direction: paging[group.category]?.direction === "desc" ? "asc" : "desc",
                                page: 0,
                              })
                            }
                          >
                            {paging[group.category]?.direction === "desc"
                              ? language.t("operator.list.desc")
                              : language.t("operator.list.asc")}
                          </ButtonV2>
                        </div>
                      </Show>
                      <SettingsListV2>
                        <For each={items()}>
                          {(item) => {
                            const key = { providerID: item.provider.id, modelID: item.id }
                            const value = `${item.provider.id}/${item.id}`
                            // Only a shown model can be a default; a default can't be hidden until another is chosen.
                            const shown = () => models.visible(key)
                            const chosen = () => setting("model") === value || setting("small_model") === value
                            return (
                              <SettingsRowV2 title={item.name} description="">
                                <div class="operator-settings-model-controls" data-testid={`settings-model-${value}`}>
                                  <span
                                    class="operator-settings-model-cell"
                                    title={chosen() ? language.t("operator.settingsModels.keepShown") : undefined}
                                  >
                                    <Switch
                                      checked={models.visible(key)}
                                      disabled={chosen()}
                                      onChange={(checked) => {
                                        models.setVisibility(key, checked)
                                      }}
                                      hideLabel
                                    >
                                      {item.name}
                                    </Switch>
                                  </span>
                                  <span
                                    class="operator-settings-model-cell"
                                    title={shown() ? undefined : language.t("operator.settingsModels.showFirst")}
                                  >
                                    <input
                                      type="radio"
                                      class="operator-settings-model-radio"
                                      name="operator-default-model"
                                      disabled={!shown()}
                                      aria-label={language.t("operator.settingsModels.defaultFor", {
                                        model: item.name,
                                      })}
                                      checked={setting("model") === value}
                                      onChange={() => void write("model", value)}
                                    />
                                  </span>
                                  <span
                                    class="operator-settings-model-cell"
                                    title={shown() ? undefined : language.t("operator.settingsModels.showFirst")}
                                  >
                                    <input
                                      type="radio"
                                      class="operator-settings-model-radio"
                                      name="operator-small-model"
                                      disabled={!shown()}
                                      aria-label={language.t("operator.settingsModels.smallFor", { model: item.name })}
                                      checked={setting("small_model") === value}
                                      onChange={() => void write("small_model", value)}
                                    />
                                  </span>
                                </div>
                              </SettingsRowV2>
                            )
                          }}
                        </For>
                      </SettingsListV2>
                      <Show when={long()}>
                        <Pager
                          page={paged()}
                          onPage={(page) =>
                            setPaging(group.category, {
                              direction: paging[group.category]?.direction ?? "asc",
                              page,
                            })
                          }
                        />
                      </Show>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </>
  )
}

/** One server-wide default: the model in effect (Settings', else OpenCode's pick, tagged Auto); Let OpenCode decide; (i). */
function DefaultField(props: {
  key: Key
  label: string
  chain: OperatorModelChain | undefined
  setting: string | undefined
  name: (value: string) => { name: string; provider: string; providerID: string } | undefined
  onClear: () => void
}) {
  const language = useLanguage()
  const link = () => props.chain?.levels.find((item) => item.level === "settings")
  const effective = () => props.chain?.effective
  const environment = () => (effective()?.from === "environment" ? effective() : undefined)
  const shown = (value: string) => props.name(value)?.name ?? value
  const help = () => {
    const found = effective()
    if (!found) return undefined
    const text = props.setting
      ? language.t("operator.settingsModels.helpSet", { path: link()?.path ?? "" })
      : props.key === "model"
        ? language.t("operator.settingsModels.helpDecides", { model: shown(found.model) || "—" })
        : found.rule === "default-model"
          ? language.t("operator.settingsModels.helpDecidesSmallDefault", { model: shown(found.model) || "—" })
          : language.t("operator.settingsModels.helpDecidesSmall", { model: shown(found.model) || "—" })
    const env = environment()
    return env?.variable
      ? `${text} ${language.t("operator.settingsModels.helpEnvironment", { key: props.key, variable: env.variable })}`
      : text
  }
  return (
    <div class="operator-settings-default" data-testid={`settings-default-${props.key}`}>
      <span class="operator-settings-default-label">{props.label}</span>
      <span class="operator-settings-default-value" data-testid="settings-default-value">
        <Show
          when={environment()}
          fallback={
            // The model in effect: the one Settings sets, else the one OpenCode's own logic picks now, tagged Auto.
            <Show when={props.setting ?? effective()?.model}>
              {(value) => (
                <>
                  <Show when={props.name(value())}>
                    {(found) => <ProviderIcon id={found().providerID} width={16} height={16} class="shrink-0" />}
                  </Show>
                  <span>{shown(value())}</span>
                  <Show when={props.name(value())}>
                    {(found) => <span class="operator-settings-default-provider">· {found().provider}</span>}
                  </Show>
                  <Show when={!props.setting}>
                    <span title={language.t("operator.settingsModels.autoTip")} data-testid="settings-default-auto">
                      <Tag>{language.t("operator.settingsModels.auto")}</Tag>
                    </span>
                  </Show>
                  <Show when={props.setting && effective()?.unavailable && effective()?.from === "settings"}>
                    <span class="operator-settings-default-warning" data-testid="settings-default-unavailable">
                      <Icon name="warning" size="small" />
                      {language.t("operator.settingsModels.unavailable")}
                    </span>
                  </Show>
                </>
              )}
            </Show>
          }
        >
          {(env) =>
            language.t("operator.settingsModels.byEnvironment", {
              variable: env().variable ?? "",
              model: shown(env().model),
            })
          }
        </Show>
      </span>
      <span class="operator-settings-default-actions">
        <ButtonV2 size="small" variant="outline" disabled={!props.setting} onClick={props.onClear}>
          {language.t("operator.settingsModels.letDecide")}
        </ButtonV2>
        <FieldHelp field={props.label} text={help()} />
      </span>
    </div>
  )
}
