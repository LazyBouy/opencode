import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorPermissionLevel as Level } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { shortPath } from "../format"
import { requestError } from "../pages/config-helpers"
import { LevelEditor, LevelTable, type LevelValue } from "./level-editor"

// A namespace's or project's permissions (tool_prompt_from_permission.md §7): the lines in force at
// the level, broadest first, and "Edit permissions" for its own lines, its changes and deletions of
// inherited lines, and its locks. A save writes the level's config file and the operator's marks; it
// applies at once, and the projects reload to read the file when none of their sessions is running.
export function LevelPermissions(props: {
  level: "namespace" | "project"
  directory: string | undefined
  // The namespace (namespace level): this one rather than the project's.
  namespace?: string
  onDirty?: (dirty: boolean) => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const key = () => api.key("permission-level", props.level, props.directory, props.namespace)
  const view = useQuery(() => ({
    queryKey: key(),
    // A namespace's level needs no project: any instance answers for it.
    enabled: props.level === "namespace" || !!props.directory,
    queryFn: () =>
      api
        .client()
        .operator.permissionLevel.get({
          level: props.level,
          ...(props.directory ? { directory: props.directory } : {}),
          ...(props.namespace ? { namespace: props.namespace } : {}),
        })
        .then((result) => result.data!),
  }))
  const data = () => ready(view)
  const [store, setStore] = createStore({
    editing: false,
    saving: false,
    error: "",
    value: { lines: [], deleted: [], locks: [] } as LevelValue,
  })
  const saved = createMemo(() =>
    JSON.stringify({
      lines: data()?.own ?? [],
      deleted: data()?.marks.deleted ?? [],
      locks: data()?.marks.locks ?? [],
    }),
  )
  const reset = () => setStore("value", reconcile(JSON.parse(saved()) as LevelValue))
  createEffect(on(saved, reset))
  const dirty = () => store.editing && JSON.stringify(store.value) !== saved()
  createEffect(() => props.onDirty?.(dirty()))

  // A blank slate: OpenCode's own lines deleted, and `* * deny` added (overridable).
  const blankSlate = () => {
    const opencode = (data()?.inherited ?? []).filter((row) => row.level === "opencode")
    setStore("value", {
      lines: [
        ...store.value.lines.filter((rule) => !(rule.permission === "*" && rule.pattern === "*")),
        { permission: "*", pattern: "*", action: "deny" },
      ],
      deleted: [
        ...store.value.deleted,
        ...opencode
          .filter(
            (row) =>
              !store.value.deleted.some((key) => key.permission === row.permission && key.pattern === row.pattern),
          )
          .map((row) => ({ permission: row.permission, pattern: row.pattern })),
      ],
      locks: store.value.locks,
    })
  }

  const save = async () => {
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.permissionLevel.save(
        {
          level: props.level,
          ...(props.directory ? { directory: props.directory } : {}),
          ...(props.namespace ? { namespace: props.namespace } : {}),
          operatorPermissionLevelSave: store.value,
        },
        { throwOnError: true },
      )
      .then(async (result) => {
        queryClient.setQueryData(key(), result.data)
        setStore("editing", false)
        showToast({
          title: language.t("operator.levels.saved"),
          ...(result.data?.reload === "when-idle" ? { description: language.t("operator.levels.reloadWhenIdle") } : {}),
        })
        await Promise.all(
          ["tool-prompt", "tool-prompt-draft", "agent-permissions", "session-permissions"].map((part) =>
            queryClient.invalidateQueries({ queryKey: api.key(part) }),
          ),
        )
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <section class="flex flex-col gap-3" data-testid={`level-permissions-${props.level}`}>
      <Show when={view.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(view.error)}
        </pre>
      </Show>
      <Show when={data()}>
        {(found) => (
          <>
            <Show
              when={found().file}
              fallback={<p data-slot="operator-note">{language.t("operator.levels.noFolder")}</p>}
            >
              {(file) => (
                <p data-slot="operator-note">
                  {language.t(
                    props.level === "namespace" ? "operator.levels.namespaceAbout" : "operator.levels.projectAbout",
                    { file: shortPath(file()) },
                  )}
                </p>
              )}
            </Show>
            <Show when={found().blocked.length}>
              <div data-slot="operator-note" data-warning="" data-testid="level-blocked">
                {language.t("operator.levels.blocked")}:{" "}
                {found()
                  .blocked.map((item) => item.reason)
                  .join("; ")}
              </div>
            </Show>
            <Show
              when={store.editing}
              fallback={
                <>
                  <div class="flex items-center justify-end gap-2">
                    <Show when={found().file}>
                      <ButtonV2 size="small" variant="outline" onClick={() => setStore("editing", true)}>
                        {language.t("operator.levels.edit")}
                      </ButtonV2>
                    </Show>
                  </div>
                  <LevelTable
                    rows={found().rows}
                    deleted={found().deleted}
                    level={props.level as Level}
                    label={language.t("operator.levels.title")}
                  />
                </>
              }
            >
              <Show when={found().canDeleteOpenCode}>
                <div class="flex items-center gap-2">
                  <ButtonV2 size="small" variant="outline" onClick={blankSlate}>
                    {language.t("operator.levels.blankSlate")}
                  </ButtonV2>
                  <span data-slot="operator-note">{language.t("operator.levels.blankSlateHint")}</span>
                </div>
              </Show>
              <LevelEditor
                level={props.level as Level}
                inherited={found().inherited}
                value={store.value}
                onChange={(value) => setStore("value", reconcile(value))}
                canDeleteOpenCode={found().canDeleteOpenCode}
                canLock
                forms={found().forms}
                known={found().known}
              />
              <Show when={store.error}>
                <pre data-slot="operator-error" role="alert">
                  {store.error}
                </pre>
              </Show>
              <div class="flex items-center justify-end gap-2">
                <ButtonV2
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    reset()
                    setStore({ editing: false, error: "" })
                  }}
                >
                  {language.t("common.cancel")}
                </ButtonV2>
                <ButtonV2 size="small" disabled={store.saving || !dirty()} onClick={() => void save()}>
                  {language.t("common.save")}
                </ButtonV2>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
