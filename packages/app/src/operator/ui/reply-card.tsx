import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type {
  OperatorPendingPermission,
  OperatorPermissionDecideInput,
  OperatorPermissionDecideResult,
} from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useQueryClient } from "@tanstack/solid-query"
import { createSignal, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { asList, ready, useOpenSession, useOperatorClient, usePendingPermissions } from "../data"
import { formatAgo, shortPath } from "../format"
import { requestError } from "../pages/config-helpers"
import { FieldHelp } from "./field-help"
import { useOriginText } from "./permission-origin"
import "./record-overlay.css"
import { useProjectConfigWrite } from "./project-config-copy"

export * as OperatorReplyCard from "./reply-card"

export type Via = OperatorPermissionDecideInput["via"]
type Decision = OperatorPermissionDecideInput["decision"]

const ruleText = (rule: { permission: string; pattern: string; action: string }) =>
  `${rule.permission} ${rule.pattern} ${rule.action}`

// The suggested patterns of a request (OpenCode's `always` patterns), else what it asks for.
export const suggested = (item: { request: { always: ReadonlyArray<string>; patterns: ReadonlyArray<string> } }) =>
  item.request.always.length ? [...item.request.always] : [...item.request.patterns]

// Decides a waiting request (fixes_spec.md §3.2) and refreshes what shows it.
export function useDecide() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const write = useProjectConfigWrite()
  return async (
    item: OperatorPendingPermission,
    input: OperatorPermissionDecideInput,
  ): Promise<OperatorPermissionDecideResult | undefined> => {
    // Allow for agent writes the agent's rule: a config agent's goes into the project's own config.
    const result = await write((confirmCopy) =>
      api.client().operator.permission.decide(
        {
          requestID: item.request.id,
          ...(confirmCopy ? { confirmCopy } : {}),
          operatorPermissionDecideInput: input,
        },
        { throwOnError: true },
      ),
    )
      .then((response) => response?.data)
      .catch((error: unknown) => {
        showToast({ title: language.t("operator.reply.failed"), description: requestError(error) })
        return undefined
      })
    await Promise.all(
      ["permission", "permission-decisions", "session-permissions", "agent-permissions"].map((key) =>
        queryClient.invalidateQueries({ queryKey: api.key(key) }),
      ),
    )
    if (result?.reload === "when-idle")
      showToast({
        title: language.t("operator.reply.savedWhenIdle"),
        description: result.rules[0]?.where ? shortPath(result.rules[0].where) : undefined,
      })
    else if (result?.covered.length)
      showToast({ title: language.t("operator.reply.covered", { count: result.covered.length }) })
    return result
  }
}

// What a request asks for, beyond its patterns: the command, file, URL, subagent or tool.
function Details(props: { metadata: { [key: string]: unknown } }) {
  const language = useLanguage()
  const text = (key: string) => {
    const value = props.metadata[key]
    return typeof value === "string" && value.trim() ? value : undefined
  }
  const rows = () =>
    (
      [
        ["command", text("command")],
        ["file", text("filePath") ?? text("filepath") ?? text("path")],
        ["url", text("url")],
        ["subagent", text("subagent_type") ?? text("agent")],
        ["description", text("description")],
        ["tool", text("tool")],
      ] satisfies Array<[string, string | undefined]>
    ).flatMap(([key, value]) => (value ? [[key, value] as const] : []))
  return (
    <>
      <Show when={rows().length}>
        <dl data-slot="operator-reply-details">
          <For each={rows()}>
            {([key, value]) => (
              <>
                <dt>{language.t(`operator.reply.detail.${key}` as Parameters<typeof language.t>[0])}</dt>
                <dd>
                  <code>{value}</code>
                </dd>
              </>
            )}
          </For>
        </dl>
      </Show>
      <Show when={text("diff")}>
        {(diff) => (
          <details data-slot="operator-reply-diff">
            <summary>{language.t("operator.reply.detail.diff")}</summary>
            <pre data-component="operator-code">{diff()}</pre>
          </details>
        )}
      </Show>
    </>
  )
}

// The four choices, with the rule's pattern (OpenCode's suggestion, editable) and a note for Deny.
// Allow for session is off while a locked agent rule decides; Allow for agent is off for OpenCode's
// built-in agents, with why.
export function Choices(props: {
  item: OperatorPendingPermission
  via: Via
  compact?: boolean
  onDecided?: (decision: Decision) => void
}) {
  const language = useLanguage()
  const decide = useDecide()
  const [store, setStore] = createStore({ patterns: suggested(props.item), note: "", busy: false })
  const builtin = () => props.item.agentTarget?.builtin ?? false
  const lock = () => props.item.lockedBy
  const run = async (decision: Decision) => {
    setStore("busy", true)
    const result = await decide(props.item, {
      decision,
      via: props.via,
      ...(decision === "allow-session" || decision === "allow-agent" ? { patterns: store.patterns } : {}),
      ...(decision === "deny" && store.note.trim() ? { note: store.note.trim() } : {}),
    })
    setStore("busy", false)
    if (result) props.onDecided?.(decision)
  }
  return (
    <div data-slot="operator-reply-choices" data-compact={props.compact ? "" : undefined}>
      <div data-slot="operator-reply-rule">
        <span class="inline-flex items-center">
          {language.t("operator.reply.pattern")}
          <FieldHelp field={language.t("operator.reply.pattern")} text={language.t("operator.help.replyPattern")} />
        </span>
        <For each={store.patterns}>
          {(pattern, at) => (
            <TextInputV2
              appearance="base"
              value={pattern}
              aria-label={language.t("operator.reply.patternOf", { index: at() + 1 })}
              onInput={(event) => setStore("patterns", at(), event.currentTarget.value)}
            />
          )}
        </For>
      </div>
      <div data-slot="operator-actions">
        <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void run("allow")}>
          {language.t("operator.reply.allow")}
        </ButtonV2>
        <ButtonV2
          variant="outline"
          disabled={store.busy || !!lock()}
          title={lock() ? language.t("operator.reply.locked", { rule: ruleText(lock()!) }) : undefined}
          onClick={() => void run("allow-session")}
        >
          {language.t("operator.reply.allowSession")}
        </ButtonV2>
        <ButtonV2
          variant="outline"
          disabled={store.busy || builtin()}
          title={builtin() ? language.t("operator.reply.builtinAgent") : undefined}
          onClick={() => void run("allow-agent")}
        >
          {language.t("operator.reply.allowAgent")}
        </ButtonV2>
        <ButtonV2 variant="danger" disabled={store.busy} onClick={() => void run("deny")}>
          {language.t("operator.reply.deny")}
        </ButtonV2>
      </div>
      <Show when={lock()}>
        {(rule) => (
          <p data-slot="operator-note" data-testid="reply-locked">
            {language.t("operator.reply.locked", { rule: ruleText(rule()) })}
          </p>
        )}
      </Show>
      <Show when={builtin()}>
        <p data-slot="operator-note">{language.t("operator.reply.builtinAgent")}</p>
      </Show>
      <Show when={!builtin() && props.item.agentTarget?.path}>
        {(path) => <p data-slot="operator-note">{language.t("operator.reply.savesTo", { path: shortPath(path()) })}</p>}
      </Show>
      <TextInputV2
        appearance="base"
        value={store.note}
        placeholder={language.t("operator.reply.notePlaceholder")}
        aria-label={language.t("operator.reply.note")}
        onInput={(event) => setStore("note", event.currentTarget.value)}
      />
    </div>
  )
}

// One waiting request: who asks (agent, session, project; the namespace on hover), what it asks for,
// how long it has waited, the rule that made it ask, and the four choices.
export function ReplyCard(props: {
  item: OperatorPendingPermission
  via: Via
  onDecided?: (decision: Decision) => void
}) {
  const language = useLanguage()
  const openSession = useOpenSession()
  const originText = useOriginText()
  const item = () => props.item
  const project = () => item().project?.key ?? item().directory
  return (
    <article data-component="operator-reply-card" data-request={item().request.id} data-testid="reply-card">
      <div data-slot="operator-reply-head">
        <Tag variant="accent">{item().request.permission}</Tag>
        <Show when={item().session?.agent}>{(agent) => <Tag>{agent()}</Tag>}</Show>
        <button type="button" data-slot="operator-link" onClick={() => openSession(item().request.sessionID)}>
          {item().session?.title ?? item().request.sessionID}
        </button>
        <span
          data-slot="operator-note"
          title={language.t("operator.reply.projectHint", {
            folder: project(),
            namespace: item().project?.namespace ?? "",
          })}
        >
          {shortPath(project())}
        </span>
        <span data-slot="operator-note" data-testid="reply-waited">
          {language.t("operator.reply.waited", { ago: formatAgo(item().time, language.intl()) })}
        </span>
      </div>
      <ul data-slot="operator-ask-patterns">
        <For each={item().request.patterns}>
          {(pattern) => (
            <li>
              <code>{pattern}</code>
            </li>
          )}
        </For>
      </ul>
      <Details metadata={item().request.metadata} />
      <p data-slot="operator-note" data-testid="reply-asked-by">
        <Show when={item().askedBy} fallback={language.t("operator.reply.askedDefault")}>
          {(row) =>
            language.t("operator.reply.askedBy", {
              index: row().index,
              rule: `${row().permission} ${row().pattern} ${row().action}`,
              from: originText(row().from),
            })
          }
        </Show>
      </p>
      <Choices item={item()} via={props.via} onDecided={props.onDecided} />
    </article>
  )
}

// The chat's permission dock (the fork's seam in session-permission-dock.tsx): the four choices for
// the request, once the server describes it; until then, OpenCode's own buttons.
export function dockFooter(request: PermissionRequest, upstream: () => JSX.Element): JSX.Element {
  return <DockChoices request={request} upstream={upstream} />
}

function DockChoices(props: { request: PermissionRequest; upstream: () => JSX.Element }) {
  const pending = usePendingPermissions()
  const [done, setDone] = createSignal(false)
  // (Read without suspending the chat page.)
  const item = () => asList(ready(pending)).find((entry) => entry.request.id === props.request.id)
  return (
    <Show when={item() && !done()} fallback={props.upstream()}>
      <div data-slot="operator-dock-choices" data-testid="dock-choices">
        <Choices item={item()!} via="chat" compact onDecided={() => setDone(true)} />
      </div>
    </Show>
  )
}
