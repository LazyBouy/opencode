import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { type Component, createEffect, createMemo, createResource, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import "@/components/settings-v2/settings-v2.css"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { shortPath } from "../format"
import { requestError } from "../pages/config-helpers"

const OPENCODE = "opencode"

// Settings → Organization → Namespaces: each namespace (an organization) with its org purpose, which
// is sent first in every agent's prompt in it. A new namespace starts as a copy of OpenCode.
export const SettingsNamespacesV2: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const client = () => serverSdk().client.operator.namespace
  const [list, { refetch }] = createResource(() =>
    client()
      .list()
      .then((result) => result.data ?? []),
  )
  const [store, setStore] = createStore({
    selected: OPENCODE,
    name: "",
    purpose: "",
    busy: false,
    confirming: false,
  })
  const current = createMemo(() =>
    store.selected === "new" ? undefined : list.latest?.find((item) => item.namespace.id === store.selected),
  )
  // The form follows the chosen namespace; a new one starts empty.
  createEffect(
    on([() => store.selected, current], () => {
      const found = current()
      setStore({ name: found?.namespace.name ?? "", purpose: found?.namespace.purpose ?? "", confirming: false })
    }),
  )

  const fail = (error: unknown) =>
    showToast({ title: language.t("settings.namespaces.failed"), description: requestError(error) })

  const save = async () => {
    setStore("busy", true)
    const request =
      store.selected === "new"
        ? client().create({ name: store.name.trim(), purpose: store.purpose })
        : client().update({ ns: store.selected, name: store.name.trim(), purpose: store.purpose })
    await request
      .then(async (result) => {
        await refetch()
        if (result.data) setStore("selected", result.data.id)
        showToast({ title: language.t("settings.namespaces.saved", { name: store.name.trim() }) })
      })
      .catch(fail)
      .finally(() => setStore("busy", false))
  }

  const remove = async () => {
    setStore("busy", true)
    await client()
      .remove({ ns: store.selected })
      .then(async () => {
        setStore("selected", OPENCODE)
        await refetch()
      })
      .catch(fail)
      .finally(() => setStore({ busy: false, confirming: false }))
  }

  // Why the chosen namespace cannot be deleted, if it cannot.
  const blocked = () => {
    const found = current()
    if (!found) return undefined
    if (found.namespace.id === OPENCODE) return language.t("settings.namespaces.builtIn")
    if (found.projects.length) return language.t("settings.namespaces.hasProjects", { count: found.projects.length })
    return undefined
  }

  const firstLine = (text: string) => text.split("\n").find((line) => line.trim()) ?? ""

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.namespaces.title")}</h2>
        <div class="flex items-center justify-between gap-3 w-full">
          <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.namespaces.description")}</p>
          <ButtonV2 size="small" variant="outline" onClick={() => setStore("selected", "new")}>
            {language.t("settings.namespaces.new")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body" data-component="settings-namespaces">
        <div class="settings-v2-section">
          <SettingsListV2>
            <For each={list.latest ?? []}>
              {(item: OperatorNamespaceSummary) => (
                <div
                  data-slot="settings-namespace"
                  data-selected={store.selected === item.namespace.id ? "" : undefined}
                >
                  <SettingsRowV2
                    title={
                      <span class="flex items-center gap-2">
                        {item.namespace.name}
                        <Tag>{language.t("settings.namespaces.projects", { count: item.projects.length })}</Tag>
                      </span>
                    }
                    description={firstLine(item.namespace.purpose) || language.t("settings.namespaces.noPurpose")}
                  >
                    <ButtonV2 size="small" variant="ghost" onClick={() => setStore("selected", item.namespace.id)}>
                      {language.t("settings.namespaces.edit", { name: item.namespace.name })}
                    </ButtonV2>
                  </SettingsRowV2>
                </div>
              )}
            </For>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section" data-component="settings-namespace-form">
          <h3 class="settings-v2-tab-title">
            {store.selected === "new" ? language.t("settings.namespaces.new") : current()?.namespace.name}
          </h3>
          <Show when={store.selected === "new"}>
            <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.namespaces.copyNote")}</p>
          </Show>
          <label class="flex flex-col gap-1">
            <span class="text-12-medium">{language.t("settings.namespaces.name")}</span>
            <TextInputV2
              appearance="base"
              value={store.name}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-12-medium">{language.t("settings.namespaces.purpose")}</span>
            <TextareaV2
              rows={5}
              value={store.purpose}
              onInput={(event) => setStore("purpose", event.currentTarget.value)}
            />
            <span class="text-12-regular text-v2-text-text-muted">{language.t("settings.namespaces.purposeHint")}</span>
          </label>
          <Show when={current()}>
            {(found) => (
              <div class="flex flex-col gap-1">
                <span class="text-12-medium">{language.t("settings.namespaces.projectsLabel")}</span>
                <span class="text-12-regular text-v2-text-text-muted">
                  {found().projects.map(shortPath).join(", ") || language.t("settings.namespaces.noProjects")}
                </span>
              </div>
            )}
          </Show>
          <div class="flex items-center justify-end gap-2 flex-wrap">
            <Show when={current()}>
              <Show
                when={store.confirming}
                fallback={
                  <span class="flex items-center gap-2" title={blocked()}>
                    <Show when={blocked()}>
                      {(reason) => <span class="text-12-regular text-v2-text-text-muted">{reason()}</span>}
                    </Show>
                    <ButtonV2
                      variant="danger"
                      disabled={store.busy || !!blocked()}
                      onClick={() => setStore("confirming", true)}
                    >
                      {language.t("settings.namespaces.delete")}
                    </ButtonV2>
                  </span>
                }
              >
                <span class="text-12-regular">
                  {language.t("settings.namespaces.confirmDelete", { name: store.name })}
                </span>
                <ButtonV2 variant="neutral" onClick={() => setStore("confirming", false)}>
                  {language.t("common.cancel")}
                </ButtonV2>
                <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void remove()}>
                  {language.t("settings.namespaces.delete")}
                </ButtonV2>
              </Show>
            </Show>
            <ButtonV2 variant="contrast" disabled={store.busy || !store.name.trim()} onClick={() => void save()}>
              {store.selected === "new"
                ? language.t("settings.namespaces.create")
                : language.t("settings.namespaces.save")}
            </ButtonV2>
          </div>
        </div>
      </div>
    </>
  )
}
