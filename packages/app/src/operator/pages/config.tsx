import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useScopedProject } from "../project"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { maskSecrets, requestError } from "./config-helpers"

export default function ConfigPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const directory = useScopedProject()
  const [store, setStore] = createStore({ scope: "project" as Scope, text: "", error: "", saving: false })

  const layers = useQuery(() => ({
    queryKey: api.key("config-layers", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.config.layers({ directory: directory() })
        .then((result) => result.data!),
  }))
  const effective = useQuery(() => ({
    queryKey: api.key("config", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .config.get({ directory: directory() })
        .then((result) => result.data!),
  }))

  const target = createMemo(() => layers.data?.targets[store.scope])
  const saved = createMemo(() => layers.data?.sources.find((source) => source.path === target())?.text ?? "")
  // Load the target file into the editor whenever the scope, project or file changes.
  createEffect(on([target, saved], () => setStore({ text: saved() || "{\n}\n", error: "" })))

  const save = async () => {
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.config.write({ directory: directory(), scope: store.scope, text: store.text })
      .then(async () => {
        showToast({ title: language.t("operator.config.saved"), description: target() })
        await queryClient.invalidateQueries({ queryKey: api.key("config-layers", directory()) })
        await queryClient.invalidateQueries({ queryKey: api.key("config", directory()) })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.config.title")}
        description={language.t("operator.page.config.description")}
        actions={<ScopePicker />}
      />
      <Show
        when={directory()}
        fallback={
          <EmptyState
            icon="sliders"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        <section data-component="operator-panel">
          <h2 data-slot="operator-panel-title">{language.t("operator.config.sources")}</h2>
          <p data-slot="operator-note">{language.t("operator.config.sourcesHint")}</p>
          <ol data-component="operator-sources">
            <For each={layers.data?.sources ?? []}>
              {(source) => (
                <li>
                  <details>
                    <summary>
                      <Tag variant={source.kind === "project" || source.kind === "directory" ? "accent" : "neutral"}>
                        {language.t(`operator.config.kind.${source.kind}`)}
                      </Tag>
                      <code>{source.path}</code>
                    </summary>
                    <pre data-component="operator-code">{source.text}</pre>
                  </details>
                </li>
              )}
            </For>
          </ol>
        </section>

        <section data-component="operator-panel">
          <div data-slot="operator-panel-head">
            <h2 data-slot="operator-panel-title">{language.t("operator.config.edit")}</h2>
            <ScopeSwitch value={store.scope} onChange={(scope) => setStore("scope", scope)} />
          </div>
          <p data-slot="operator-note">{language.t("operator.config.editHint", { path: target() ?? "" })}</p>
          <TextareaV2
            class="operator-editor"
            rows={18}
            spellcheck={false}
            value={store.text}
            invalid={!!store.error}
            aria-label={language.t("operator.config.edit")}
            onInput={(event) => setStore("text", event.currentTarget.value)}
          />
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
          <div data-slot="operator-actions">
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
        </section>

        <section data-component="operator-panel">
          <h2 data-slot="operator-panel-title">{language.t("operator.config.effective")}</h2>
          <p data-slot="operator-note">{language.t("operator.config.effectiveHint")}</p>
          <pre data-component="operator-code">{JSON.stringify(maskSecrets(effective.data ?? {}), null, 2)}</pre>
        </section>
      </Show>
    </>
  )
}
