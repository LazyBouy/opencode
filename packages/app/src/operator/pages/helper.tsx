import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorHelper, OperatorHelperRun } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { formatAgo, formatCost } from "../format"
import { type Column, DataTable } from "../ui/data-table"
import { useConfirm } from "../ui/confirm"
import { useProjectModels } from "../ui/model-defaults"
import { RecordView } from "../ui/record-overlay"
import { TextCounters } from "../ui/text-counters"
import { Fact } from "./agent"
import { requestError } from "./config-helpers"
import { HelperForm, SYSTEM_ACTIONS } from "./helper-form"
import { useHelpers } from "./helper-data"
import { TriggersView } from "./helper-triggers"
import { useSessionOverlay } from "./session-overlay"
import { useNamespaces } from "./profile-data"

// A helper's record (agent_types_spec.md §4): Overview (its namespace, role, model, limits, whether agents may call
// it, its actions; edited in place), Text (its helper layer: yours edited here; a built-in's on the Prompts page, as
// before) and Runs (§4.7: each run, its session's transcript in the session overlay). Overview also shows its
// triggers (§4.9) with their state and Run now.

export const HELPER_TABS = ["overview", "text", "runs"] as const

/** A helper's model in words: its source, and for Small and Default the model in effect for its namespace. */
export function useHelperModel() {
  const language = useLanguage()
  return (helper: OperatorHelper, effective?: { model?: string; small?: string }) => {
    const model = helper.model
    if (model.source === "pick") return model.model ?? ""
    if (model.source === "chat") return language.t("operator.helper.model.chat")
    const found = model.source === "small" ? effective?.small : effective?.model
    const label = language.t(model.source === "small" ? "operator.helper.model.small" : "operator.helper.model.default")
    return found ? `${label} · ${found}` : label
  }
}

export function HelperDetail(props: { namespace: string; name: string; tab: string; onGone: () => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const helpers = useHelpers(() => props.namespace)
  const namespaces = useNamespaces()
  const current = createMemo(() => ready(helpers)?.find((item) => item.name === props.name))
  const summary = () => namespaces.data?.find((item) => item.namespace.id === props.namespace)
  const chain = useProjectModels(() => summary()?.defaultProject)
  const modelWords = useHelperModel()
  const effective = () => {
    const found = ready(chain)?.chain
    return { model: found?.model.effective.model, small: found?.small.effective.model }
  }
  const [editing, setEditing] = createSignal(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key("helpers") })

  const remove = async (helper: OperatorHelper) => {
    const ok = await confirm({
      title: language.t("operator.helper.deleteTitle", { name: helper.name }),
      description: language.t("operator.helper.deleteBody"),
      confirm: language.t("operator.trash.moveConfirm"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.helper.remove({ ns: helper.namespace, name: helper.name }, { throwOnError: true })
      .then(async () => {
        await refresh()
        props.onGone()
      })
      .catch((error: unknown) => showToast({ title: requestError(error) }))
  }

  return (
    <Show
      when={current()}
      fallback={
        <p data-slot="operator-note">
          {helpers.isPending ? language.t("common.loading") : language.t("operator.helper.notFound")}
        </p>
      }
    >
      {(helper) => (
        <RecordView
          builtin={helper().builtin || undefined}
          title={
            <>
              {helper().name}
              <Tag data-testid="helper-type">{language.t("operator.agents.type.helper")}</Tag>
              <Tag>{summary()?.namespace.name ?? helper().namespace}</Tag>
            </>
          }
          actions={
            <Show when={!helper().builtin && !editing()}>
              <ButtonV2 size="small" variant="outline" onClick={() => setEditing(true)}>
                {language.t("operator.agent.edit")}
              </ButtonV2>
              <ButtonV2 size="small" variant="danger" onClick={() => void remove(helper())}>
                {language.t("operator.agent.delete")}
              </ButtonV2>
            </Show>
          }
        >
          <Show
            when={
              helper().builtin
                ? language.t(`operator.helper.about.${helper().name}` as "operator.helper.about.title")
                : helper().description
            }
          >
            {(text) => <p data-slot="operator-note">{text()}</p>}
          </Show>
          <Show when={helper().replacedBy}>
            {(name) => (
              <p data-slot="operator-note" role="status" data-testid="helper-replaced">
                {language.t("operator.helper.replacedBy", { name: name() })}
              </p>
            )}
          </Show>
          <Switch>
            <Match when={props.tab === "overview" && editing()}>
              <HelperForm
                namespace={helper().namespace}
                helper={helper()}
                onSaved={() => {
                  setEditing(false)
                  showToast({ title: language.t("operator.agentForm.saved", { name: helper().name }) })
                }}
                onCancel={() => setEditing(false)}
              />
            </Match>
            <Match when={props.tab === "overview"}>
              <dl data-component="operator-facts" data-layout="stacked">
                <Fact
                  label={language.t("operator.helper.namespace")}
                  help={language.t("operator.help.helperNamespace")}
                >
                  {summary()?.namespace.name ?? helper().namespace}
                </Fact>
                <Fact label={language.t("operator.helper.roles")} help={language.t("operator.help.helperRoles")}>
                  <Show when={helper().roles.length} fallback={language.t("operator.helper.noRoles")}>
                    <For each={helper().roles}>{(role) => <Tag>{language.t(`operator.helper.role.${role}`)}</Tag>}</For>
                  </Show>
                </Fact>
                <Fact label={language.t("operator.column.model")} help={language.t("operator.help.helperModel")}>
                  <span data-testid="helper-model">{modelWords(helper(), effective())}</span>
                </Fact>
                <Fact
                  label={language.t("operator.helper.steps")}
                  help={language.t("operator.help.helperSteps", { max: 20 })}
                >
                  {helper().steps ?? language.t("operator.helper.oneCall")}
                </Fact>
                <Fact
                  label={language.t("operator.helper.timeout")}
                  help={language.t("operator.help.helperTimeout", { min: 10, max: 600 })}
                >
                  {helper().timeout !== undefined
                    ? language.t("operator.helper.seconds", { count: helper().timeout! })
                    : "—"}
                </Fact>
                <Fact label={language.t("operator.helper.callable")} help={language.t("operator.help.helperCallable")}>
                  <span data-testid="helper-callable">
                    {helper().callable
                      ? helper().usage
                        ? language.t("operator.helper.callableWith", { usage: helper().usage! })
                        : language.t("operator.helper.callableYes")
                      : language.t("operator.helper.callableNo")}
                  </span>
                </Fact>
                <Fact label={language.t("operator.helper.actions")} help={language.t("operator.help.helperActions")}>
                  <Show when={helper().actions.length} fallback={language.t("operator.helper.noActions")}>
                    <span class="flex flex-wrap gap-1" data-testid="helper-actions">
                      <For each={helper().actions}>
                        {(name) => (
                          <Tag>
                            {SYSTEM_ACTIONS.includes(name)
                              ? language.t(`operator.helper.action.${name}` as "operator.helper.action.notify")
                              : name}
                          </Tag>
                        )}
                      </For>
                    </span>
                  </Show>
                </Fact>
                <Fact label={language.t("operator.helper.triggers")} help={language.t("operator.help.helperTriggers")}>
                  <TriggersView helper={helper()} />
                </Fact>
              </dl>
            </Match>
            <Match when={props.tab === "runs"}>
              <HelperRuns helper={helper()} />
            </Match>
            <Match when={props.tab === "text"}>
              <HelperText
                helper={helper()}
                directory={summary()?.defaultProject}
                onOpenPrompts={(path) => navigate(path)}
              />
            </Match>
          </Switch>
        </RecordView>
      )}
    </Show>
  )
}

// A helper's text: yours edited in place (its helper layer); a built-in's shown, with where it is edited.
function HelperText(props: { helper: OperatorHelper; directory?: string; onOpenPrompts: (path: string) => void }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const [text, setText] = createSignal(props.helper.text)
  const [saving, setSaving] = createSignal(false)
  createEffect(
    on(
      () => props.helper.text,
      (next) => setText(next),
    ),
  )
  const dirty = () => text() !== props.helper.text
  const save = async () => {
    setSaving(true)
    await api
      .client()
      .operator.helper.update(
        { ns: props.helper.namespace, name: props.helper.name, text: text() },
        { throwOnError: true },
      )
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("helpers") }))
      .then(() => showToast({ title: language.t("operator.agentForm.saved", { name: props.helper.name }) }))
      .catch((error: unknown) => showToast({ title: requestError(error) }))
      .finally(() => setSaving(false))
  }
  const promptsPath = () => {
    const ns = encodeURIComponent(props.helper.namespace)
    return `/operator/profile?tab=profiles&ns=${ns}&profile=${encodeURIComponent(props.helper.profile)}&rns=${ns}`
  }
  const model = () => (props.helper.model.source === "pick" ? props.helper.model.model : undefined)
  return (
    <Show
      when={!props.helper.builtin}
      fallback={
        <>
          <p data-slot="operator-note">{language.t("operator.helper.builtinText")}</p>
          <div data-slot="operator-actions">
            <ButtonV2 size="small" variant="outline" onClick={() => props.onOpenPrompts(promptsPath())}>
              {language.t("operator.helper.openPrompts")}
            </ButtonV2>
          </div>
          <TextCounters text={props.helper.text} directory={props.directory} />
          <pre data-component="operator-code" data-testid="helper-text">
            {props.helper.text}
          </pre>
        </>
      }
    >
      <TextCounters text={text()} model={model()} directory={props.directory} />
      <TextareaV2
        class="operator-editor"
        rows={14}
        aria-label={language.t("operator.helper.text")}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <div data-slot="operator-actions">
        <ButtonV2 variant="neutral" disabled={!dirty()} onClick={() => setText(props.helper.text)}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!dirty() || saving()} onClick={() => void save()}>
          {language.t("common.save")}
        </ButtonV2>
      </div>
    </Show>
  )
}

// A helper's runs (§4.7), newest first; one with a session opens its transcript in the session overlay.
function HelperRuns(props: { helper: OperatorHelper }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const runs = useQuery(() => ({
    queryKey: api.key("helper-runs", props.helper.namespace, props.helper.name),
    enabled: !props.helper.builtin,
    queryFn: () =>
      api
        .client()
        .operator.helper.runs({ ns: props.helper.namespace, name: props.helper.name })
        .then((result) => result.data ?? []),
  }))
  const open = useSessionOverlay(() =>
    (runs.data ?? []).flatMap((run) => (run.sessionID ? [{ id: run.sessionID, directory: run.project }] : [])),
  )
  const startedBy = (run: OperatorHelperRun) => {
    const by = run.startedBy
    if (by.kind === "agent") return language.t("operator.helper.byAgent", { agent: by.agent ?? "" })
    if (by.kind === "trigger" && by.event) return language.t("operator.helper.byTrigger", { event: by.event })
    return language.t(`operator.helper.by.${by.kind}` as "operator.helper.by.role")
  }
  const duration = (run: OperatorHelperRun) =>
    run.endedAt === undefined
      ? "—"
      : language.t("operator.helper.seconds", { count: Math.round((run.endedAt - run.startedAt) / 100) / 10 })
  const columns: Column<OperatorHelperRun>[] = [
    {
      id: "time",
      header: language.t("operator.helper.runTime"),
      value: (run) => run.startedAt,
      cell: (run) => formatAgo(run.startedAt, language.intl()),
    },
    { id: "startedBy", header: language.t("operator.helper.startedBy"), value: startedBy, cell: startedBy },
    {
      id: "status",
      header: language.t("operator.helper.status"),
      value: (run) => run.status,
      cell: (run) => <Tag data-status={run.status}>{language.t(`operator.helper.runStatus.${run.status}`)}</Tag>,
    },
    {
      id: "duration",
      header: language.t("operator.helper.duration"),
      align: "end",
      value: (run) => (run.endedAt ?? 0) - run.startedAt,
      cell: duration,
    },
    {
      id: "cost",
      header: language.t("operator.column.cost"),
      align: "end",
      value: (run) => run.cost,
      cell: (run) => (run.cost === undefined ? "—" : formatCost(run.cost, language.intl())),
    },
    {
      id: "result",
      header: language.t("operator.helper.result"),
      cell: (run) => <span data-slot="operator-cell-clamp">{run.error ?? run.output ?? ""}</span>,
    },
  ]
  return (
    <Show
      when={!props.helper.builtin}
      fallback={<p data-slot="operator-note">{language.t("operator.helper.builtinRuns")}</p>}
    >
      <p data-slot="operator-note">{language.t("operator.helper.runsNote")}</p>
      <DataTable
        label={language.t("operator.helper.tab.runs")}
        rows={runs.data ?? []}
        columns={columns}
        loading={runs.isPending}
        empty={language.t("operator.helper.noRuns")}
        initialSort={{ column: "time", direction: "desc" }}
        onRowClick={(run) => run.sessionID && open(run.sessionID)}
      />
    </Show>
  )
}
