import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SelectV2 } from "./select"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorFolderListing } from "@opencode-ai/sdk/v2/client"
import { createMemo, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { crumbs } from "../format"
import { requestError } from "../pages/config-helpers"
import { FieldHelp } from "./field-help"

// Opens a dialog to browse the server's workspace roots, create folders in them and pick one (a
// project, a namespace's folder). It starts in `start` when that folder can be listed, else in the
// first root. `over` opens it over the dialog it is called from (which stays open). `within` keeps it inside one
// folder (an agent's home inside its project): it starts there, can't go above it, and makes no git repositories.
// Resolves with the chosen folder, or undefined when dismissed.
export function useFolderBrowser() {
  const dialog = useDialog()
  const language = useLanguage()
  const api = useOperatorClient()
  return (options?: { start?: string; over?: boolean; within?: string }) =>
    new Promise<string | undefined>((resolve) => {
      const finish = (path: string | undefined) => {
        resolve(path)
        dialog.close()
      }
      const open = options?.over ? dialog.push : dialog.show
      void open(
        () => (
          <FolderBrowser
            language={language}
            client={api.client}
            start={options?.start ?? options?.within}
            within={options?.within}
            onDone={finish}
          />
        ),
        () => resolve(undefined),
      )
    })
}

function FolderBrowser(props: {
  language: ReturnType<typeof useLanguage>
  client: ReturnType<typeof useOperatorClient>["client"]
  start?: string
  within?: string
  onDone: (path: string | undefined) => void
}) {
  const t = props.language.t
  const [store, setStore] = createStore({
    roots: [] as string[],
    listing: undefined as OperatorFolderListing | undefined,
    loading: true,
    error: "",
    name: "",
    git: !props.within,
    busy: false,
  })
  const inside = (path: string) => !props.within || path === props.within || path.startsWith(`${props.within}/`)

  const open = async (path?: string, fallback = false) => {
    setStore({ loading: true, error: "" })
    await props
      .client()
      .operator.folder.list({ path })
      .then((result) => setStore("listing", result.data))
      .catch((error: unknown) => (fallback ? open() : setStore("error", requestError(error))))
      .finally(() => setStore("loading", false))
  }

  onMount(() => {
    void props
      .client()
      .operator.folder.roots()
      .then((result) => setStore("roots", result.data ?? []))
      .catch(() => undefined)
    void open(props.start, !!props.start)
  })

  const create = async () => {
    const listing = store.listing
    if (!listing || !store.name.trim()) return
    setStore({ busy: true, error: "" })
    await props
      .client()
      .operator.folder.create({ parent: listing.path, name: store.name.trim(), git: store.git })
      .then(async (result) => {
        setStore("name", "")
        await open(result.data?.path ?? listing.path)
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  const init = async () => {
    const listing = store.listing
    if (!listing) return
    setStore({ busy: true, error: "" })
    await props
      .client()
      .operator.folder.init({ path: listing.path })
      .then(() => open(listing.path))
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  const trail = createMemo(() =>
    (store.listing ? crumbs(store.listing.root, store.listing.path) : []).filter((crumb) => inside(crumb.path)),
  )

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{t("operator.folders.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 pt-2 pb-2">
        <div data-component="operator-folders">
          <p data-slot="operator-note">{t("operator.folders.hint")}</p>
          <div data-slot="operator-folders-path">
            <Show when={store.roots.length > 1 && !props.within}>
              <SelectV2<string>
                appearance="inline"
                aria-label={t("operator.folders.root")}
                options={store.roots}
                current={store.listing?.root}
                onSelect={(root) => root && void open(root)}
              />
            </Show>
            <nav aria-label={t("operator.folders.path")} data-slot="operator-folders-crumbs">
              <For each={trail()}>
                {(crumb, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span aria-hidden="true">/</span>
                    </Show>
                    <button
                      type="button"
                      data-slot="operator-link"
                      aria-current={index() === trail().length - 1 ? "location" : undefined}
                      onClick={() => void open(crumb.path)}
                    >
                      {crumb.name}
                    </button>
                  </>
                )}
              </For>
            </nav>
          </div>

          <ul data-component="operator-layers" aria-label={t("operator.folders.list")} aria-busy={store.loading}>
            <Show
              when={store.listing?.parent && store.listing.path !== props.within ? store.listing.parent : undefined}
            >
              {(parent) => (
                <li data-slot="operator-layer">
                  <button type="button" data-slot="operator-layer-open" onClick={() => void open(parent())}>
                    <Icon name="arrow-up" />
                    <span data-slot="operator-layer-name">{t("operator.folders.up")}</span>
                  </button>
                </li>
              )}
            </Show>
            <For
              each={store.listing?.folders ?? []}
              fallback={
                <Show when={!store.loading}>
                  <li data-slot="operator-note">{t("operator.folders.empty")}</li>
                </Show>
              }
            >
              {(folder) => (
                <li data-slot="operator-layer">
                  <button type="button" data-slot="operator-layer-open" onClick={() => void open(folder.path)}>
                    <Icon name="folder" />
                    <span data-slot="operator-layer-name">{folder.name}</span>
                    <Show when={folder.project}>
                      <Tag variant="accent">{t("operator.folders.git")}</Tag>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>

          <form
            data-slot="operator-folders-new"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <span class="inline-flex items-center">
              <TextInputV2
                appearance="base"
                value={store.name}
                placeholder={t("operator.folders.newPlaceholder")}
                aria-label={t("operator.folders.new")}
                onInput={(event) => setStore("name", event.currentTarget.value)}
              />
              <FieldHelp field={t("operator.folders.new")} text={t("operator.help.newFolder")} />
            </span>
            <span class="inline-flex items-center" hidden={!!props.within}>
              <CheckboxV2
                label={t("operator.folders.gitOption")}
                checked={store.git}
                onChange={(checked: boolean) => setStore("git", checked)}
              />
              <FieldHelp field={t("operator.folders.gitOption")} text={t("operator.help.gitOption")} />
            </span>
            <ButtonV2 type="submit" variant="outline" disabled={!store.name.trim() || store.busy || !store.listing}>
              {t("operator.folders.create")}
            </ButtonV2>
          </form>

          <Show when={store.listing && !store.listing.project && !props.within}>
            <div data-slot="operator-folders-notice">
              <span>{t("operator.folders.notGit")}</span>
              <ButtonV2 size="small" variant="outline" disabled={store.busy} onClick={() => void init()}>
                {t("operator.folders.init")}
              </ButtonV2>
            </div>
          </Show>
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => props.onDone(undefined)}>
          {t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={!store.listing || store.loading}
          onClick={() => props.onDone(store.listing?.path)}
        >
          {t("operator.folders.use")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
