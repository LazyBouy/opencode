import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQueryClient } from "@tanstack/solid-query"
import { createUniqueId, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { OPENCODE } from "../pages/profile-model"
import { FieldHelp } from "./field-help"
import { useFolderBrowser } from "./folder-browser"
import { useLayoutMove } from "./layout-move"

// Add project (global_and_opencode_namespaces_spec.md §10.2): a new project is made at
// `<namespace folder>/<name>/`, a git repository by default (always, in Global: it sits next to Global's
// own config). "Add an existing folder…" adds a folder in the namespace's folder where it is; a folder
// elsewhere is moved into the namespace (§11), or added to OpenCode as it is, flagged "Outside
// OpenCode's folder".

export type NewProjectNamespace = { id: string; name: string; folder: string; global: boolean }

export function useNewProject() {
  const dialog = useDialog()
  return (namespace: NewProjectNamespace, onAdd: (directory: string, namespace: string) => unknown) => {
    const open = dialog.active ? dialog.push : dialog.show
    void open(() => <NewProjectDialog namespace={namespace} onAdd={onAdd} />)
  }
}

const inside = (folder: string, file: string) => file === folder || file.startsWith(folder.replace(/\/+$/, "") + "/")

function NewProjectDialog(props: {
  namespace: NewProjectNamespace
  onAdd: (directory: string, namespace: string) => unknown
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const browse = useFolderBrowser()
  const moveFolder = useLayoutMove()
  const id = createUniqueId()
  const [store, setStore] = createStore({
    name: "",
    git: true,
    busy: false,
    error: "",
    // A folder chosen outside the namespace's folder, waiting for "move it" or "add it as it is".
    outside: undefined as string | undefined,
  })
  const target = () => `${props.namespace.folder.replace(/\/+$/, "")}/${store.name.trim()}`
  const git = () => props.namespace.global || store.git

  const create = async () => {
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.projectSettings.register(
        { namespace: props.namespace.id, name: store.name.trim(), git: git() },
        { throwOnError: true },
      )
      .then(async (result) => {
        const key = result.data?.project.key ?? target()
        await props.onAdd(key, props.namespace.id)
        await queryClient.invalidateQueries({ queryKey: api.key() })
        dialog.close()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }

  const existing = async () => {
    const picked = await browse({ start: props.namespace.folder, over: true })
    if (!picked) return
    if (inside(props.namespace.folder, picked)) {
      await props.onAdd(picked, props.namespace.id)
      dialog.close()
      return
    }
    setStore("outside", picked)
  }

  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>{language.t("operator.newProject.title", { name: props.namespace.name })}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-3" data-component="operator-new-project">
          <Show
            when={!store.outside}
            fallback={
              <div class="flex flex-col gap-2" data-testid="new-project-outside">
                <p>
                  {language.t("operator.newProject.outside", {
                    folder: store.outside!,
                    name: props.namespace.name,
                  })}
                </p>
                <div class="flex flex-wrap gap-2">
                  <ButtonV2
                    variant="contrast"
                    onClick={async () => {
                      const folder = store.outside!
                      // Added as it is first (a folder outside git becomes a project), then moved.
                      await props.onAdd(folder, OPENCODE)
                      dialog.close()
                      moveFolder({
                        project: folder,
                        name: folder.split("/").filter(Boolean).at(-1) ?? "",
                        namespace: props.namespace.id,
                      })
                    }}
                  >
                    {language.t("operator.newProject.moveIn", { name: props.namespace.name })}
                  </ButtonV2>
                  <ButtonV2
                    variant="neutral"
                    onClick={async () => {
                      await props.onAdd(store.outside!, OPENCODE)
                      dialog.close()
                    }}
                  >
                    {language.t("operator.newProject.asIs")}
                  </ButtonV2>
                </div>
              </div>
            }
          >
            <div class="flex flex-col gap-1">
              <div class="flex items-center">
                <label class="text-12-medium" for={`${id}-name`}>
                  {language.t("operator.newProject.name")}
                </label>
                <FieldHelp
                  field={language.t("operator.newProject.name")}
                  text={language.t("operator.newProject.nameHint")}
                />
              </div>
              <TextInputV2
                id={`${id}-name`}
                appearance="base"
                value={store.name}
                onInput={(event) => setStore("name", event.currentTarget.value)}
              />
              <p data-slot="operator-note" data-testid="new-project-path">
                <code>{store.name.trim() ? target() : `${props.namespace.folder}/…`}</code>
              </p>
            </div>
            <span class="inline-flex items-center">
              <CheckboxV2
                label={language.t("operator.newProject.git")}
                checked={git()}
                disabled={props.namespace.global}
                onChange={(checked: boolean) => setStore("git", checked)}
              />
              <FieldHelp
                field={language.t("operator.newProject.git")}
                text={
                  props.namespace.global
                    ? language.t("operator.newProject.gitGlobal")
                    : language.t("operator.newProject.gitHint")
                }
              />
            </span>
          </Show>
          <Show when={store.error}>
            <p data-slot="operator-error" role="alert">
              {store.error}
            </p>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Show when={!store.outside}>
          <ButtonV2 variant="neutral" onClick={() => void existing()}>
            {language.t("operator.newProject.existing")}
          </ButtonV2>
        </Show>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <Show when={!store.outside}>
          <ButtonV2 variant="contrast" disabled={store.busy || !store.name.trim()} onClick={() => void create()}>
            {language.t("operator.newProject.create")}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
