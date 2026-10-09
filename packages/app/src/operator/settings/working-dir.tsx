import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { FieldHelp } from "../ui/field-help"
import { useFolderBrowser } from "../ui/folder-browser"

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

export function WorkingDirectory(props: { onChange?: () => unknown }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const browse = useFolderBrowser()
  const layout = useLayout()
  const [folder, setFolder] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const save = async () => {
    setBusy(true)
    await api
      .client()
      .operator.layout.workingDir({ workingDir: folder().trim() }, { throwOnError: true })
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: api.key("layout") })
        await props.onChange?.()
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
              <p
                class="text-12-regular"
                data-testid="working-dir-value"
                title={language.t("settings.namespaces.workingDirFixed")}
              >
                <code>{dir()}</code>
              </p>
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}
