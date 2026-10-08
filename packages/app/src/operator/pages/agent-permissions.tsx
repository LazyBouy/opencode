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
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { LevelEditor, type LevelValue, useLevelText, useLineFrom } from "../ui/level-editor"
import { PermissionImpact } from "../ui/permission-impact"
import { requestError } from "./config-helpers"
import { useOverlayParams } from "../ui/overlay-nav"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { useAgentLocks } from "../ui/permission-locks"

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

// The agent's Permissions tab: the full list, each rule with where it comes from; "Edit permissions"
// turns it into the editor, which changes and saves only the agent's own rules. `aedit` in the URL is
// edit mode, `aperm` the permission it is filtered to.
export function AgentPermissions(props: { agent: string; directory: string }) {
  const language = useLanguage()
  const [params, setParams] = useOverlayParams<{ aedit?: string; aperm?: string }>()
  const info = useAgentPermissions(
    () => props.agent,
    () => props.directory,
  )
  const from = useLineFrom()
  const levelText = useLevelText()
  const locks = useAgentLocks(
    () => props.agent,
    () => props.directory,
  )
  const shown = (rule: { permission: string }) =>
    !params.aperm || rule.permission === params.aperm || rule.permission.includes("*")
  // A line a level above the agent locked: the agent can't lock or change it.
  const above = (row: OperatorPermissionRow) => (row.locked && row.locked !== "agent" ? row.locked : undefined)

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
                <p data-slot="operator-note">{language.t("operator.levels.how")}</p>
                <span class="flex items-center gap-2">
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    data-action="lock-all"
                    onClick={() =>
                      void locks.all(
                        data().levelRows.filter((row) => !above(row)),
                        true,
                      )
                    }
                  >
                    {language.t("operator.locks.lockAll")}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    data-action="unlock-all"
                    onClick={() => void locks.all([], false)}
                  >
                    {language.t("operator.locks.unlockAll")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="outline" onClick={() => setParams({ aedit: "1" })}>
                    {language.t("operator.agentPermissions.edit")}
                  </ButtonV2>
                </span>
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
                rows={data().levelRows.filter((row) => shown(row))}
                empty={language.t("operator.agent.noRules")}
                columns={[
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
                      <Tag variant={row.action === "allow" ? "accent" : "neutral"}>
                        {language.t(`operator.permission.action.${row.action}`)}
                      </Tag>
                    ),
                    value: (row) => row.action,
                  },
                  {
                    id: "override",
                    header: language.t("operator.levels.overridable"),
                    help: language.t("operator.levels.overridableHelp"),
                    cell: (row) => (
                      <Show
                        when={!above(row)}
                        fallback={language.t("operator.levels.lockedBy", { level: levelText(above(row)) })}
                      >
                        <CheckboxV2
                          hideLabel
                          label={language.t("operator.locks.mayOverride", { rule: `${row.permission} ${row.pattern}` })}
                          checked={!locks.locked(row)}
                          onChange={(override: boolean) => void locks.set(row, !override)}
                        />
                      </Show>
                    ),
                    value: (row) => (above(row) || locks.locked(row) ? 0 : 1),
                  },
                  {
                    id: "from",
                    header: language.t("operator.toolPrompt.column.from"),
                    help: language.t("operator.levels.fromHelp"),
                    cell: (row) => from(row),
                    value: (row) => from(row),
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

// Edit mode: the level editor (what the agent inherits, its own lines, its deletions and locks) with its
// impact panel, where it saves, Cancel and Save.
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
  const locks = useAgentLocks(
    () => props.agent,
    () => props.directory,
  )
  const [store, setStore] = createStore({
    value: { lines: [], deleted: [], locks: [] } as LevelValue,
    scope: "project" as Scope,
    saving: false,
    error: "",
  })
  const saved = createMemo(() =>
    JSON.stringify({
      lines: props.info.written,
      deleted: locks.current().deleted ?? [],
      locks: locks.current().locks,
    }),
  )
  createEffect(on(saved, () => setStore("value", reconcile(JSON.parse(saved()) as LevelValue))))
  const dirty = () => JSON.stringify(store.value) !== saved()
  const target = () => props.info.targets[store.scope]
  const others = () => props.info.alsoIn.filter((path) => path !== target().path)

  const save = async () => {
    setStore({ saving: true, error: "" })
    const before = JSON.parse(saved()) as LevelValue
    const rulesChanged = JSON.stringify(store.value.lines) !== JSON.stringify(before.lines)
    const marksChanged =
      JSON.stringify(store.value.deleted) !== JSON.stringify(before.deleted) ||
      JSON.stringify(store.value.locks) !== JSON.stringify(before.locks)
    const rules = rulesChanged
      ? await api
          .client()
          .operator.agentPermissions.save(
            { name: props.agent, directory: props.directory, scope: store.scope, rules: store.value.lines },
            { throwOnError: true },
          )
          .then((result) => result.data)
          .catch((error: unknown) => {
            setStore("error", requestError(error))
            return null
          })
      : undefined
    if (rules === null) return setStore("saving", false)
    if (marksChanged)
      await locks.replace({ ...locks.current(), locks: store.value.locks, deleted: store.value.deleted })
    showToast({
      title: rules
        ? language.t("operator.agentPermissions.saved", { path: shortPath(rules.path) })
        : language.t("operator.levels.saved"),
    })
    await refresh(props.directory)
    setStore("saving", false)
    props.onDone()
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
        <LevelEditor
          level="agent"
          inherited={props.info.inherited}
          ownRows={props.info.levelRows.filter((row) => row.level === "agent")}
          value={store.value}
          onChange={(value) => setStore("value", reconcile(value))}
          canDeleteOpenCode={props.info.canDeleteOpenCode}
          canLock
          forms={props.info.forms}
          known={props.info.known}
          filter={props.filter}
          onClearFilter={props.onClearFilter}
        />
        <PermissionImpact
          agent={props.agent}
          directory={props.directory}
          agentRules={store.value.lines}
          dirty={dirty()}
        />
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
        <ButtonV2 variant="contrast" disabled={store.saving || !dirty()} onClick={() => void save()}>
          {language.t("operator.agentPermissions.save")}
        </ButtonV2>
      </div>
    </div>
  )
}
