import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useConfirm } from "../ui/confirm"
import { FieldHelp } from "../ui/field-help"
import { useProjectConfigWrite } from "../ui/project-config-copy"
import { useOpenNamespaceConfig } from "../settings/namespace-config"
import { ConfigEffective, useSourceLabel } from "./config-effective"
import { requestError } from "./config-helpers"

// One project's config (the Config page, and the project record's Config section), §7: the config it
// uses (its own, else its namespace's), raw JSONC to edit, and the effective settings with secrets masked
// and where each comes from. There is no Global / Namespace / Project switch: the first save without a
// config of its own makes the project its own copy (after asking), and the namespace's and Global's
// configs are edited in Settings → Namespaces.
export function ConfigEditor(props: { directory: string; onDirty?: (dirty: boolean) => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const confirm = useConfirm()
  const write = useProjectConfigWrite()
  const openNamespace = useOpenNamespaceConfig()
  const directory = () => props.directory
  const [store, setStore] = createStore({
    text: "",
    error: "",
    saving: false,
    // The text last saved, until the files are read again.
    written: undefined as string | undefined,
  })
  const resolved = useQuery(() => ({
    queryKey: api.key("config-resolved", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.config.resolved({ directory: directory() })
        .then((result) => result.data!),
  }))
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

  const found = () => ready(resolved)
  const namespaceName = () => found()?.namespace.name ?? ""
  const label = useSourceLabel(namespaceName)
  const saved = createMemo(() => found()?.text ?? "")
  // Load the file into the editor whenever the project or its file changes.
  createEffect(on([() => found()?.file, saved], () => setStore({ text: saved(), error: "", written: undefined })))
  // Unsaved text counts as editing where the editor sits in a record (the overlay asks before losing it).
  createEffect(() => props.onDirty?.(!!found() && store.text !== saved() && store.text !== store.written))

  const refresh = () =>
    Promise.all(
      ["config-resolved", "config-layers", "config", "model-defaults"].map((part) =>
        queryClient.invalidateQueries({ queryKey: api.key(part, directory()) }),
      ),
    )

  const save = async () => {
    setStore({ saving: true, error: "" })
    await write((confirmCopy) =>
      api
        .client()
        .operator.config.project(
          { directory: directory(), text: store.text, ...(confirmCopy ? { confirmCopy } : {}) },
          { throwOnError: true },
        ),
    )
      .then(async (result) => {
        if (!result) return
        setStore("written", store.text)
        showToast({
          title: language.t("operator.config.saved"),
          description:
            result.data?.reload === "when-idle"
              ? language.t("operator.config.savedWhenIdle", { path: shortPath(result.data.path) })
              : result.data?.path,
        })
        await refresh()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  // "Use Acme's config again": the project's own files go to Trash.
  const useNamespace = async () => {
    const name = namespaceName()
    const ok = await confirm({
      title: language.t("operator.projectConfig.revertTitle", { name }),
      description: language.t("operator.projectConfig.revertBody", {
        name,
        files: (found()?.ownFiles ?? []).map(shortPath).join(", "),
      }),
      confirm: language.t("operator.projectConfig.revertConfirm", { name }),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.config.revert({ directory: directory() }, { throwOnError: true })
      .then(async () => {
        showToast({ title: language.t("operator.projectConfig.reverted", { name }) })
        await refresh()
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.projectConfig.revertFailed"), description: requestError(error) }),
      )
  }

  const compare = async () => {
    const texts = await api
      .client()
      .operator.config.compare({ directory: directory() }, { throwOnError: true })
      .then((result) => result.data!)
      .catch((error: unknown) => {
        showToast({ title: language.t("operator.projectConfig.compareFailed"), description: requestError(error) })
        return undefined
      })
    if (!texts) return
    const open = dialog.active ? dialog.push : dialog.show
    void open(() => (
      <Dialog size="large">
        <DialogHeader>
          <DialogTitle>{language.t("operator.projectConfig.compareTitle", { name: texts.namespace.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="config-compare">
            <section class="flex flex-col gap-1 min-w-0">
              <h3 class="text-12-medium">{language.t("operator.projectConfig.compareProject")}</h3>
              <code class="text-11-regular">{shortPath(texts.project.file)}</code>
              <pre data-component="operator-code">{texts.project.text}</pre>
            </section>
            <section class="flex flex-col gap-1 min-w-0">
              <h3 class="text-12-medium">
                {language.t("operator.projectConfig.compareNamespace", { name: texts.namespace.name })}
              </h3>
              <code class="text-11-regular">{shortPath(texts.namespace.file)}</code>
              <pre data-component="operator-code">
                {texts.namespace.text || language.t("operator.projectConfig.noNamespaceConfig")}
              </pre>
            </section>
          </div>
        </DialogBody>
      </Dialog>
    ))
  }

  return (
    <div data-component="operator-config-editor" class="flex flex-col gap-4">
      <Show when={found()}>
        {(config) => (
          <section data-component="operator-panel">
            <p data-testid="config-status" class="text-13-regular">
              <Show
                when={config().mode === "own"}
                fallback={
                  <>
                    <strong>
                      {language.t("operator.projectConfig.usingNamespace", { name: config().namespace.name })}
                    </strong>
                    {" · "}
                    <code>{shortPath(config().file)}</code>
                    {". "}
                    {language.t("operator.projectConfig.noOwn")}
                  </>
                }
              >
                <strong>{language.t("operator.projectConfig.usingOwn")}</strong>
                {" · "}
                <code>{shortPath(config().file)}</code>
                {". "}
                <Show when={config().copy}>
                  {(copy) => (
                    <>
                      {language.t("operator.projectConfig.copiedFrom", {
                        name: copy().name,
                        date: new Date(copy().copiedAt).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        }),
                      })}
                      <Show when={copy().changedSince}>
                        {" "}
                        <span data-testid="config-changed-since">
                          {language.t("operator.projectConfig.changedSince", { name: copy().name })}
                        </span>
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
            </p>
            <Show when={config().ownFiles.length > 1}>
              <p data-slot="operator-note" data-testid="config-several">
                {language.t("operator.projectConfig.several", {
                  files: config().ownFiles.map(shortPath).join(" → "),
                  file: shortPath(config().file),
                })}
              </p>
            </Show>
            <Show when={config().tracked}>
              <p data-slot="operator-note" data-testid="config-tracked">
                {language.t("operator.projectConfig.tracked")}
              </p>
            </Show>
            <div data-slot="operator-actions">
              <Show when={config().mode === "own"}>
                <ButtonV2 size="small" variant="neutral" onClick={() => void compare()}>
                  {language.t("operator.projectConfig.compare", { name: config().namespace.name })}
                </ButtonV2>
                <Show when={!config().tracked}>
                  <ButtonV2 size="small" variant="neutral" onClick={() => void useNamespace()}>
                    {language.t("operator.projectConfig.revert", { name: config().namespace.name })}
                  </ButtonV2>
                </Show>
              </Show>
              <ButtonV2 size="small" variant="neutral" onClick={() => openNamespace(config().namespace.id)}>
                {language.t("operator.projectConfig.openNamespace", { name: config().namespace.name })}
              </ButtonV2>
            </div>
            <Show when={config().subfolderFiles.length}>
              <details data-testid="config-subfolders">
                <summary class="text-12-medium">{language.t("operator.projectConfig.subfolders")}</summary>
                <p data-slot="operator-note">{language.t("operator.projectConfig.subfoldersHint")}</p>
                <ul>
                  <For each={config().subfolderFiles}>
                    {(file) => (
                      <li>
                        <code>{shortPath(file)}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
          </section>
        )}
      </Show>

      <section data-component="operator-panel">
        <div data-slot="operator-panel-head">
          <h2 data-slot="operator-panel-title">{language.t("operator.config.edit")}</h2>
          <FieldHelp field={language.t("operator.config.edit")} text={language.t("operator.help.configProject")} />
        </div>
        <p data-slot="operator-note">
          {found()?.mode === "own"
            ? language.t("operator.config.editHint", { path: shortPath(found()?.file ?? "") })
            : language.t("operator.projectConfig.editHintCopy", {
                name: namespaceName(),
                path: shortPath(found()?.target ?? ""),
              })}
        </p>
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

      <ConfigEffective
        config={ready(effective)}
        origins={ready(layers)?.origins ?? {}}
        variables={ready(layers)?.variables}
        sources={ready(layers)?.sources ?? []}
        label={label}
        effectiveHint={language.t("operator.config.effectiveHint")}
        sourcesHint={language.t("operator.config.sourcesHint")}
      />
    </div>
  )
}
