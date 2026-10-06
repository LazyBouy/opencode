import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useConfirm } from "./confirm"
import { PermissionEditor } from "./permission-editor"
import { PermissionImpact } from "./permission-impact"
import type { Rule } from "./rules"

// A session's permissions: its agent's full list (locked, with Override) and the session's own rules,
// which come after the agent's and are edited here. With none, the session is like its agent. Saving
// replaces the session's own rules; they apply from the session's next step. Used in the session
// inspector and on the Sessions page.
export function SessionPermissions(props: { sessionID: string; directory: string | undefined }) {
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
  const [store, setStore] = createStore({ rules: [] as Rule[], saving: false, error: "" })
  const saved = createMemo(() => JSON.stringify(info.data?.written ?? []))
  createEffect(on(saved, () => setStore("rules", reconcile((info.data?.written ?? []).map((rule) => ({ ...rule }))))))
  const dirty = () => JSON.stringify(store.rules) !== saved()

  // The session changed elsewhere (Always allow, a client, another view): show its rules again.
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: { info?: { id?: string }; sessionID?: string } }
    if (details?.type !== "session.updated") return
    if ((details.properties?.info?.id ?? details.properties?.sessionID) !== props.sessionID) return
    void info.refetch()
  })
  onCleanup(stop)

  const write = async (rules: Rule[]) => {
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.sessionPermissions.save({ sessionID: props.sessionID, directory: props.directory, rules })
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
    if (ok) await write([])
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
            <div data-slot="operator-permission-layout">
              <PermissionEditor
                mode="session"
                rows={data().rows}
                editable={data().editable}
                value={store.rules}
                onChange={(rules) => setStore("rules", rules)}
                forms={data().forms}
                known={data().known}
              />
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
              <ButtonV2 variant="danger" disabled={store.saving || !data().written.length} onClick={() => void reset()}>
                {language.t("operator.sessionPermissions.reset")}
              </ButtonV2>
              <span class="flex-1" />
              <ButtonV2
                variant="neutral"
                disabled={!dirty()}
                onClick={() => setStore("rules", reconcile(data().written.map((rule) => ({ ...rule }))))}
              >
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="contrast" disabled={store.saving || !dirty()} onClick={() => void write(store.rules)}>
                {language.t("operator.sessionPermissions.save")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
