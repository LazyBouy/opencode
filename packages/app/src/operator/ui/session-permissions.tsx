import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorPermissionRow } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useConfirm } from "./confirm"
import { PermissionEditor } from "./permission-editor"
import { DataTable } from "./data-table"
import { PermissionImpact } from "./permission-impact"
import { useOriginText } from "./permission-origin"
import type { Rule } from "./rules"

// A session's permissions, in two blocks (fixes_spec.md §6): From the agent (read-only; the agent's
// rules this session does not override, locked ones marked) and This session (its own rules, edited
// here, each overriding the agent's rule with the same permission and pattern). With none, the session
// is like its agent. Saving replaces the session's own rules; they apply at once. A rule that would
// change one the agent locks is refused; when the agent locks every rule, nothing can be changed. Used
// in the session details panel, the session record and the chat's "…" menu.
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
            <p data-slot="operator-note">{language.t("operator.locks.precedence")}</p>
            <div data-slot="operator-permission-layout">
              <div class="flex flex-col gap-4 min-w-0">
                <section data-testid="session-permissions-agent">
                  <h3 data-slot="operator-panel-title">
                    {language.t("operator.sessionPermissions.fromAgent", { agent: data().agent })}
                  </h3>
                  <AgentBlock
                    rows={data().rows.slice(0, data().editable.start)}
                    session={store.rules}
                    locked={data().locked}
                    filter={props.filter}
                  />
                </section>
                <section data-testid="session-permissions-own">
                  <h3 data-slot="operator-panel-title">{language.t("operator.sessionPermissions.thisSession")}</h3>
                  <Show
                    when={!data().allLocked}
                    fallback={<p data-slot="operator-note">{language.t("operator.locks.allLocked")}</p>}
                  >
                    <PermissionEditor
                      mode="session"
                      rows={data().rows.slice(data().editable.start, data().editable.end)}
                      editable={{ start: 0, end: data().editable.end - data().editable.start }}
                      value={store.rules}
                      onChange={(rules) => setStore("rules", rules)}
                      forms={data().forms}
                      known={data().known}
                      filter={props.filter}
                      onClearFilter={props.onClearFilter}
                    />
                    <Overrides rows={data().rows.slice(0, data().editable.start)} session={store.rules} />
                  </Show>
                </section>
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
              <ButtonV2
                variant="contrast"
                disabled={store.saving || !dirty() || data().allLocked}
                onClick={() => void write(store.rules)}
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

const sameKey = (a: { permission: string; pattern: string }, b: { permission: string; pattern: string }) =>
  a.permission === b.permission && a.pattern === b.pattern

// The agent's rules the session does not override (one with the same permission and pattern in the
// session's own rules does), read-only, each with where it comes from; locked ones are marked.
function AgentBlock(props: {
  rows: ReadonlyArray<OperatorPermissionRow>
  session: ReadonlyArray<Rule>
  locked: ReadonlyArray<{ permission: string; pattern: string }>
  filter?: string
}) {
  const language = useLanguage()
  const origin = useOriginText()
  const rows = () =>
    props.rows.filter(
      (row) =>
        !props.session.some((rule) => sameKey(rule, row)) &&
        (!props.filter || row.permission === props.filter || row.permission.includes("*")),
    )
  return (
    <DataTable
      label={language.t("operator.sessionPermissions.fromAgentLabel")}
      rows={[...rows()]}
      empty={language.t("operator.agent.noRules")}
      columns={[
        { id: "index", header: "#", width: "48px", cell: (row) => row.index, value: (row) => row.index },
        {
          id: "permission",
          header: language.t("operator.column.permission"),
          cell: (row) => <code>{row.permission}</code>,
          value: (row) => row.permission,
        },
        {
          id: "pattern",
          header: language.t("operator.column.pattern"),
          cell: (row) => <code>{row.pattern}</code>,
          value: (row) => row.pattern,
        },
        {
          id: "action",
          header: language.t("operator.column.action"),
          cell: (row) => (
            <span class="inline-flex items-center gap-1">
              <Tag variant={row.action === "allow" ? "accent" : "neutral"}>
                {language.t(`operator.permission.action.${row.action}`)}
              </Tag>
              <Show when={props.locked.some((lock) => sameKey(lock, row))}>
                <Tag data-testid="rule-locked" title={language.t("operator.help.ruleLock")}>
                  {language.t("operator.locks.locked")}
                </Tag>
              </Show>
            </span>
          ),
          value: (row) => row.action,
        },
        {
          id: "from",
          header: language.t("operator.toolPrompt.column.from"),
          cell: (row) => origin(row.from),
          value: (row) => String(origin(row.from)),
        },
      ]}
    />
  )
}

// Which of the agent's rules the session's own rules override.
function Overrides(props: { rows: ReadonlyArray<OperatorPermissionRow>; session: ReadonlyArray<Rule> }) {
  const language = useLanguage()
  const pairs = () =>
    props.session.flatMap((rule) => {
      const row = props.rows.findLast((item) => sameKey(item, rule))
      return row ? [{ rule, row }] : []
    })
  return (
    <Show when={pairs().length}>
      <ul data-slot="operator-overrides" data-testid="session-overrides">
        <For each={pairs()}>
          {(pair) => (
            <li data-slot="operator-note">
              {language.t("operator.sessionPermissions.overrides", {
                rule: `${pair.rule.permission} ${pair.rule.pattern} ${pair.rule.action}`,
                index: pair.row.index,
                agentRule: `${pair.row.permission} ${pair.row.pattern} ${pair.row.action}`,
              })}
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}
