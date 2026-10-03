import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import type { SessionMergeAdapter } from "@opencode-ai/sdk/v2/client"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import "@/components/settings-v2/settings-v2.css"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"

// Settings → Server → Adapters: the external agents `/merge` can attach, whether each one's program
// is installed, and a switch to turn it off. New adapters registered on the server appear here.
export const SettingsAdaptersV2: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [saving, setSaving] = createSignal<string>()
  const [adapters, { refetch }] = createResource(() =>
    serverSdk()
      .client.merge.adapter.list()
      .then((result) => result.data ?? []),
  )

  const toggle = async (adapter: SessionMergeAdapter, enabled: boolean) => {
    setSaving(adapter.id)
    await serverSync()
      .updateConfig({ merge: { adapters: { [adapter.id]: { enabled } } } })
      .then(() => refetch())
      .catch((error: unknown) =>
        showToast({
          title: language.t("settings.adapters.saveFailed", { name: adapter.name }),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setSaving(undefined))
  }

  const status = (adapter: SessionMergeAdapter) => {
    if (!adapter.enabled) return language.t("settings.adapters.status.off")
    if (!adapter.available) return language.t("settings.adapters.status.missing")
    return language.t("settings.adapters.status.ready")
  }

  const details = (adapter: SessionMergeAdapter) =>
    [
      adapter.version ? language.t("settings.adapters.version", { version: adapter.version }) : undefined,
      adapter.binary,
      adapter.available ? undefined : adapter.message,
      language.t("settings.adapters.usage", { id: adapter.id }),
    ]
      .filter(Boolean)
      .join(" · ")

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.adapters.title")}</h2>
        <div class="flex items-center justify-between gap-3 w-full">
          <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.adapters.description")}</p>
          <ButtonV2 size="small" variant="outline" disabled={adapters.loading} onClick={() => void refetch()}>
            {language.t("settings.adapters.recheck")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body" data-component="settings-adapters">
        <Show
          when={!adapters.error}
          fallback={
            <p class="text-12-regular text-v2-text-text-muted">
              {language.t("settings.adapters.loadFailed", { message: String(adapters.error) })}
            </p>
          }
        >
          <Show
            when={adapters.latest}
            fallback={
              <p class="text-12-regular text-v2-text-text-muted">
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </p>
            }
          >
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.adapters.empty")}</p>
                }
              >
                <div class="settings-v2-section">
                  <SettingsListV2>
                    <For each={list()}>
                      {(adapter) => (
                        <div
                          data-slot="settings-adapter"
                          data-adapter={adapter.id}
                          data-status={!adapter.enabled ? "off" : adapter.available ? "ready" : "missing"}
                        >
                          <SettingsRowV2
                            title={
                              <span class="flex items-center gap-2">
                                {adapter.name}
                                <Tag variant={adapter.enabled && adapter.available ? "accent" : "neutral"}>
                                  {status(adapter)}
                                </Tag>
                              </span>
                            }
                            description={details(adapter)}
                          >
                            <Switch
                              checked={adapter.enabled}
                              disabled={saving() === adapter.id}
                              onChange={(checked) => void toggle(adapter, checked)}
                              hideLabel
                            >
                              {language.t("settings.adapters.toggle", { name: adapter.name })}
                            </Switch>
                          </SettingsRowV2>
                        </div>
                      )}
                    </For>
                  </SettingsListV2>
                </div>
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </>
  )
}
