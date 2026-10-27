import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorInboxRule, OperatorInboxTestResult } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { Field } from "../ui/field"
import { OverlayFrame } from "../ui/overlay-frame"
import { useOverlayParams } from "../ui/overlay-nav"
import { useConfirm } from "../ui/confirm"
import { useRecordOverlay } from "../ui/record-overlay"
import { SelectV2 } from "../ui/select"
import { requestError } from "./config-helpers"
import {
  ACTIONS,
  type Draft,
  draftOf,
  hasReplies,
  matchParts,
  move,
  newRuleId,
  PRIORITIES,
  ruleOf,
  TARGET_TYPES,
} from "./project-inbox-model"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
const NEW = "@new"

// The Project inbox's Rules tab (SPEC-0023 §8.2, §10.1): the ordered list (the first that matches decides),
// reordered by dragging or with the arrows, each turned on or off, edited in its overlay or deleted; the two
// presets; a warning when "Replies go to their sender" is missing; and Test, which runs a sample message through
// the rules (saved, or as they are here) without sending anything.

export type InboxScope = { project: () => string; directory: () => string | undefined }

const UNSET = "@unset"
/** A select with an empty choice of its own (SelectV2 shows "" as nothing chosen, without its label). */
export function OptionalSelect<T extends string>(props: {
  value: T | ""
  options: ReadonlyArray<T>
  label: (value: T | "") => string
  onSelect: (value: T | "") => void
  "aria-label"?: string
}) {
  return (
    <SelectV2<string>
      appearance="base"
      aria-label={props["aria-label"]}
      options={[UNSET, ...props.options]}
      current={props.value || UNSET}
      label={(value) => props.label(value === UNSET ? "" : (value as T))}
      onSelect={(value) => value !== null && props.onSelect(value === UNSET ? "" : (value as T))}
    />
  )
}

export function useInboxRules(scope: InboxScope) {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const language = useLanguage()
  const inbox = useQuery(() => ({
    queryKey: api.key("project-inbox-rules", scope.project()),
    queryFn: () =>
      api
        .client()
        .operator.projectInbox.rules({ project: scope.project(), directory: scope.directory() }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const save = async (rules: OperatorInboxRule[]) => {
    try {
      await api
        .client()
        .operator.projectInbox.setRules(
          { project: scope.project(), directory: scope.directory(), rules },
          { throwOnError: true },
        )
      await queryClient.invalidateQueries({ queryKey: api.key("project-inbox-rules", scope.project()) })
      return true
    } catch (error) {
      showToast({ title: language.t("operator.inbox.rules.saveFailed"), description: requestError(error) })
      return false
    }
  }
  return { inbox, rules: () => ready(inbox)?.rules ?? [], save }
}

export function RulesTab(props: InboxScope) {
  const language = useLanguage()
  const confirm = useConfirm()
  const data = useInboxRules(props)
  const [params, setParams] = useOverlayParams<{ rule?: string }>()
  const [dragging, setDragging] = createSignal<number>()
  useRecordOverlay(
    () => !!params.rule,
    () => <RuleOverlay {...props} />,
    ["rule"],
  )
  const rules = () => data.rules()
  const reorder = (from: number, to: number) => void data.save(move(rules(), from, to))
  const toggle = (rule: OperatorInboxRule) =>
    void data.save(rules().map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)))
  const remove = async (rule: OperatorInboxRule) => {
    const ok = await confirm({
      title: language.t("operator.inbox.rules.deleteTitle", { name: rule.name }),
      description: language.t("operator.inbox.rules.deleteBody"),
      confirm: language.t("operator.inbox.rules.delete"),
      danger: true,
    })
    if (ok) await data.save(rules().filter((item) => item.id !== rule.id))
  }
  const addPreset = (preset: "replies" | "as-addressed") => {
    const made: OperatorInboxRule =
      preset === "replies"
        ? {
            id: "replies",
            name: language.t("operator.inbox.preset.replies"),
            enabled: true,
            preset,
            match: { reply: true },
            action: { kind: "to-sender" },
          }
        : {
            id: "as-addressed",
            name: language.t("operator.inbox.preset.as-addressed"),
            enabled: true,
            preset,
            match: { recipient: { type: "any" } },
            action: { kind: "as-addressed" },
          }
    // Replies first, so they reach their sender whatever else matches.
    void data.save(preset === "replies" ? [made, ...rules()] : [...rules(), made])
  }
  const has = (id: string) => rules().some((rule) => rule.id === id || rule.preset === id)
  const summary = (rule: OperatorInboxRule) => {
    const parts = matchParts(rule.match).map((part) =>
      language.t(`operator.inbox.match.${part.key}` as Key, { value: part.value ?? "" }),
    )
    const then = [
      rule.action.kind === "forward"
        ? language.t("operator.inbox.action.forwardTo", {
            to: (rule.action.to ?? []).map((target) => `${target.type} ${target.id}`).join(", "),
          })
        : language.t(`operator.inbox.action.${rule.action.kind}` as Key),
      ...(rule.action.steer ? [language.t("operator.inbox.action.steering")] : []),
      ...(rule.action.priority
        ? [
            language.t("operator.inbox.action.raised", {
              priority: language.t(`operator.queue.priority.${rule.action.priority}`),
            }),
          ]
        : []),
    ]
    return `${parts.length ? parts.join(", ") : language.t("operator.inbox.match.every")} → ${then.join(", ")}`
  }
  return (
    <div data-component="operator-inbox-rules" data-testid="inbox-rules">
      <Show when={ready(data.inbox) && !hasReplies(rules())}>
        <p data-slot="operator-note" data-warning="" data-testid="inbox-rules-replies-missing">
          {language.t("operator.inbox.rules.repliesMissing")}{" "}
          <button type="button" data-slot="operator-link" onClick={() => addPreset("replies")}>
            {language.t("operator.inbox.rules.addReplies")}
          </button>
        </p>
      </Show>
      <div data-slot="operator-toolbar">
        <span class="flex items-center gap-2">
          <ButtonV2 size="small" variant="outline" onClick={() => setParams({ rule: NEW })}>
            {language.t("operator.inbox.rules.add")}
          </ButtonV2>
          <Show when={!has("as-addressed")}>
            <ButtonV2 size="small" variant="ghost" onClick={() => addPreset("as-addressed")}>
              {language.t("operator.inbox.rules.addPreset", { name: language.t("operator.inbox.preset.as-addressed") })}
            </ButtonV2>
          </Show>
          <Show when={!has("replies")}>
            <ButtonV2 size="small" variant="ghost" onClick={() => addPreset("replies")}>
              {language.t("operator.inbox.rules.addPreset", { name: language.t("operator.inbox.preset.replies") })}
            </ButtonV2>
          </Show>
        </span>
      </div>
      <Show
        when={rules().length}
        fallback={
          <p data-slot="operator-note">
            {data.inbox.isPending ? language.t("common.loading") : language.t("operator.inbox.rules.none")}
          </p>
        }
      >
        <ol data-component="operator-inbox-rule-list" aria-label={language.t("operator.inbox.tab.rules")}>
          <For each={rules()}>
            {(rule, at) => (
              <li
                data-testid="inbox-rule"
                data-rule={rule.id}
                data-off={rule.enabled ? undefined : ""}
                draggable="true"
                onDragStart={(event) => {
                  setDragging(at())
                  event.dataTransfer?.setData("text/plain", rule.id)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const from = dragging()
                  setDragging(undefined)
                  if (from !== undefined) reorder(from, at())
                }}
              >
                <span data-slot="operator-inbox-rule-order">{at() + 1}</span>
                <span data-slot="operator-inbox-rule-body">
                  <span class="flex items-center gap-2">
                    <strong>{rule.name}</strong>
                    <Show when={rule.preset}>
                      <Tag>{language.t("operator.inbox.rules.preset")}</Tag>
                    </Show>
                    <Show when={!rule.enabled}>
                      <Tag>{language.t("operator.inbox.rules.off")}</Tag>
                    </Show>
                  </span>
                  <span data-slot="operator-cell-clamp">{summary(rule)}</span>
                </span>
                <span data-slot="operator-rules-actions">
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    aria-label={language.t("operator.inbox.rules.up", { name: rule.name })}
                    disabled={at() === 0}
                    onClick={() => reorder(at(), at() - 1)}
                  >
                    ↑
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    aria-label={language.t("operator.inbox.rules.down", { name: rule.name })}
                    disabled={at() === rules().length - 1}
                    onClick={() => reorder(at(), at() + 1)}
                  >
                    ↓
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost" onClick={() => toggle(rule)}>
                    {rule.enabled
                      ? language.t("operator.inbox.rules.turnOff")
                      : language.t("operator.inbox.rules.turnOn")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="outline" onClick={() => setParams({ rule: rule.id })}>
                    {language.t("operator.inbox.rules.edit")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="danger" onClick={() => void remove(rule)}>
                    {language.t("operator.inbox.rules.delete")}
                  </ButtonV2>
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <RulesTest {...props} rules={rules} />
    </div>
  )
}

// Test: a sample message through the rules; nothing is sent.
function RulesTest(props: InboxScope & { rules: () => OperatorInboxRule[] }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [sample, setSample] = createStore({
    text: "",
    fromAgent: "",
    fromSession: "",
    to: "" as "" | "agent" | "group" | "session",
    toId: "",
    priority: "normal" as (typeof PRIORITIES)[number],
    replyTo: "",
  })
  const [result, setResult] = createSignal<OperatorInboxTestResult>()
  const [error, setError] = createSignal("")
  const run = async () => {
    setError("")
    try {
      const found = await api.client().operator.projectInbox.test(
        {
          project: props.project(),
          directory: props.directory(),
          rules: props.rules(),
          sample: {
            text: sample.text,
            ...(sample.fromAgent.trim() ? { fromAgent: sample.fromAgent.trim() } : {}),
            ...(sample.fromSession.trim() ? { fromSession: sample.fromSession.trim() } : {}),
            ...(sample.to && sample.toId.trim() ? { to: { type: sample.to, id: sample.toId.trim() } } : {}),
            priority: sample.priority,
            ...(sample.replyTo.trim() ? { replyTo: sample.replyTo.trim() } : {}),
          },
        },
        { throwOnError: true },
      )
      setResult(found.data!)
    } catch (caught) {
      setError(requestError(caught))
    }
  }
  return (
    <section data-component="operator-panel" data-testid="inbox-rules-test">
      <h3 data-slot="operator-panel-title">{language.t("operator.inbox.test.title")}</h3>
      <p data-slot="operator-note">{language.t("operator.inbox.test.hint")}</p>
      <Field label={language.t("operator.inbox.test.text")} hint={language.t("operator.inbox.help.testText")}>
        <TextInputV2
          appearance="base"
          value={sample.text}
          onInput={(event) => setSample("text", event.currentTarget.value)}
        />
      </Field>
      <Field label={language.t("operator.inbox.test.fromAgent")} hint={language.t("operator.inbox.help.testFromAgent")}>
        <TextInputV2
          appearance="base"
          value={sample.fromAgent}
          onInput={(event) => setSample("fromAgent", event.currentTarget.value)}
        />
      </Field>
      <Field
        label={language.t("operator.inbox.test.fromSession")}
        hint={language.t("operator.inbox.help.testFromSession")}
      >
        <TextInputV2
          appearance="base"
          value={sample.fromSession}
          onInput={(event) => setSample("fromSession", event.currentTarget.value)}
        />
      </Field>
      <Field
        label={language.t("operator.inbox.field.recipient")}
        hint={language.t("operator.inbox.help.testRecipient")}
        group
      >
        <span class="flex items-center gap-2">
          <OptionalSelect
            aria-label={language.t("operator.inbox.field.recipient")}
            options={TARGET_TYPES}
            value={sample.to}
            label={(value) => language.t(`operator.inbox.recipient.${value || "none"}` as Key)}
            onSelect={(value) => setSample("to", value)}
          />
          <Show when={sample.to}>
            <TextInputV2
              appearance="base"
              aria-label={language.t("operator.inbox.field.recipientId")}
              value={sample.toId}
              onInput={(event) => setSample("toId", event.currentTarget.value)}
            />
          </Show>
        </span>
      </Field>
      <Field label={language.t("operator.queue.priority")} hint={language.t("operator.help.queuePriority")}>
        <SelectV2<(typeof PRIORITIES)[number]>
          appearance="base"
          options={PRIORITIES}
          current={sample.priority}
          label={(value) => language.t(`operator.queue.priority.${value}`)}
          onSelect={(value) => value && setSample("priority", value)}
        />
      </Field>
      <Field label={language.t("operator.queue.replyTo")} hint={language.t("operator.inbox.help.testReplyTo")}>
        <TextInputV2
          appearance="base"
          value={sample.replyTo}
          onInput={(event) => setSample("replyTo", event.currentTarget.value)}
        />
      </Field>
      <div data-slot="operator-actions">
        <ButtonV2 size="small" disabled={!sample.text.trim()} onClick={() => void run()}>
          {language.t("operator.inbox.test.run")}
        </ButtonV2>
      </div>
      <Show when={result()}>
        {(found) => (
          <p data-slot="operator-note" data-testid="inbox-rules-test-result">
            <Tag>{language.t(`operator.inbox.test.by.${found().by.replace(" ", "-")}` as Key)}</Tag> {found().detail}
          </p>
        )}
      </Show>
      <Show when={error()}>
        <pre data-slot="operator-error" role="alert">
          {error()}
        </pre>
      </Show>
    </section>
  )
}

// A rule's form (`?rule=<id>`, `?rule=@new`): its match and action, every part with its (i).
function RuleOverlay(props: InboxScope) {
  const language = useLanguage()
  const data = useInboxRules(props)
  const [params, setParams] = useOverlayParams<{ rule?: string }>()
  const existing = createMemo(() => data.rules().find((rule) => rule.id === params.rule))
  const isNew = () => params.rule === NEW
  const [draft, setDraft] = createStore<Draft>(draftOf())
  const [state, setState] = createStore({ loaded: false, dirty: false, busy: false })
  // The form starts from the rule once it's loaded (a new rule from blank fields).
  createEffect(() => {
    const rule = existing()
    if (state.loaded || !(rule || (isNew() && ready(data.inbox)))) return
    setDraft(draftOf(rule))
    setState("loaded", true)
  })
  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(key, value as never)
    setState("dirty", true)
  }
  const save = async () => {
    setState("busy", true)
    const rules = data.rules()
    const id = existing()?.id ?? newRuleId(rules)
    const rule = ruleOf({ ...draft, to: [...draft.to] }, id, existing()?.preset)
    const next = existing() ? rules.map((item) => (item.id === id ? rule : item)) : [...rules, rule]
    const ok = await data.save(next)
    setState("busy", false)
    if (ok) {
      setState("dirty", false)
      setParams({ rule: undefined })
    }
  }
  const text = (
    key:
      | "name"
      | "fromProjects"
      | "fromAgents"
      | "fromSessions"
      | "recipientId"
      | "contains"
      | "pattern"
      | "correlationPrefix",
  ) => <TextInputV2 appearance="base" value={draft[key]} onInput={(event) => edit(key, event.currentTarget.value)} />
  const field = (label: Key, help: Key, control: () => JSX.Element, group = false) => (
    <Field label={language.t(label)} hint={language.t(help)} group={group}>
      {control()}
    </Field>
  )
  return (
    <OverlayFrame
      label={isNew() ? language.t("operator.inbox.rules.new") : (existing()?.name ?? params.rule ?? "")}
      editing={state.dirty}
    >
      <div data-component="operator-inbox-overlay" data-testid="inbox-rule-form">
        <Show when={state.loaded} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
          <section data-component="operator-panel">
            {field("operator.inbox.field.name", "operator.inbox.help.name", () => text("name"))}
            <CheckboxV2
              label={language.t("operator.inbox.field.enabled")}
              checked={draft.enabled}
              onChange={(value: boolean) => edit("enabled", value)}
            />
          </section>
          <section data-component="operator-panel">
            <h3 data-slot="operator-panel-title">{language.t("operator.inbox.form.match")}</h3>
            <p data-slot="operator-note">{language.t("operator.inbox.form.matchHint")}</p>
            {field(
              "operator.inbox.field.fromProject",
              "operator.inbox.help.fromProject",
              () => (
                <span class="flex items-center gap-2">
                  <SelectV2<Draft["fromProject"]>
                    appearance="base"
                    aria-label={language.t("operator.inbox.field.fromProject")}
                    options={["any", "this", "list"]}
                    current={draft.fromProject}
                    label={(value) => language.t(`operator.inbox.fromProject.${value}` as Key)}
                    onSelect={(value) => value && edit("fromProject", value)}
                  />
                  <Show when={draft.fromProject === "list"}>{text("fromProjects")}</Show>
                </span>
              ),
              true,
            )}
            {field("operator.inbox.field.fromAgents", "operator.inbox.help.fromAgents", () => text("fromAgents"))}
            {field("operator.inbox.field.fromSessions", "operator.inbox.help.fromSessions", () => text("fromSessions"))}
            {field(
              "operator.inbox.field.recipient",
              "operator.inbox.help.recipient",
              () => (
                <span class="flex items-center gap-2">
                  <OptionalSelect
                    aria-label={language.t("operator.inbox.field.recipient")}
                    options={["any", "none", ...TARGET_TYPES] as const}
                    value={draft.recipient}
                    label={(value) => language.t(`operator.inbox.recipientMatch.${value || "unset"}` as Key)}
                    onSelect={(value) => edit("recipient", value)}
                  />
                  <Show when={draft.recipient && draft.recipient !== "any" && draft.recipient !== "none"}>
                    {text("recipientId")}
                  </Show>
                </span>
              ),
              true,
            )}
            {field("operator.inbox.field.priority", "operator.inbox.help.priority", () => (
              <OptionalSelect
                options={PRIORITIES}
                value={draft.priority}
                label={(value) =>
                  value ? language.t(`operator.queue.priority.${value}`) : language.t("operator.inbox.any")
                }
                onSelect={(value) => edit("priority", value)}
              />
            ))}
            {field("operator.inbox.field.type", "operator.inbox.help.type", () => (
              <OptionalSelect
                options={["text", "file-location"] as const}
                value={draft.type}
                label={(value) =>
                  value ? language.t(`operator.inbox.type.${value}` as Key) : language.t("operator.inbox.any")
                }
                onSelect={(value) => edit("type", value)}
              />
            ))}
            {field("operator.inbox.field.contains", "operator.inbox.help.contains", () => text("contains"))}
            {field("operator.inbox.field.pattern", "operator.inbox.help.pattern", () => text("pattern"))}
            {field("operator.inbox.field.correlation", "operator.inbox.help.correlationPrefix", () =>
              text("correlationPrefix"),
            )}
            <CheckboxV2
              label={language.t("operator.inbox.field.reply")}
              checked={draft.reply}
              onChange={(value: boolean) => edit("reply", value)}
            />
            <p data-slot="operator-note">{language.t("operator.inbox.help.reply")}</p>
          </section>
          <section data-component="operator-panel">
            <h3 data-slot="operator-panel-title">{language.t("operator.inbox.form.action")}</h3>
            {field("operator.inbox.field.action", "operator.inbox.help.action", () => (
              <SelectV2<Draft["action"]>
                appearance="base"
                aria-label={language.t("operator.inbox.field.action")}
                options={ACTIONS}
                current={draft.action}
                label={(value) => language.t(`operator.inbox.action.${value}` as Key)}
                onSelect={(value) => value && edit("action", value)}
              />
            ))}
            <Show when={draft.action === "forward"}>
              {field(
                "operator.inbox.field.to",
                "operator.inbox.help.to",
                () => (
                  <div class="flex flex-col gap-2" data-testid="inbox-rule-targets">
                    <For each={draft.to}>
                      {(target, at) => (
                        <span class="flex items-center gap-2">
                          <SelectV2<(typeof TARGET_TYPES)[number]>
                            appearance="base"
                            aria-label={language.t("operator.inbox.field.targetType")}
                            options={TARGET_TYPES}
                            current={target.type}
                            label={(value) => language.t(`operator.inbox.recipient.${value}` as Key)}
                            onSelect={(value) =>
                              value &&
                              edit(
                                "to",
                                draft.to.map((item, index) => (index === at() ? { ...item, type: value } : item)),
                              )
                            }
                          />
                          <TextInputV2
                            appearance="base"
                            aria-label={language.t("operator.inbox.field.recipientId")}
                            value={target.id}
                            onInput={(event) =>
                              edit(
                                "to",
                                draft.to.map((item, index) =>
                                  index === at() ? { ...item, id: event.currentTarget.value } : item,
                                ),
                              )
                            }
                          />
                          <ButtonV2
                            size="small"
                            variant="ghost"
                            onClick={() =>
                              edit(
                                "to",
                                draft.to.filter((_, index) => index !== at()),
                              )
                            }
                          >
                            {language.t("operator.inbox.form.removeTarget")}
                          </ButtonV2>
                        </span>
                      )}
                    </For>
                    <span>
                      <ButtonV2
                        size="small"
                        variant="outline"
                        onClick={() => edit("to", [...draft.to, { type: "agent", id: "" }])}
                      >
                        {language.t("operator.inbox.form.addTarget")}
                      </ButtonV2>
                    </span>
                  </div>
                ),
                true,
              )}
            </Show>
            <CheckboxV2
              label={language.t("operator.inbox.field.steer")}
              checked={draft.steer}
              onChange={(value: boolean) => edit("steer", value)}
            />
            {field("operator.inbox.field.raise", "operator.inbox.help.raise", () => (
              <OptionalSelect
                options={PRIORITIES}
                value={draft.raise}
                label={(value) =>
                  value ? language.t(`operator.queue.priority.${value}`) : language.t("operator.inbox.unchanged")
                }
                onSelect={(value) => edit("raise", value)}
              />
            ))}
          </section>
          <div data-slot="operator-actions" class="flex gap-2">
            <ButtonV2 size="small" disabled={state.busy || !draft.name.trim()} onClick={() => void save()}>
              {language.t("operator.inbox.rules.save")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => setParams({ rule: undefined })}>
              {language.t("operator.inbox.rules.cancel")}
            </ButtonV2>
          </div>
        </Show>
      </div>
    </OverlayFrame>
  )
}
