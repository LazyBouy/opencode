import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "../ui/select"
import type {
  OperatorModelSource,
  OperatorPermissionRow,
  OperatorToolNotSent,
  OperatorToolPrompt,
  OperatorToolPromptLast,
  OperatorToolSent,
  OperatorToolSource,
} from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { formatAgo, formatDateTime } from "../format"
import { DataTable } from "../ui/data-table"
import { Field } from "../ui/field"
import { FieldHelp } from "../ui/field-help"
import { useOriginText } from "../ui/permission-origin"
import { useModelSourceText } from "../ui/prompt-trace"
import { useAgentPromptSetting } from "./agent-prompt"
import { requestError } from "./config-helpers"
import { OPENCODE, PREFIX } from "./profile-model"
import { accessOf, compareNames, type LastTool, lastTools, readableJson } from "./tool-prompt-model"
import { useOverlayParams } from "../ui/overlay-nav"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type RunsAs = "primary" | "subagent" | "session"
type View = "would" | "last"

// The model option that means "whatever the agent uses".
// "Started from": a new session, with no rules of its own.
const NEW_PARENT = "@new"
const AGENT_MODEL = "agent"

// The Tool Prompt tab: the tools list an agent's requests send, each tool with its description and
// schema as sent, the version of its description and its size, and the tools not sent with the
// reason. "Would be sent" is built live from the current settings for a model and a way of running
// (directly, as a subagent, in one of its sessions); "Last sent" is the tools part of the agent's most
// recent real request, as recorded.
export function AgentToolPrompt(props: {
  agent: string
  directory: string
  mode: string
  modelSource?: OperatorModelSource
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const dialog = useDialog()
  const modelText = useModelSourceText()
  const [store, setStore] = createStore({
    model: AGENT_MODEL,
    runsAs: (props.mode === "subagent" ? "subagent" : "primary") as RunsAs,
    session: undefined as string | undefined,
    parent: NEW_PARENT,
    view: "would" as View,
  })
  const number = (value: number) => exact(language, value)

  const providers = useQuery(() => ({
    queryKey: api.key("providers", props.directory),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: props.directory })
        .then((result) => result.data!),
  }))
  const models = createMemo(() => [
    AGENT_MODEL,
    ...(providers.data?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => `${provider.id}/${model.id}`),
    ),
  ])
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "agent", props.directory, props.agent),
    enabled: store.runsAs === "session",
    queryFn: () =>
      api
        .client()
        .operator.session.list({ within: props.directory, agent: props.agent, limit: "100" })
        .then((result) => result.data ?? []),
  }))
  const session = () => (store.runsAs === "session" ? (store.session ?? sessions.data?.[0]?.id) : undefined)
  // Runs as Subagent: the session that starts it (any agent's, in this project), or a new one.
  const parents = useQuery(() => ({
    queryKey: api.key("sessions", "project", props.directory),
    enabled: store.runsAs === "subagent",
    queryFn: () =>
      api
        .client()
        .operator.session.list({ within: props.directory, limit: "100" })
        .then((result) => (result.data ?? []).filter((item) => !item.parentID)),
  }))
  const parent = () => (store.runsAs === "subagent" && store.parent !== NEW_PARENT ? store.parent : undefined)

  const prompt = useQuery(() => ({
    queryKey: api.key("tool-prompt", props.directory, props.agent, store.model, store.runsAs, session(), parent()),
    enabled: store.runsAs !== "session" || !!session(),
    queryFn: () =>
      api
        .client()
        .operator.toolPrompt.get({
          name: props.agent,
          directory: props.directory,
          ...(store.model === AGENT_MODEL ? {} : { model: store.model }),
          ...(store.runsAs === "session" ? { session: session() } : { runsAs: store.runsAs }),
          ...(parent() ? { parent: parent() } : {}),
        })
        .then((result) => result.data!),
  }))
  const last = useQuery(() => ({
    queryKey: api.key("tool-prompt-last", props.directory, props.agent),
    queryFn: () =>
      api
        .client()
        .operator.toolPrompt.last({ name: props.agent, directory: props.directory })
        .then((result) => result.data ?? { captured: false }),
  }))
  // A new request of this agent is its new Last sent.
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: { agent?: string } } | undefined
    if (details?.type === "operator.call.recorded" && details.properties?.agent === props.agent) void last.refetch()
  })
  onCleanup(stop)
  const view = () => (store.view === "last" && last.data?.captured ? "last" : "would")

  const openTool = (tool: OperatorToolSent, data: OperatorToolPrompt) =>
    void dialog.push(() => (
      <ToolOverlay
        tool={tool}
        prompt={data}
        view={view()}
        last={view() === "last" ? lastTools(last.data?.tools).find((item) => item.name === tool.name) : undefined}
        agent={props.agent}
        directory={props.directory}
      />
    ))

  return (
    <>
      <section data-component="operator-panel" data-testid="tool-prompt-controls">
        <div data-slot="operator-tool-controls">
          <Field group label={language.t("operator.column.model")} hint={language.t("operator.toolPrompt.modelHint")}>
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.column.model")}
              options={models()}
              current={store.model}
              label={(value) =>
                value === AGENT_MODEL
                  ? language.t("operator.prompts.agentModel", { model: props.modelSource?.model ?? "" })
                  : value
              }
              onSelect={(value) => value && setStore("model", value)}
            />
          </Field>
          <Field
            group
            label={language.t("operator.toolPrompt.runsAs")}
            hint={language.t("operator.toolPrompt.runsAsHint")}
          >
            <SegmentedControlV2
              value={store.runsAs}
              class="operator-segmented-fit"
              onChange={(value) => value && setStore("runsAs", value as RunsAs)}
              data-testid="tool-prompt-runs-as"
            >
              <SegmentedControlItemV2 value="primary">
                {language.t("operator.toolPrompt.primary")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="subagent">
                {language.t("operator.toolPrompt.subagent")}
              </SegmentedControlItemV2>
              <SegmentedControlItemV2 value="session">
                {language.t("operator.toolPrompt.inSession")}
              </SegmentedControlItemV2>
            </SegmentedControlV2>
          </Field>
          <Field group label={language.t("operator.toolPrompt.view")} hint={language.t("operator.toolPrompt.viewHint")}>
            <SegmentedControlV2
              value={view()}
              class="operator-segmented-fit"
              onChange={(value) => value && setStore("view", value as View)}
              data-testid="tool-prompt-view"
            >
              <SegmentedControlItemV2 value="would">{language.t("operator.toolPrompt.would")}</SegmentedControlItemV2>
              <SegmentedControlItemV2 value="last" disabled={!last.data?.captured}>
                {language.t("operator.toolPrompt.last")}
              </SegmentedControlItemV2>
            </SegmentedControlV2>
          </Field>
        </div>
        <Show when={store.runsAs === "session"}>
          <Show
            when={sessions.data?.length}
            fallback={
              <p data-slot="operator-note">
                {sessions.isPending ? language.t("common.loading") : language.t("operator.toolPrompt.noSessions")}
              </p>
            }
          >
            <Field
              group
              label={language.t("operator.toolPrompt.session")}
              hint={language.t("operator.toolPrompt.sessionHint")}
            >
              <SelectV2<string>
                appearance="base"
                aria-label={language.t("operator.toolPrompt.session")}
                options={(sessions.data ?? []).map((item) => item.id)}
                current={session()}
                label={(id) => {
                  const found = sessions.data?.find((item) => item.id === id)
                  return found ? `${found.title || id} · ${formatAgo(found.time.updated, language.intl())}` : id
                }}
                onSelect={(id) => id && setStore("session", id)}
              />
            </Field>
          </Show>
        </Show>
        <Show when={store.runsAs === "subagent"}>
          <Field
            group
            label={language.t("operator.toolPrompt.startedFrom")}
            hint={language.t("operator.toolPrompt.subagentNote")}
          >
            <SelectV2<string>
              appearance="base"
              aria-label={language.t("operator.toolPrompt.startedFrom")}
              options={[NEW_PARENT, ...(parents.data ?? []).map((item) => item.id)]}
              current={store.parent}
              label={(id) => {
                if (id === NEW_PARENT) return language.t("operator.toolPrompt.startedFromNew")
                const found = parents.data?.find((item) => item.id === id)
                return found
                  ? `${found.title || id} · ${found.agent ?? ""} · ${formatAgo(found.time.updated, language.intl())}`
                  : id
              }}
              onSelect={(id) => id && setStore("parent", id)}
            />
          </Field>
        </Show>
        <Show when={!last.data?.captured && !last.isPending}>
          <p data-slot="operator-note" data-testid="tool-prompt-not-captured">
            {language.t("operator.toolPrompt.notCaptured")}
          </p>
        </Show>
        <Show when={view() === "would" && prompt.data?.modelSource}>
          {(source) => (
            <p data-slot="operator-note">
              {language.t("operator.prompts.modelFrom", { model: source().model, source: modelText(source()) })}
            </p>
          )}
        </Show>
      </section>

      <Show when={prompt.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(prompt.error)}
        </pre>
        <p data-slot="operator-note">{language.t("operator.prompts.previewFailed")}</p>
      </Show>

      <Show when={prompt.data}>
        {(data) => (
          <Show
            when={view() === "last" && last.data?.captured ? last.data : undefined}
            fallback={<WouldBeSent data={data()} agent={props.agent} onOpen={(tool) => openTool(tool, data())} />}
          >
            {(found) => (
              <LastSent last={found()} would={data()} onOpen={(tool) => openTool(tool, data())} number={number} />
            )}
          </Show>
        )}
      </Show>

      <details data-slot="operator-details" data-testid="tool-prompt-changes">
        <summary>{language.t("operator.toolPrompt.changes")}</summary>
        <ul data-component="operator-list">
          <For
            each={
              [
                "operator.toolPrompt.change.deny",
                "operator.toolPrompt.change.task",
                "operator.toolPrompt.change.subagent",
                "operator.toolPrompt.change.model",
                "operator.toolPrompt.change.flags",
                "operator.toolPrompt.change.mcp",
                "operator.toolPrompt.change.versions",
                "operator.toolPrompt.change.switches",
              ] as const
            }
          >
            {(key) => <li>{language.t(key)}</li>}
          </For>
        </ul>
        <p data-slot="operator-note">{language.t("operator.toolPrompt.patterns")}</p>
      </details>
    </>
  )
}

// Would be sent: the summary, the tools sent, the tools not sent, and the whole list as JSON.
function WouldBeSent(props: { data: OperatorToolPrompt; agent: string; onOpen: (tool: OperatorToolSent) => void }) {
  const language = useLanguage()
  const sourceText = useSourceText()
  const versionText = useVersionText()
  const accessText = useAccessText()
  const whyText = useWhyText()
  const number = (value: number) => exact(language, value)
  const rowsOf = (tool: OperatorToolSent) => props.data.rows.filter((row) => tool.rules.includes(row.index))

  return (
    <>
      <p data-slot="operator-note" data-testid="tool-prompt-summary">
        {language.t("operator.toolPrompt.summary", {
          count: props.data.sent.length,
          chars: number(props.data.sizes.total),
          description: number(props.data.sizes.description),
          schema: number(props.data.sizes.schema),
          tokens: number(props.data.sizes.tokens),
          notSent: props.data.notSent.length,
        })}
        <FieldHelp field={language.t("operator.toolPrompt.tokens")} text={language.t("operator.help.toolTokens")} />
      </p>

      <section data-component="operator-panel">
        <h2 data-slot="operator-panel-title">{language.t("operator.toolPrompt.sent")}</h2>
        <DataTable
          columnsKey="tool-prompt-sent"
          label={language.t("operator.toolPrompt.sent")}
          rows={props.data.sent}
          onRowClick={props.onOpen}
          columns={[
            {
              id: "tool",
              header: language.t("operator.toolPrompt.column.tool"),
              help: language.t("operator.help.toolName"),
              cell: (tool) => <code>{tool.name}</code>,
              value: (tool) => tool.name,
            },
            {
              id: "source",
              optional: true,
              hidden: true,
              header: language.t("operator.column.source"),
              help: language.t("operator.help.toolPromptSource"),
              cell: (tool) => sourceText(tool.source),
              value: (tool) => sourceText(tool.source),
            },
            {
              id: "version",
              optional: true,
              header: language.t("operator.toolPrompt.column.version"),
              help: language.t("operator.help.toolVersion"),
              cell: (tool) => (
                <span class="inline-flex items-center gap-1 flex-wrap">
                  {versionText(tool)}
                  <Show when={tool.version.fixedTemplate}>
                    <Tag data-warning="">{language.t("operator.toolPrompt.fixedTemplate")}</Tag>
                  </Show>
                </span>
              ),
              value: (tool) => versionText(tool),
            },
            {
              id: "appended",
              optional: true,
              header: language.t("operator.toolPrompt.column.appended"),
              help: language.t("operator.help.toolAppended"),
              cell: (tool) => appendedText(language, tool),
              value: (tool) => appendedText(language, tool),
            },
            {
              id: "description",
              optional: true,
              hidden: true,
              header: language.t("operator.toolPrompt.column.description"),
              help: language.t("operator.help.toolDescriptionSize"),
              align: "end",
              cell: (tool) => number(tool.sizes.description),
              value: (tool) => tool.sizes.description,
            },
            {
              id: "schema",
              optional: true,
              hidden: true,
              header: language.t("operator.toolPrompt.column.schema"),
              help: language.t("operator.help.toolSchemaSize"),
              align: "end",
              cell: (tool) => number(tool.sizes.schema),
              value: (tool) => tool.sizes.schema,
            },
            {
              id: "total",
              header: language.t("operator.toolPrompt.column.total"),
              help: language.t("operator.help.toolTotal"),
              align: "end",
              cell: (tool) =>
                language.t("operator.toolPrompt.size", {
                  chars: number(tool.sizes.total),
                  tokens: number(tool.sizes.tokens),
                }),
              value: (tool) => tool.sizes.total,
            },
            {
              id: "access",
              header: language.t("operator.toolPrompt.column.access"),
              help: language.t("operator.help.toolAccess"),
              cell: (tool) => accessText(rowsOf(tool)),
              value: (tool) => accessText(rowsOf(tool)),
            },
          ]}
        />
      </section>

      <section data-component="operator-panel" data-testid="tool-prompt-not-sent">
        <h2 data-slot="operator-panel-title">{language.t("operator.toolPrompt.notSent")}</h2>
        <DataTable
          columnsKey="tool-prompt-not-sent"
          label={language.t("operator.toolPrompt.notSent")}
          rows={props.data.notSent}
          empty={language.t("operator.toolPrompt.allSent")}
          columns={[
            {
              id: "tool",
              header: language.t("operator.toolPrompt.column.tool"),
              help: language.t("operator.help.toolName"),
              cell: (tool) => <code>{tool.name}</code>,
              value: (tool) => tool.name,
            },
            {
              id: "why",
              header: language.t("operator.toolPrompt.column.why"),
              help: language.t("operator.help.toolWhy"),
              cell: (tool) => language.t(`operator.toolPrompt.reason.${tool.reason}` as Key),
              value: (tool) => tool.reason,
            },
            {
              id: "detail",
              header: language.t("operator.toolPrompt.column.detail"),
              help: language.t("operator.help.toolWhyDetail"),
              cell: (tool) => whyText(tool, props.data),
            },
          ]}
        />
      </section>

      <AsSent
        testid="tool-prompt-json"
        title={language.t("operator.toolPrompt.overall")}
        hint={language.t("operator.toolPrompt.overallHint")}
        raw={JSON.stringify(props.data.list)}
      />
    </>
  )
}

// Last sent: the tools part of the agent's newest request, exactly as recorded.
function LastSent(props: {
  last: OperatorToolPromptLast
  would: OperatorToolPrompt
  onOpen: (tool: OperatorToolSent) => void
  number: (value: number) => string
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const tools = createMemo(() => lastTools(props.last.tools))
  const chars = () => tools().reduce((sum, item) => sum + item.chars, 0)
  const compared = createMemo(() =>
    compareNames(
      props.would.sent.map((item) => item.name),
      tools().map((item) => item.name),
    ),
  )
  return (
    <>
      <p data-slot="operator-note" data-testid="tool-prompt-summary">
        {language.t("operator.toolPrompt.lastSummary", {
          count: tools().length,
          bytes: props.number(props.last.bytes ?? 0),
          format: props.last.format ?? "",
          tokens: props.number(Math.ceil(chars() / 4)),
        })}
        <Show when={props.last.inputTokens !== undefined}>
          {" · "}
          {language.t("operator.toolPrompt.inputTokens", { count: props.number(props.last.inputTokens ?? 0) })}
        </Show>
      </p>
      <p data-slot="operator-note">
        {language.t("operator.toolPrompt.lastAt", {
          time: formatDateTime(props.last.at, language.intl()),
          model: props.last.model ?? "",
        })}{" "}
        <Show when={props.last.sessionID}>
          {(id) => (
            <button
              type="button"
              data-slot="operator-link"
              onClick={() => navigate(`/operator/sessions?session=${encodeURIComponent(id())}`)}
            >
              {language.t("operator.toolPrompt.openSession")}
            </button>
          )}
        </Show>
      </p>
      <p data-slot="operator-note" data-testid="tool-prompt-compare">
        <Show
          when={compared().onlyWould.length || compared().onlyLast.length}
          fallback={language.t("operator.toolPrompt.sameTools")}
        >
          {language.t("operator.toolPrompt.differs", {
            last: compared().onlyLast.join(", ") || "—",
            would: compared().onlyWould.join(", ") || "—",
          })}
        </Show>
      </p>
      <Show
        when={props.last.tools}
        fallback={<p data-slot="operator-note">{language.t("operator.toolPrompt.noTools")}</p>}
      >
        <section data-component="operator-panel">
          <h2 data-slot="operator-panel-title">{language.t("operator.toolPrompt.sent")}</h2>
          <DataTable
            columnsKey="tool-prompt-last"
            label={language.t("operator.toolPrompt.sent")}
            rows={tools()}
            onRowClick={(item: LastTool) => {
              const found = props.would.sent.find((tool) => tool.name === item.name)
              if (found) props.onOpen(found)
            }}
            columns={[
              {
                id: "tool",
                header: language.t("operator.toolPrompt.column.tool"),
                help: language.t("operator.help.toolName"),
                cell: (item) => <code>{item.name}</code>,
                value: (item) => item.name,
              },
              {
                id: "total",
                header: language.t("operator.toolPrompt.column.asSent"),
                help: language.t("operator.help.toolAsSent"),
                align: "end",
                cell: (item) =>
                  language.t("operator.toolPrompt.size", {
                    chars: props.number(item.chars),
                    tokens: props.number(Math.ceil(item.chars / 4)),
                  }),
                value: (item) => item.chars,
              },
            ]}
          />
        </section>
        <AsSent
          testid="tool-prompt-json"
          title={language.t("operator.toolPrompt.overall")}
          hint={language.t("operator.toolPrompt.lastHint")}
          raw={props.last.tools ?? ""}
        />
      </Show>
    </>
  )
}

// One tool, in an overlay over the agent's: exactly as sent, its description in parts with where each
// comes from, its schema, and the rules for its permission.
function ToolOverlay(props: {
  tool: OperatorToolSent
  prompt: OperatorToolPrompt
  view: View
  last?: LastTool
  agent: string
  directory: string
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [, setParams] = useOverlayParams<{ atab?: string; aperm?: string; aedit?: string }>()
  const origin = useOriginText()
  const sourceText = useSourceText()
  const number = (value: number) => exact(language, value)
  const setting = useAgentPromptSetting(
    () => props.agent,
    () => props.directory,
  )
  const rows = () => props.prompt.rows.filter((row) => props.tool.rules.includes(row.index))
  const decisive = () => rows().at(-1)?.index
  // This tool's entry exactly as sent (in the view's format).
  const entry = () =>
    props.view === "last"
      ? props.last
        ? JSON.stringify(props.last.entry)
        : undefined
      : JSON.stringify(props.prompt.list.find((item) => item.name === props.tool.name))
  // The text's layer: the copy or namespace version, else OpenCode's built-in (in OpenCode's namespace).
  const wording = () => {
    const ns = setting.data?.namespace.id
    const layer = props.tool.version.layer
    if (layer && ns)
      return `/operator/profile?ns=${encodeURIComponent(ns)}&tab=layers&layer=${encodeURIComponent(layer)}&rns=${encodeURIComponent(ns)}`
    return `/operator/profile?ns=${OPENCODE}&tab=layers&layer=${encodeURIComponent(`${PREFIX}tool.${props.tool.name}`)}`
  }
  const versioned = () => props.tool.version.kind !== "none"

  return (
    <Dialog size="x-large">
      <DialogHeader>
        <DialogTitle>
          <span class="inline-flex items-center gap-2">
            <code>{props.tool.name}</code>
            <Tag>{sourceText(props.tool.source)}</Tag>
          </span>
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div data-slot="operator-tool-overlay" data-testid="tool-overlay">
          <Show
            when={entry()}
            fallback={<p data-slot="operator-note">{language.t("operator.toolPrompt.notInLast")}</p>}
          >
            {(text) => (
              <AsSent
                title={language.t(
                  props.view === "last" ? "operator.toolPrompt.asLastSent" : "operator.toolPrompt.asSent",
                )}
                raw={text()}
              />
            )}
          </Show>

          <section data-component="operator-panel" data-testid="tool-overlay-text">
            <h3 data-slot="operator-panel-title">
              {language.t("operator.toolPrompt.part.text")}
              <span data-slot="operator-note">
                {" "}
                {language.t("operator.prompts.chars", { count: number(props.tool.versionText.length) })}
              </span>
            </h3>
            <Steps lines={versionSteps(language, props.tool)} />
            <Show when={props.tool.version.fixedTemplate}>
              <p data-slot="operator-note" data-warning="">
                {language.t("operator.toolPrompt.fixedTemplateHint")}
              </p>
            </Show>
            <pre data-component="operator-code">{props.tool.versionText}</pre>
          </section>

          <Show when={props.tool.appended}>
            {(appended) => (
              <section data-component="operator-panel" data-testid="tool-overlay-appended">
                <h3 data-slot="operator-panel-title">
                  {language.t("operator.toolPrompt.part.appended")}
                  <span data-slot="operator-note">
                    {" "}
                    {language.t("operator.prompts.chars", { count: number(appended().text.length) })}
                  </span>
                </h3>
                <Show
                  when={appended().kind === "subagents"}
                  fallback={<p data-slot="operator-note">{language.t("operator.toolPrompt.appended.mcp")}</p>}
                >
                  <p data-slot="operator-note">{language.t("operator.toolPrompt.appended.subagentsHint")}</p>
                  <ul data-component="operator-list">
                    <For each={appended().subagents ?? []}>
                      {(item) => (
                        <li data-kept={item.kept ? "" : undefined}>
                          <code>{item.name}</code>{" "}
                          {item.rule !== undefined
                            ? language.t(
                                item.kept
                                  ? "operator.toolPrompt.subagentKeptBy"
                                  : "operator.toolPrompt.subagentDroppedBy",
                                { rule: item.rule },
                              )
                            : language.t(
                                item.kept ? "operator.toolPrompt.subagentKept" : "operator.toolPrompt.subagentDropped",
                              )}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <pre data-component="operator-code">{appended().text}</pre>
              </section>
            )}
          </Show>

          <Show when={props.tool.note}>
            {(note) => (
              <section data-component="operator-panel" data-testid="tool-overlay-note">
                <h3 data-slot="operator-panel-title">
                  {language.t("operator.toolPrompt.part.note")}
                  <span data-slot="operator-note">
                    {" "}
                    {language.t("operator.prompts.chars", { count: number(note().size) })}
                  </span>
                </h3>
                <p data-slot="operator-note">{language.t("operator.toolPrompt.noteHint")}</p>
                <pre data-component="operator-code">{note().text}</pre>
              </section>
            )}
          </Show>

          <section data-component="operator-panel">
            <h3 data-slot="operator-panel-title">
              {language.t("operator.toolPrompt.part.schema")}
              <span data-slot="operator-note">
                {" "}
                {language.t("operator.prompts.chars", { count: number(props.tool.sizes.schema) })}
              </span>
            </h3>
            <Show when={props.tool.rewrite}>
              {(code) => <p data-slot="operator-note">{language.t(`operator.toolPrompt.rewrite.${code()}` as Key)}</p>}
            </Show>
            <Show when={props.tool.strict === false}>
              <p data-slot="operator-note">{language.t("operator.toolPrompt.strict")}</p>
            </Show>
            <pre data-component="operator-code">{JSON.stringify(props.tool.schema, null, 2)}</pre>
          </section>

          <section data-component="operator-panel" data-testid="tool-overlay-rules">
            <h3 data-slot="operator-panel-title">
              {language.t("operator.toolPrompt.rules", { permission: props.tool.permission })}
            </h3>
            <p data-slot="operator-note">{language.t("operator.toolPrompt.rulesHint")}</p>
            <DataTable
              label={language.t("operator.toolPrompt.rules", { permission: props.tool.permission })}
              rows={rows()}
              empty={language.t("operator.toolPrompt.noRules")}
              columns={[
                {
                  id: "index",
                  header: "#",
                  width: "48px",
                  cell: (row: OperatorPermissionRow) => row.index,
                },
                {
                  id: "permission",
                  header: language.t("operator.column.permission"),
                  cell: (row) => <code>{row.permission}</code>,
                },
                {
                  id: "pattern",
                  header: language.t("operator.column.pattern"),
                  cell: (row) => <code>{row.pattern}</code>,
                },
                {
                  id: "action",
                  header: language.t("operator.column.action"),
                  cell: (row) => (
                    <span class="inline-flex items-center gap-1">
                      <Tag variant={row.action === "allow" ? "accent" : "neutral"}>
                        {language.t(`operator.permission.action.${row.action}`)}
                      </Tag>
                      <Show when={row.index === decisive()}>
                        <Tag data-testid="decisive-rule">{language.t("operator.toolPrompt.decides")}</Tag>
                      </Show>
                    </span>
                  ),
                },
                {
                  id: "from",
                  header: language.t("operator.toolPrompt.column.from"),
                  help: language.t("operator.help.ruleFrom"),
                  cell: (row) => origin(row.from),
                },
              ]}
            />
          </section>

          <div class="flex items-center gap-2 flex-wrap">
            <Show when={versioned()}>
              <ButtonV2
                size="small"
                variant="outline"
                onClick={() => {
                  dialog.close()
                  navigate(wording())
                }}
              >
                {language.t("operator.toolPrompt.changeWording")}
              </ButtonV2>
            </Show>
            <ButtonV2
              size="small"
              variant="outline"
              onClick={() => {
                dialog.close()
                // Built for one of the agent's sessions: that session's own rules, else the agent's.
                const session = props.prompt.runsAs === "session" ? props.prompt.sessionID : undefined
                if (session)
                  return navigate(
                    `/operator/sessions?session=${encodeURIComponent(session)}&stab=permissions&sperm=${encodeURIComponent(props.tool.permission)}`,
                  )
                setParams({ atab: "permissions", aperm: props.tool.permission, aedit: "1" })
              }}
            >
              {language.t("operator.toolPrompt.changeAccess")}
            </ButtonV2>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

// Something exactly as sent, collapsed until opened: Read lays the JSON out for reading (line breaks
// in texts shown as lines), Raw shows the exact text with its `\n`s. Copy copies what is shown.
function AsSent(props: { title: string; hint?: string; raw: string; testid?: string }) {
  const language = useLanguage()
  const [mode, setMode] = createSignal<"read" | "raw">("read")
  const readable = createMemo(() => {
    try {
      return readableJson(JSON.parse(props.raw))
    } catch {
      return props.raw
    }
  })
  const shown = () => (mode() === "raw" ? props.raw : readable())
  return (
    <details data-component="operator-panel" data-slot="operator-as-sent" data-testid={props.testid}>
      <summary>
        <span data-slot="operator-panel-title">{props.title}</span>
        <span data-slot="operator-note">
          {language.t("operator.toolPrompt.characters", {
            count: new Intl.NumberFormat(language.intl()).format(props.raw.length),
          })}
        </span>
      </summary>
      <div data-slot="operator-as-sent-tools">
        <SegmentedControlV2
          class="operator-segmented-fit"
          value={mode()}
          onChange={(value) => value && setMode(value as "read" | "raw")}
          aria-label={language.t("operator.toolPrompt.format")}
        >
          <SegmentedControlItemV2 value="read">{language.t("operator.toolPrompt.read")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="raw">{language.t("operator.toolPrompt.raw")}</SegmentedControlItemV2>
        </SegmentedControlV2>
        <ButtonV2 size="small" variant="outline" onClick={() => copyText(language, shown())}>
          {language.t("operator.toolPrompt.copy")}
        </ButtonV2>
      </div>
      <Show when={props.hint}>
        <p data-slot="operator-note">{props.hint}</p>
      </Show>
      <pre data-component="operator-code" data-mode={mode()}>
        {shown()}
      </pre>
    </details>
  )
}

// Lines of where a text comes from, in the Sys Prompt tab's style.
function Steps(props: { lines: ReadonlyArray<string> }) {
  const language = useLanguage()
  return (
    <div data-slot="operator-trace" data-testid="tool-trace">
      <strong>{language.t("operator.trace.resolvedFrom")}</strong>
      <ol>
        <For each={props.lines}>{(line) => <li>{line}</li>}</For>
      </ol>
    </div>
  )
}

type Language = ReturnType<typeof useLanguage>

// Where the description's own text comes from: the version, then its file or template.
function versionSteps(language: Language, tool: OperatorToolSent): string[] {
  const version = tool.version
  if (version.kind === "copy")
    return [
      language.t("operator.toolPrompt.step.copy", { name: version.name ?? "", profile: version.profile ?? "" }),
      language.t(version.override ? "operator.toolPrompt.step.override" : "operator.toolPrompt.step.slot"),
    ]
  if (version.kind === "namespace")
    return [language.t("operator.toolPrompt.step.namespace", { name: version.name ?? "" })]
  if (version.kind === "opencode") {
    const lines = [language.t("operator.toolPrompt.step.opencode")]
    if (version.template)
      lines.push(
        language.t("operator.toolPrompt.step.template", {
          path: version.template.file,
          values: Object.entries(version.template.values)
            .map(([key, value]) => `${key} ${value}`)
            .join(", "),
        }),
      )
    else if (version.file) lines.push(language.t("operator.trace.file", { path: version.file }))
    return lines
  }
  const source = tool.source
  if (source.kind === "mcp") return [language.t("operator.toolPrompt.step.mcp", { server: source.server ?? "" })]
  if (source.kind === "file") return [language.t("operator.toolPrompt.step.file", { path: source.path ?? "" })]
  if (source.kind === "plugin") return [language.t("operator.toolPrompt.step.plugin")]
  if (source.kind === "noop") return [language.t("operator.toolPrompt.step.noop")]
  return [language.t("operator.toolPrompt.step.mcpResources")]
}

function appendedText(language: Language, tool: OperatorToolSent) {
  if (!tool.appended) return ""
  if (tool.appended.kind === "mcp-catalog") return language.t("operator.toolPrompt.appended.catalog")
  return language.t("operator.toolPrompt.appended.subagents", {
    count: (tool.appended.subagents ?? []).filter((item) => item.kept).length,
  })
}

function useSourceText() {
  const language = useLanguage()
  return (source: OperatorToolSource) => {
    if (source.kind === "file") return language.t("operator.toolPrompt.source.file", { path: source.path ?? "" })
    if (source.kind === "mcp") return language.t("operator.toolPrompt.source.mcp", { server: source.server ?? "" })
    return language.t(`operator.toolPrompt.source.${source.kind}` as Key)
  }
}

function useVersionText() {
  const language = useLanguage()
  return (tool: OperatorToolSent) => {
    const version = tool.version
    if (version.kind === "copy")
      return language.t(
        version.override ? "operator.toolPrompt.version.copyOverride" : "operator.toolPrompt.version.copy",
        {
          name: version.name ?? "",
          profile: version.profile ?? "",
        },
      )
    if (version.kind === "namespace")
      return language.t("operator.toolPrompt.version.namespace", { name: version.name ?? "" })
    return language.t(`operator.toolPrompt.version.${version.kind}` as Key)
  }
}

// The call-time rules of a tool, in a few words: "allowed · asks for *.env, *.env.*".
function useAccessText() {
  const language = useLanguage()
  return (rows: ReadonlyArray<OperatorPermissionRow>) => {
    const access = accessOf(rows)
    return [
      language.t(`operator.toolPrompt.access.${access.every}` as Key),
      ...access.exceptions.map((item) =>
        language.t(`operator.toolPrompt.access.except.${item.action}` as Key, { patterns: item.patterns.join(", ") }),
      ),
    ].join(" · ")
  }
}

// Why a tool is not sent, in detail: the rule and where it comes from, or the model or flag.
function useWhyText() {
  const language = useLanguage()
  const origin = useOriginText()
  return (tool: OperatorToolNotSent, prompt: OperatorToolPrompt): JSX.Element => {
    const row = tool.rule !== undefined ? prompt.rows.find((item) => item.index === tool.rule) : undefined
    if (row) {
      const rule = language.t("operator.toolPrompt.rule", {
        index: row.index,
        rule: `${row.permission} ${row.pattern} ${row.action}`,
      })
      if (tool.reason === "subagent")
        return row.permission === "task" || row.permission === "todowrite"
          ? language.t("operator.toolPrompt.why.subagent", { rule, agent: prompt.agent, permission: row.permission })
          : language.t("operator.toolPrompt.why.primaryTools", { rule })
      return language.t("operator.toolPrompt.why.rule", { rule, from: origin(row.from) })
    }
    if (tool.code) {
      const key = `operator.toolPrompt.notSent.${tool.code}` as Key
      const text = language.t(key)
      if (text !== key) return text
    }
    return tool.detail ?? ""
  }
}

// Sizes in full ("21,500"), not abbreviated: they are compared with each other.
function exact(language: Language, value: number) {
  return new Intl.NumberFormat(language.intl()).format(value)
}

function copyText(language: Language, text: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() =>
      showToast({ variant: "success", icon: "circle-check", title: language.t("operator.toolPrompt.copied") }),
    )
    .catch(() => showToast({ title: language.t("operator.toolPrompt.copyFailed") }))
}
