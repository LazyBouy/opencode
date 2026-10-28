import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useConfirm } from "./confirm"
import { type Key, LevelEditor } from "./level-editor"
import { PermissionImpact } from "./permission-impact"
import type { Rule } from "./rules"

// A session's permissions, the lowest level (tool_prompt_from_permission.md §7): what it inherits from
// every level above (OpenCode, global, namespace, project, agent), each line changeable or deletable
// here unless a level above locked it, and the session's own lines. With none, the session is like its
// agent. Saving replaces the session's own lines and deletions; they apply at once. A line inside a
// locked one is refused; when every line is locked, nothing can be changed. Used in the session details
// panel, the session record and the chat's "…" menu.
export function SessionPermissions(props: {
  sessionID: string
  directory: string | undefined
  // Show only the rules for this permission (Tool Prompt's "Change access").
  filter?: string
  onClearFilter?: () => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const serverSdk = useServerSDK()
  const confirm = useConfirm()
  const info = useQuery(() => ({
    queryKey: api.key("session-permissions", props.directory, props.sessionID),
    enabled: !!props.directory,
    queryFn: () =>
      api
        .client()
        .operator.sessionPermissions.get({ sessionID: props.sessionID, directory: props.directory })
        .then((result) => result.data!),
  }))
  const [store, setStore] = createStore({ rules: [] as Rule[], deleted: [] as Key[], saving: false, error: "" })
  const saved = createMemo(() => JSON.stringify({ rules: info.data?.written ?? [], deleted: info.data?.deleted ?? [] }))
  const restore = () => {
    const value = JSON.parse(saved()) as { rules: Rule[]; deleted: Key[] }
    setStore({ rules: value.rules, deleted: value.deleted })
  }
  createEffect(on(saved, restore))
  const dirty = () => JSON.stringify({ rules: store.rules, deleted: store.deleted }) !== saved()

  // The session changed elsewhere (Always allow, a client, another view): show its rules again.
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: { info?: { id?: string }; sessionID?: string } }
    if (details?.type !== "session.updated") return
    if ((details.properties?.info?.id ?? details.properties?.sessionID) !== props.sessionID) return
    void info.refetch()
  })
  onCleanup(stop)

  // `clearsCorrelation` also clears the session's default correlation id (SPEC-0026: an empty value).
  const write = async (rules: Rule[], deleted: Key[], clearsCorrelation = false) => {
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.sessionPermissions.save({
        sessionID: props.sessionID,
        directory: props.directory,
        rules,
        deleted,
        ...(clearsCorrelation ? { correlationID: "" } : {}),
      })
      .then(async (result) => {
        queryClient.setQueryData(api.key("session-permissions", props.directory, props.sessionID), result.data)
        showToast({ title: language.t("operator.sessionPermissions.saved") })
        await Promise.all(
          ["tool-prompt", "tool-prompt-draft"].map((part) =>
            queryClient.invalidateQueries({ queryKey: api.key(part, props.directory) }),
          ),
        )
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }
  const reset = async () => {
    const ok = await confirm({
      title: language.t("operator.sessionPermissions.resetTitle"),
      description: language.t("operator.sessionPermissions.resetBody"),
      confirm: language.t("operator.sessionPermissions.reset"),
      danger: true,
    })
    if (ok) await write([], [], true)
  }
  // Clears only the default correlation id: the saved rules stay as they are.
  const clearCorrelation = async () => {
    const value = JSON.parse(saved()) as { rules: Rule[]; deleted: Key[] }
    await write(value.rules, value.deleted, true)
  }

  return (
    <div data-slot="operator-permission-edit" data-testid="session-permissions">
      <Show when={info.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(info.error)}
        </pre>
      </Show>
      <Show when={info.data}>
        {(data) => (
          <>
            <p data-slot="operator-note">{language.t("operator.sessionPermissions.about", { agent: data().agent })}</p>
            <Show when={data().correlationID}>
              {(id) => (
                <div class="flex items-center gap-2" data-testid="session-permissions-correlation">
                  <p data-slot="operator-note">{language.t("operator.sessionPermissions.correlation", { id: id() })}</p>
                  <ButtonV2 variant="neutral" disabled={store.saving} onClick={() => void clearCorrelation()}>
                    {language.t("operator.sessionPermissions.correlationClear")}
                  </ButtonV2>
                </div>
              )}
            </Show>
            <div data-slot="operator-permission-layout">
              <div class="flex flex-col gap-4 min-w-0" data-testid="session-permissions-own">
                <Show
                  when={!data().allLocked}
                  fallback={<p data-slot="operator-note">{language.t("operator.locks.allLocked")}</p>}
                >
                  <LevelEditor
                    directory={props.directory}
                    level="session"
                    inherited={data().rows.slice(0, data().editable.start)}
                    ownRows={data().rows.slice(data().editable.start, data().editable.end)}
                    value={{ lines: store.rules, deleted: store.deleted, locks: [] }}
                    onChange={(value) => setStore({ rules: value.lines, deleted: value.deleted })}
                    canDeleteOpenCode={data().canDeleteOpenCode}
                    canLock={false}
                    forms={data().forms}
                    known={data().known}
                    filter={props.filter}
                    onClearFilter={props.onClearFilter}
                  />
                </Show>
              </div>
              <PermissionImpact
                agent={data().agent}
                directory={props.directory ?? ""}
                sessionID={props.sessionID}
                sessionRules={store.rules}
                dirty={dirty()}
              />
            </div>
            <Show when={store.error}>
              <pre data-slot="operator-error" role="alert">
                {store.error}
              </pre>
            </Show>
            <div data-slot="operator-actions">
              <ButtonV2
                variant="danger"
                disabled={store.saving || (!data().written.length && !data().deleted.length && !data().correlationID)}
                onClick={() => void reset()}
              >
                {language.t("operator.sessionPermissions.reset")}
              </ButtonV2>
              <span class="flex-1" />
              <ButtonV2 variant="neutral" disabled={!dirty()} onClick={restore}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                disabled={store.saving || !dirty() || data().allLocked}
                onClick={() => void write(store.rules, store.deleted)}
              >
                {language.t("operator.sessionPermissions.save")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
