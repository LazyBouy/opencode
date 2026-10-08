import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { FieldHelp } from "../ui/field-help"
import { type WriteScope, WriteScopeSwitch } from "../ui/scope-switch"
import { useNamespaces } from "./profile-data"
import { maskSecrets, requestError } from "./config-helpers"

// One project's config (the Config page, and the project record's Config section): where it comes
// from, the raw JSONC of the global, namespace or project file to edit, and the effective config with
// secrets masked and each setting's origin.
export function ConfigEditor(props: { directory: string; onDirty?: (dirty: boolean) => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const directory = () => props.directory
  const [store, setStore] = createStore({
    scope: "project" as WriteScope,
    text: "",
    error: "",
    saving: false,
    // The text last saved, until the files are read again.
    written: undefined as string | undefined,
  })
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

  const namespaces = useNamespaces()
  const namespaceName = () => {
    const id = ready(layers)?.namespace ?? ""
    return ready(namespaces)?.find((item) => item.namespace.id === id)?.namespace.name ?? id
  }
  const target = createMemo(() => ready(layers)?.targets[store.scope])
  const saved = createMemo(() => ready(layers)?.sources.find((source) => source.path === target())?.text ?? "")
  // Load the target file into the editor whenever the scope, project or file changes.
  createEffect(on([target, saved], () => setStore({ text: saved() || "{\n}\n", error: "", written: undefined })))
  // Unsaved text counts as editing where the editor sits in a record (the overlay asks before losing it).
  createEffect(() =>
    props.onDirty?.(!!ready(layers) && store.text !== (saved() || "{\n}\n") && store.text !== store.written),
  )

  const save = async () => {
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.config.write({ directory: directory(), scope: store.scope, text: store.text })
      .then(async () => {
        setStore("written", store.text)
        showToast({ title: language.t("operator.config.saved"), description: target() })
        await queryClient.invalidateQueries({ queryKey: api.key("config-layers", directory()) })
        await queryClient.invalidateQueries({ queryKey: api.key("config", directory()) })
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <div data-component="operator-config-editor" class="flex flex-col gap-4">
      <section data-component="operator-panel">
        <h2 data-slot="operator-panel-title">{language.t("operator.config.sources")}</h2>
        <p data-slot="operator-note">{language.t("operator.config.sourcesHint")}</p>
        <ol data-component="operator-sources">
          <For each={ready(layers)?.sources ?? []}>
            {(source) => (
              <li>
                <details>
                  <summary>
                    <Tag
                      variant={
                        source.kind === "project" || source.kind === "directory" || source.kind === "namespace"
                          ? "accent"
                          : "neutral"
                      }
                    >
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
          <span class="inline-flex items-center">
            <WriteScopeSwitch
              value={store.scope}
              onChange={(scope) => setStore("scope", scope)}
              namespace={namespaceName()}
              namespaceDisabled={!ready(layers)?.targets.namespace}
            />
            <FieldHelp field={language.t("operator.config.edit")} text={language.t("operator.help.configScope")} />
          </span>
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
        <pre data-component="operator-code">{JSON.stringify(maskSecrets(ready(effective) ?? {}), null, 2)}</pre>
        <h3 data-slot="operator-panel-title">{language.t("operator.config.origins")}</h3>
        <dl data-component="record-fields" data-testid="config-origins">
          <For each={Object.entries(ready(layers)?.origins ?? {}).toSorted((a, b) => a[0].localeCompare(b[0]))}>
            {([key, kind]) => (
              <>
                <dt>
                  <code>{key}</code>
                </dt>
                <dd>
                  <Tag variant={kind === "namespace" ? "accent" : "neutral"}>
                    {language.t(`operator.config.kind.${kind}`)}
                  </Tag>
                </dd>
              </>
            )}
          </For>
        </dl>
      </section>
    </div>
  )
}
