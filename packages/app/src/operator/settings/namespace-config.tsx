import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { shortPath } from "../format"
import { requestError } from "../pages/config-helpers"

// A namespace's config, and Global's (global_and_opencode_namespaces_spec.md §8): the Config section of
// each namespace in Settings → Namespaces, the only place they are edited. The notice says who a change
// reaches: the namespace's projects that use its config (not those with their own copy), and for Global
// every namespace that inherits it.

// A namespace record to open with its Config section, when Settings opens from a project's Config page.
let requested: string | undefined
export function takeRequestedNamespace() {
  const id = requested
  requested = undefined
  return id
}

/** Opens Settings → Namespaces at a namespace's Config section. */
export function useOpenNamespaceConfig() {
  const open = useSettingsDialog("namespaces")
  return (id: string) => {
    requested = id
    open()
  }
}

export function NamespaceConfigEditor(props: {
  namespace: string
  onDirty?: (dirty: boolean) => void
  /** Scrolled into view once loaded (opened from a project's Config page). */
  focus?: boolean
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const [store, setStore] = createStore({
    text: "",
    error: "",
    saving: false,
    written: undefined as string | undefined,
  })
  const config = useQuery(() => ({
    queryKey: api.key("namespace-config", props.namespace),
    queryFn: () =>
      api
        .client()
        .operator.namespaceConfig.get({ id: props.namespace }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const found = () => ready(config)
  const saved = createMemo(() => found()?.text ?? "")
  createEffect(on([() => found()?.file, saved], () => setStore({ text: saved(), error: "", written: undefined })))
  createEffect(() => props.onDirty?.(!!found() && store.text !== saved() && store.text !== store.written))
  let element: HTMLDivElement | undefined
  let focused = false
  createEffect(() => {
    if (!props.focus || focused || !found()) return
    focused = true
    requestAnimationFrame(() => element?.scrollIntoView({ block: "start" }))
  })

  const save = async () => {
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.namespaceConfig.save({ id: props.namespace, text: store.text }, { throwOnError: true })
      .then(async (result) => {
        setStore("written", store.text)
        showToast({
          title: language.t("operator.config.saved"),
          description:
            result.data?.reload === "when-idle"
              ? language.t("operator.config.savedWhenIdle", { path: shortPath(result.data.file) })
              : result.data?.file,
        })
        await queryClient.invalidateQueries({ queryKey: api.key("namespace-config", props.namespace) })
        await Promise.all(
          ["config-resolved", "config-layers", "config"].map((part) =>
            queryClient.invalidateQueries({ queryKey: api.key(part) }),
          ),
        )
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <div class="flex flex-col gap-2" data-testid="namespace-config" ref={(el) => (element = el)}>
      <Show when={found()}>
        {(item) => (
          <>
            <p class="text-12-regular">
              <code>{shortPath(item().file)}</code>
              <Show when={!item().exists}> · {language.t("settings.namespaces.config.none")}</Show>
            </p>
            <Show
              when={item().global}
              fallback={
                <div data-slot="operator-note" data-testid="namespace-config-reach">
                  <p>
                    {language.t("settings.namespaces.config.reach", {
                      name: item().name,
                      count: item().using.length,
                    })}
                  </p>
                  <Show when={item().own.length}>
                    <p>
                      {language.t("settings.namespaces.config.own", { count: item().own.length })}{" "}
                      <For each={item().own}>
                        {(project, index) => (
                          <>
                            {index() > 0 ? ", " : ""}
                            <a
                              href={`/operator/projects?project=${encodeURIComponent(project.project)}&psec=config`}
                              title={project.project}
                            >
                              {project.name}
                            </a>
                          </>
                        )}
                      </For>
                    </p>
                  </Show>
                </div>
              }
            >
              <p data-slot="operator-note" data-testid="namespace-config-reach">
                {language.t("settings.namespaces.config.globalReach", { count: item().inheriting.length })}
              </p>
            </Show>
          </>
        )}
      </Show>
      <TextareaV2
        class="operator-editor"
        rows={14}
        spellcheck={false}
        value={store.text}
        invalid={!!store.error}
        aria-label={language.t("settings.namespaces.config.title")}
        onInput={(event) => setStore("text", event.currentTarget.value)}
      />
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div class="flex items-center justify-end gap-2">
        <ButtonV2
          variant="neutral"
          disabled={store.saving || store.text === saved()}
          onClick={() => setStore({ text: saved(), error: "" })}
        >
          {language.t("operator.config.revert")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.saving || store.text === saved()} onClick={() => void save()}>
          {language.t("operator.config.save")}
        </ButtonV2>
      </div>
    </div>
  )
}
