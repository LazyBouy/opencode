import { useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import type { OperatorAgentPermissions, OperatorPermissionRow } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { LineMarks, PermissionEditor, savedLines, useChangedText } from "../ui/permission-editor"
import { PermissionImpact } from "../ui/permission-impact"
import { useOriginText } from "../ui/permission-origin"
import { orderCheck, type Rule } from "../ui/rules"
import { requestError } from "./config-helpers"

type Scope = "project" | "global"

// An agent's permissions for its editors: the full list with origins, its own rules as written, and
// the file a save writes at each scope.
export function useAgentPermissions(agent: () => string, directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("agent-permissions", directory(), agent()),
    enabled: !!directory() && !!agent(),
    queryFn: () =>
      api
        .client()
        .operator.agentPermissions.get({ name: agent(), directory: directory() })
        .then((result) => result.data!),
  }))
}

// After an agent's rules or settings are saved: everything that shows them refreshes.
export function useRefreshAgent() {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  return (directory: string) =>
    Promise.all(
      ["agents", "agent-permissions", "tool-prompt", "tool-prompt-draft", "prompt-preview", "agent-prompt"].map(
        (part) => queryClient.invalidateQueries({ queryKey: api.key(part, directory) }),
      ),
    )
}

// Asks before a save that groups rules by permission in a way that changes what they decide.
export function useConfirmOrder() {
  const language = useLanguage()
  const confirm = useConfirm()
  return (rules: ReadonlyArray<Rule>) => {
    const check = orderCheck(rules)
    if (!check.changed.length) return Promise.resolve(false)
    return confirm({
      title: language.t("operator.agentPermissions.confirmOrderTitle"),
      description: language.t("operator.agentPermissions.confirmOrderBody"),
      confirm: language.t("operator.agentPermissions.confirmOrder"),
    }).then((ok) => (ok ? true : undefined))
  }
}

// The agent's Permissions tab: the full list, each rule with where it comes from; "Edit permissions"
// turns it into the editor, which changes and saves only the agent's own rules. `aedit` in the URL is
// edit mode, `aperm` the permission it is filtered to.
export function AgentPermissions(props: { agent: string; directory: string }) {
  const language = useLanguage()
  const [params, setParams] = useSearchParams<{ aedit?: string; aperm?: string }>()
  const info = useAgentPermissions(
    () => props.agent,
    () => props.directory,
  )
  const origin = useOriginText()
  const changedText = useChangedText()
  const shown = (rule: { permission: string }) =>
    !params.aperm || rule.permission === params.aperm || rule.permission.includes("*")
  // A line's origin: the agent's change on a rule from elsewhere, else where its rule comes from.
  const fromOf = (
    rows: ReadonlyArray<OperatorPermissionRow>,
    own: { start: number },
    line: ReturnType<typeof savedLines>[number],
  ) =>
    line.kind === "locked"
      ? line.own !== undefined
        ? changedText("agent", line.row!, rows[own.start + line.own]!.from)
        : origin(line.row!.from)
      : origin(rows[own.start + line.own!]!.from)

  return (
    <Show
      when={info.data}
      fallback={
        <Show when={info.error} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
          <pre data-slot="operator-error" role="alert">
            {requestError(info.error)}
          </pre>
        </Show>
      }
    >
      {(data) => (
        <Show
          when={params.aedit === "1"}
          fallback={
            <>
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <p data-slot="operator-note">{language.t("operator.permissionEditor.order")}</p>
                <ButtonV2 size="small" variant="outline" onClick={() => setParams({ aedit: "1" })}>
                  {language.t("operator.agentPermissions.edit")}
                </ButtonV2>
              </div>
              <Show when={params.aperm}>
                <p data-slot="operator-note">
                  {language.t("operator.permissionEditor.filtered", { permission: params.aperm ?? "" })}{" "}
                  <button type="button" data-slot="operator-link" onClick={() => setParams({ aperm: undefined })}>
                    {language.t("operator.permissionEditor.showAll")}
                  </button>
                </p>
              </Show>
              <DataTable
                columnsKey="agent-permissions"
                label={language.t("operator.agent.tab.permissions")}
                rows={savedLines(data().rows, data().own).filter((line) => shown(line.rule))}
                empty={language.t("operator.agent.noRules")}
                columns={[
                  {
                    id: "index",
                    header: "#",
                    help: language.t("operator.help.ruleNumber"),
                    width: "48px",
                    cell: (line) => line.number,
                    value: (line) => line.number,
                  },
                  {
                    id: "permission",
                    header: language.t("operator.column.permission"),
                    cell: (line) => <code>{line.rule.permission}</code>,
                    value: (line) => line.rule.permission,
                  },
                  {
                    id: "pattern",
                    header: language.t("operator.column.pattern"),
                    cell: (line) => <code>{line.rule.pattern}</code>,
                    value: (line) => line.rule.pattern,
                  },
                  {
                    id: "action",
                    header: language.t("operator.column.action"),
                    cell: (line) => (
                      <Tag variant={line.rule.action === "allow" ? "accent" : "neutral"}>
                        {language.t(`operator.permission.action.${line.rule.action}`)}
                      </Tag>
                    ),
                    value: (line) => line.rule.action,
                  },
                  {
                    id: "from",
                    header: language.t("operator.toolPrompt.column.from"),
                    help: language.t("operator.help.ruleFrom"),
                    cell: (line) => (
                      <span class="inline-flex items-center gap-1 flex-wrap">
                        {fromOf(data().rows, data().own, line)}
                        <LineMarks line={line} />
                      </span>
                    ),
                    value: (line) => String(fromOf(data().rows, data().own, line)),
                  },
                ]}
              />
            </>
          }
        >
          <AgentPermissionsEditor
            agent={props.agent}
            directory={props.directory}
            info={data()}
            filter={params.aperm}
            onClearFilter={() => setParams({ aperm: undefined })}
            onDone={() => setParams({ aedit: undefined })}
          />
        </Show>
      )}
    </Show>
  )
}

// Edit mode: the editor with its impact panel, where it saves, Cancel and Save.
function AgentPermissionsEditor(props: {
  agent: string
  directory: string
  info: OperatorAgentPermissions
  filter?: string
  onClearFilter: () => void
  onDone: () => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const refresh = useRefreshAgent()
  const confirmOrder = useConfirmOrder()
  const [store, setStore] = createStore({
    rules: [] as Rule[],
    scope: "project" as Scope,
    saving: false,
    error: "",
  })
  const saved = createMemo(() => JSON.stringify(props.info.written))
  createEffect(on(saved, () => setStore("rules", reconcile(props.info.written.map((rule) => ({ ...rule }))))))
  const dirty = () => JSON.stringify(store.rules) !== saved()
  const target = () => props.info.targets[store.scope]
  const duplicates = () => orderCheck(store.rules).duplicates.length > 0
  const others = () => props.info.alsoIn.filter((path) => path !== target().path)

  const save = async () => {
    const confirmed = await confirmOrder(store.rules)
    if (confirmed === undefined) return
    setStore({ saving: true, error: "" })
    await api
      .client()
      .operator.agentPermissions.save({
        name: props.agent,
        directory: props.directory,
        scope: store.scope,
        rules: store.rules,
        ...(confirmed ? { confirmOrder: true } : {}),
      })
      .then(async (result) => {
        showToast({
          title: language.t("operator.agentPermissions.saved", { path: shortPath(result.data?.path ?? "") }),
        })
        await refresh(props.directory)
        props.onDone()
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("saving", false))
  }

  return (
    <div data-slot="operator-permission-edit" data-testid="agent-permissions-edit">
      <Show when={target().kind === "config"}>
        <Field
          group
          label={language.t("operator.agentPermissions.scope")}
          hint={language.t("operator.agentPermissions.scopeHint")}
        >
          <SegmentedControlV2
            class="operator-segmented-fit"
            value={store.scope}
            onChange={(value) => value && setStore("scope", value as Scope)}
          >
            <SegmentedControlItemV2 value="project">
              {language.t("operator.agentPermissions.project")}
            </SegmentedControlItemV2>
            <SegmentedControlItemV2 value="global">
              {language.t("operator.agentPermissions.global")}
            </SegmentedControlItemV2>
          </SegmentedControlV2>
        </Field>
      </Show>
      <p data-slot="operator-note" data-testid="agent-permissions-target">
        {target().kind === "file"
          ? language.t("operator.agentPermissions.targetFile", { path: target().path })
          : language.t("operator.agentPermissions.targetConfig", { path: target().path, name: props.agent })}
      </p>
      <Show when={target().tracked}>
        <p data-slot="operator-note" data-warning="">
          {language.t("operator.agentPermissions.tracked")}
        </p>
      </Show>
      <Show when={others().length}>
        <p data-slot="operator-note" data-warning="">
          {language.t("operator.agentPermissions.alsoIn", { paths: others().map(shortPath).join(", ") })}
        </p>
      </Show>
      <div data-slot="operator-permission-layout">
        <PermissionEditor
          mode="agent"
          rows={props.info.rows}
          editable={props.info.own}
          value={store.rules}
          onChange={(rules) => setStore("rules", rules)}
          forms={props.info.forms}
          known={props.info.known}
          filter={props.filter}
          onClearFilter={props.onClearFilter}
        />
        <PermissionImpact agent={props.agent} directory={props.directory} agentRules={store.rules} dirty={dirty()} />
      </div>
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div data-slot="operator-actions">
        <ButtonV2 variant="neutral" onClick={props.onDone}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.saving || !dirty() || duplicates()} onClick={() => void save()}>
          {language.t("operator.agentPermissions.save")}
        </ButtonV2>
      </div>
    </div>
  )
}
