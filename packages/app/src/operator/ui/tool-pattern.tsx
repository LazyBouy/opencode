import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "./select"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorToolPattern, OperatorToolPatternExample } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Index, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { useScopedProject } from "../project"
import { Field } from "./field"
import { RecordField } from "./record-overlay"

// A tool's permission pattern (specs/docs/feedbacks/memory/memory_spec.md §9): how its permission requests
// look, so rules can be written without reading code. Shown on its card (Capabilities → Tools), asked for
// when a custom tool is created, and as help when a rule is added in the permission editor.

type Action = OperatorToolPatternExample["action"]
const ACTIONS: Action[] = ["allow", "ask", "deny"]

export type PatternDraft = { permission: string; verbs: string; text: string; examples: OperatorToolPatternExample[] }

export const draftOf = (pattern: OperatorToolPattern | undefined, tool: string): PatternDraft => ({
  permission: pattern?.permission ?? tool,
  verbs: (pattern?.verbs ?? []).join(", "),
  text: pattern?.text ?? "*",
  examples: [...(pattern?.examples ?? [])],
})

export const inputOf = (tool: string, draft: PatternDraft) => ({
  tool,
  permission: draft.permission.trim() || tool,
  verbs: draft.verbs
    .split(",")
    .map((verb) => verb.trim())
    .filter(Boolean),
  text: draft.text.trim() || "*",
  examples: draft.examples.filter((item) => item.pattern.trim()),
})

/** The project's tools' permission patterns (the page's chosen project when none is given). */
export function useToolPatterns(directory?: () => string | undefined) {
  const api = useOperatorClient()
  const scoped = useScopedProject()
  const folder = () => directory?.() ?? scoped()
  return useQuery(() => ({
    queryKey: api.key("tool-patterns", folder()),
    queryFn: () =>
      api
        .client()
        .operator.capability.toolPatterns({ ...(folder() ? { directory: folder() } : {}) })
        .then((result) => result.data ?? []),
  }))
}

/** What the pattern is matched against, in words. */
export function usePatternText() {
  const language = useLanguage()
  return (pattern: OperatorToolPattern) =>
    pattern.form === "custom"
      ? language.t("operator.toolPattern.customIs", { text: pattern.text ?? "*" })
      : language.t(`operator.toolPattern.form.${pattern.form}` as "operator.toolPattern.form.path")
}

const rule = (example: { pattern: string; action: string }) => `"${example.pattern}": "${example.action}"`

/** The pattern on a tool's card: its five parts. */
export function ToolPatternFields(props: { pattern: OperatorToolPattern }) {
  const language = useLanguage()
  const text = usePatternText()
  return (
    <>
      <RecordField
        label={language.t("operator.toolPattern.permission")}
        help={language.t("operator.help.patternPermission")}
      >
        <span class="inline-flex items-center gap-2">
          <code data-testid="tool-pattern-permission">{props.pattern.permission}</code>
          <Tag>
            {language.t(`operator.toolPattern.source.${props.pattern.source}` as "operator.toolPattern.source.code")}
          </Tag>
        </span>
      </RecordField>
      <RecordField label={language.t("operator.toolPattern.verbs")} help={language.t("operator.help.patternVerbs")}>
        {props.pattern.verbs.length ? <code>{props.pattern.verbs.join(", ")}</code> : "—"}
      </RecordField>
      <RecordField label={language.t("operator.toolPattern.pattern")} help={language.t("operator.help.patternPattern")}>
        <span data-testid="tool-pattern-text">{text(props.pattern)}</span>
      </RecordField>
      <RecordField
        label={language.t("operator.toolPattern.examples")}
        help={language.t("operator.help.patternExamples")}
      >
        <Show when={props.pattern.examples.length} fallback="—">
          <ul data-testid="tool-pattern-examples">
            <For each={props.pattern.examples}>
              {(example) => (
                <li>
                  <code>{rule(example)}</code>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </RecordField>
      <RecordField
        label={language.t("operator.toolPattern.defaults")}
        help={language.t("operator.help.patternDefaults")}
      >
        <Show when={props.pattern.defaults.length} fallback="—">
          <ul data-testid="tool-pattern-defaults">
            <For each={props.pattern.defaults}>
              {(line) => (
                <li>
                  <code>{rule(line)}</code>{" "}
                  <span data-slot="operator-note">
                    {language.t(`operator.levels.level.${line.level}` as "operator.levels.level.global")}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </RecordField>
    </>
  )
}

/** A custom tool's pattern, edited: permission, verbs, what the pattern is, and example rules. */
export function ToolPatternForm(props: { value: PatternDraft; onChange: (value: PatternDraft) => void }) {
  const language = useLanguage()
  const set = (change: Partial<PatternDraft>) => props.onChange({ ...props.value, ...change })
  const setExample = (at: number, change: Partial<OperatorToolPatternExample>) =>
    set({ examples: props.value.examples.map((item, index) => (index === at ? { ...item, ...change } : item)) })
  return (
    <div class="flex flex-col gap-3" data-testid="tool-pattern-form">
      <div data-slot="operator-form-row">
        <Field
          label={language.t("operator.toolPattern.permission")}
          hint={language.t("operator.help.patternPermission")}
        >
          <TextInputV2
            appearance="base"
            value={props.value.permission}
            onInput={(event) => set({ permission: event.currentTarget.value })}
          />
        </Field>
        <Field label={language.t("operator.toolPattern.verbs")} hint={language.t("operator.help.patternVerbs")}>
          <TextInputV2
            appearance="base"
            placeholder="READ, WRITE"
            value={props.value.verbs}
            onInput={(event) => set({ verbs: event.currentTarget.value })}
          />
        </Field>
      </div>
      <Field label={language.t("operator.toolPattern.pattern")} hint={language.t("operator.help.patternPatternCustom")}>
        <TextInputV2
          appearance="base"
          value={props.value.text}
          onInput={(event) => set({ text: event.currentTarget.value })}
        />
      </Field>
      <Field
        group
        label={language.t("operator.toolPattern.examples")}
        hint={language.t("operator.help.patternExamples")}
      >
        <div class="flex flex-col gap-1 w-full">
          <Index each={props.value.examples}>
            {(example, at) => (
              <div class="flex items-center gap-1" data-testid="tool-pattern-example">
                <TextInputV2
                  appearance="base"
                  aria-label={language.t("operator.toolPattern.examplePattern")}
                  value={example().pattern}
                  onInput={(event) => setExample(at, { pattern: event.currentTarget.value })}
                />
                <SelectV2<Action>
                  appearance="base"
                  aria-label={language.t("operator.toolPattern.exampleAction")}
                  options={ACTIONS}
                  current={example().action}
                  label={(action) => language.t(`operator.permission.action.${action}`)}
                  onSelect={(action) => action && setExample(at, { action })}
                />
                <IconButtonV2
                  variant="ghost-muted"
                  size="small"
                  aria-label={language.t("operator.toolPattern.removeExample")}
                  icon={<Icon name="close-small" />}
                  onClick={() => set({ examples: props.value.examples.filter((_, index) => index !== at) })}
                />
              </div>
            )}
          </Index>
          <span>
            <ButtonV2
              size="small"
              variant="outline"
              onClick={() => set({ examples: [...props.value.examples, { pattern: "", action: "ask" }] })}
            >
              {language.t("operator.toolPattern.addExample")}
            </ButtonV2>
          </span>
        </div>
      </Field>
    </div>
  )
}

/** The permission editor's help for the permission being added: what its pattern is, and examples. */
export function PatternHelp(props: { patterns: ReadonlyArray<OperatorToolPattern> | undefined; permission: string }) {
  const language = useLanguage()
  const text = usePatternText()
  const found = () => props.patterns?.find((item) => item.permission === props.permission.trim())
  return (
    <Show when={found()}>
      {(pattern) => (
        <p data-slot="operator-note" data-testid="pattern-help">
          {language.t("operator.toolPattern.editorHelp", { text: text(pattern()) })}
          <Show when={pattern().examples.length}>
            {" "}
            {language.t("operator.toolPattern.editorExamples", {
              examples: pattern()
                .examples.map((item) => rule(item))
                .join(", "),
            })}
          </Show>
        </p>
      )}
    </Show>
  )
}

/** A tool's card section: its pattern; a custom tool's can be edited in place. */
export function ToolPatternSection(props: { tool: string; directory: () => string | undefined }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const patterns = useToolPatterns(props.directory)
  const pattern = () => patterns.data?.find((item) => item.tool === props.tool)
  const [store, setStore] = createStore({ editing: false, busy: false, error: "", draft: draftOf(undefined, "") })
  const edit = () => setStore({ editing: true, error: "", draft: draftOf(pattern(), props.tool) })
  const save = async () => {
    setStore({ busy: true, error: "" })
    await api
      .client()
      .operator.capability.saveToolPattern({
        ...(props.directory() ? { directory: props.directory() } : {}),
        ...inputOf(props.tool, store.draft),
      })
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: api.key("tool-patterns") })
        setStore("editing", false)
      })
      .catch((error: unknown) => setStore("error", requestError(error)))
      .finally(() => setStore("busy", false))
  }
  return (
    <Show when={pattern()}>
      {(found) => (
        <section data-testid="tool-pattern">
          <div class="flex items-center justify-between gap-2">
            <h4 data-slot="operator-panel-title">{language.t("operator.toolPattern.title")}</h4>
            <Show when={found().editable && !store.editing}>
              <ButtonV2 size="small" variant="outline" onClick={edit}>
                {language.t("operator.profile.edit")}
              </ButtonV2>
            </Show>
          </div>
          <Show
            when={store.editing}
            fallback={
              <dl data-component="record-fields">
                <ToolPatternFields pattern={found()} />
              </dl>
            }
          >
            <ToolPatternForm value={store.draft} onChange={(draft) => setStore("draft", draft)} />
            <div data-slot="operator-actions">
              <ButtonV2 variant="neutral" onClick={() => setStore("editing", false)}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void save()}>
                {language.t("operator.config.save")}
              </ButtonV2>
            </div>
          </Show>
          <Show when={store.error}>
            <p data-slot="operator-error" role="alert">
              {store.error}
            </p>
          </Show>
        </section>
      )}
    </Show>
  )
}
