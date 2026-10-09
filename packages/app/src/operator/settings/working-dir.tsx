import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createEffect, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { FieldHelp } from "../ui/field-help"
import { useFolderBrowser } from "../ui/folder-browser"
import { useLayoutMove } from "../ui/layout-move"

// The working directory (global_and_opencode_namespaces_spec.md §9): every namespace except Global lives
// in it, at <working directory>/<namespace>/. Blank means Global and OpenCode are one namespace. While
// it's blank it can be set here (Global and OpenCode then become separate); changing it moves every
// namespace folder, which comes with moving folders, and clearing it isn't offered.
export function useLayout() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("layout"),
    queryFn: () =>
      api
        .client()
        .operator.layout.get()
        .then((result) => result.data!),
  }))
}

export function WorkingDirectory(props: { onChange?: () => unknown; suggested?: string; onSet?: () => unknown }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const browse = useFolderBrowser()
  const moveFolders = useLayoutMove()
  const layout = useLayout()
  const [folder, setFolder] = createSignal(props.suggested ?? "")
  const [busy, setBusy] = createSignal(false)
  // Changing it once set moves every namespace folder but Global's (§9): a plan first.
  const [changing, setChanging] = createSignal(false)
  // Projects in Global's folder once Global and OpenCode split: they stay in Global unless moved (§9).
  const [inGlobal, setInGlobal] = createSignal<Array<{ key: string; name: string }>>([])
  const save = async () => {
    setBusy(true)
    await api
      .client()
      .operator.layout.workingDir({ workingDir: folder().trim() }, { throwOnError: true })
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: api.key() })
        await props.onChange?.()
        const projects = await api
          .client()
          .operator.projectSettings.list()
          .then((result) => result.data ?? [])
          .catch(() => [])
        setInGlobal(projects.filter((item) => item.namespace === "global").map(({ key, name }) => ({ key, name })))
        await props.onSet?.()
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("settings.namespaces.workingDirFailed"), description: requestError(error) }),
      )
      .finally(() => setBusy(false))
  }
  return (
    <div class="flex flex-col gap-2" data-testid="working-dir">
      <div class="flex items-center">
        <span class="text-12-medium">{language.t("settings.namespaces.workingDir")}</span>
        <FieldHelp
          field={language.t("settings.namespaces.workingDir")}
          text={language.t("settings.namespaces.workingDirHint")}
        />
      </div>
      <Show when={ready(layout)}>
        {(found) => (
          <Show
            when={found().workingDir}
            fallback={
              <div class="flex flex-col gap-2">
                <p data-slot="operator-note">{language.t("settings.namespaces.workingDirBlank")}</p>
                <div class="flex items-center gap-2">
                  <TextInputV2
                    appearance="base"
                    class="flex-1"
                    value={folder()}
                    placeholder="/root/projects"
                    aria-label={language.t("settings.namespaces.workingDir")}
                    onInput={(event) => setFolder(event.currentTarget.value)}
                  />
                  <ButtonV2
                    size="small"
                    variant="outline"
                    onClick={() =>
                      void browse({ over: true }).then((picked) => {
                        if (picked) setFolder(picked)
                      })
                    }
                  >
                    {language.t("settings.namespaces.chooseFolder")}
                  </ButtonV2>
                  <ButtonV2 size="small" disabled={busy() || !folder().trim()} onClick={() => void save()}>
                    {language.t("settings.namespaces.workingDirSet")}
                  </ButtonV2>
                </div>
                <p data-slot="operator-note">{language.t("settings.namespaces.workingDirSetHint")}</p>
              </div>
            }
          >
            {(dir) => (
              <div class="flex flex-col gap-2">
                <div class="flex items-center gap-2">
                  <p class="text-12-regular" data-testid="working-dir-value">
                    <code>{dir()}</code>
                  </p>
                  <Show when={!changing()}>
                    <ButtonV2 size="small" variant="outline" onClick={() => setChanging(true)}>
                      {language.t("settings.namespaces.workingDirChange")}
                    </ButtonV2>
                  </Show>
                </div>
                <Show when={changing()}>
                  <p data-slot="operator-note">{language.t("settings.namespaces.workingDirFixed")}</p>
                  <div class="flex items-center gap-2">
                    <TextInputV2
                      appearance="base"
                      class="flex-1"
                      value={folder()}
                      placeholder={dir()}
                      aria-label={language.t("settings.namespaces.workingDirNew")}
                      onInput={(event) => setFolder(event.currentTarget.value)}
                    />
                    <ButtonV2
                      size="small"
                      variant="outline"
                      onClick={() =>
                        void browse({ over: true }).then((picked) => {
                          if (picked) setFolder(picked)
                        })
                      }
                    >
                      {language.t("settings.namespaces.chooseFolder")}
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      disabled={!folder().trim()}
                      onClick={() =>
                        moveFolders({ workingDir: folder().trim() }, () => {
                          setChanging(false)
                          void props.onChange?.()
                        })
                      }
                    >
                      {language.t("operator.move.check")}
                    </ButtonV2>
                    <ButtonV2 size="small" variant="neutral" onClick={() => setChanging(false)}>
                      {language.t("common.cancel")}
                    </ButtonV2>
                  </div>
                </Show>
                <Show when={inGlobal().length}>
                  <div data-slot="operator-note" data-testid="working-dir-in-global">
                    <p>{language.t("settings.namespaces.inGlobal")}</p>
                    <ul>
                      <For each={inGlobal()}>
                        {(item) => (
                          <li class="flex items-center gap-2">
                            <code>{item.key}</code>
                            <ButtonV2
                              size="small"
                              variant="outline"
                              onClick={() =>
                                moveFolders({ project: item.key, name: item.name, namespace: "opencode" }, () =>
                                  setInGlobal(inGlobal().filter((entry) => entry.key !== item.key)),
                                )
                              }
                            >
                              {language.t("settings.namespaces.moveToOpenCode")}
                            </ButtonV2>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}

// The upgrade's confirmation (global_and_opencode_namespaces_spec.md §12.3): shown once to whoever opens the
// operator console while the upgrade's moves wait. Nothing moves until it is confirmed; "Not now" brings it
// back at the next server start. With other namespaces and a blank working directory, one is asked first.
export function UpgradeCheck() {
  const layout = useLayout()
  const dialog = useDialog()
  const language = useLanguage()
  const moveFolders = useLayoutMove()
  let shown = false
  createEffect(() => {
    const found = ready(layout)
    if (!found?.upgrade.waiting || shown) return
    shown = true
    if (!found.upgrade.needsWorkingDir) return moveFolders({ upgrade: true })
    const open = dialog.active ? dialog.push : dialog.show
    void open(() => (
      <Dialog>
        <DialogHeader>
          <DialogTitle>{language.t("operator.move.upgradeTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div class="flex flex-col gap-3" data-testid="upgrade-working-dir">
            <p data-slot="operator-note">{language.t("operator.move.upgradeNeedsWorkingDir")}</p>
            <WorkingDirectory
              suggested={found.upgrade.suggested}
              onSet={() => {
                dialog.close()
                moveFolders({ upgrade: true })
              }}
            />
          </div>
        </DialogBody>
      </Dialog>
    ))
  })
  return null
}
