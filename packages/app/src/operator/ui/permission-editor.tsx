import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorPermissionRow } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, createUniqueId, For, Index, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "./field-help"
import { useOriginText } from "./permission-origin"
import { insertAt, type Line, linesOf, samePattern } from "./permission-lines"
import { type Action, hintOf, orderCheck, type PatternForm, type Rule } from "./rules"

const ACTIONS: Action[] = ["allow", "ask", "deny"]

// The one permission editor, used for an agent (its Permissions tab and its Edit form) and for a
// session. It shows the full list that applies, in evaluation order, each rule with where it comes
// from. Only one part is editable: the agent's own rules, or the session's own rules. A rule from
// elsewhere is changed on its own line (its pencil): the change is a rule of the editable part with the
// same permission and pattern, checked after it, and shown on that line (see permission-lines.ts).
// `value` is the editable part, as it will be saved.
export function PermissionEditor(props: {
  mode: "agent" | "session"
  // The saved full list, and where the editable part is in it (rows[start] up to rows[end]).
  rows: ReadonlyArray<OperatorPermissionRow>
  editable: { start: number; end: number }
  value: ReadonlyArray<Rule>
  onChange: (rules: Rule[]) => void
  forms: Readonly<Record<string, PatternForm>>
  known: ReadonlyArray<string>
  // Show only the rules for this permission (and `*` rules), as "Change access" asks.
  filter?: string
  onClearFilter?: () => void
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const origin = useOriginText()
  const changedText = useChangedText()
  const list = createUniqueId()
  const [dragging, setDragging] = createSignal<number>()
  const [draft, setDraft] = createStore({ permission: "", pattern: "*", action: "ask" as Action })
  // Rules from elsewhere opened for a change (by their place in `before`).
  const [editing, setEditing] = createStore<Record<number, boolean>>({})
  // The new rule is read from its fields when it is added, so what is typed is what is added.
  let permissionField: HTMLInputElement | undefined
  let patternField: HTMLInputElement | undefined
  const before = () => props.rows.slice(0, props.editable.start)
  const after = () => props.rows.slice(props.editable.end)
  const lines = createMemo(() => linesOf(before(), props.value, after()))
  const check = createMemo(() => (props.mode === "agent" ? orderCheck(props.value) : undefined))
  // Where each editable rule comes from: the saved rule it matches, else it is new (not saved yet).
  const origins = createMemo(() => {
    const pool = props.rows.slice(props.editable.start, props.editable.end)
    return props.value.map((rule) => {
      const found = pool.findIndex(
        (row) =>
          row.permission === rule.permission && samePattern(row.pattern, rule.pattern) && row.action === rule.action,
      )
      return found >= 0 ? pool.splice(found, 1)[0] : undefined
    })
  })
  const duplicate = (index: number) => !!check()?.duplicates.some((item) => item.earlier === index)
  const changed = (index: number) => !!check()?.changed.includes(index)
  const shown = (permission: string) =>
    !props.filter || permission === props.filter || permission === "*" || permission.includes("*")
  const set = (rules: Rule[]) => props.onChange(rules)
  const update = (index: number, change: Partial<Rule>) =>
    set(props.value.map((rule, position) => (position === index ? { ...rule, ...change } : rule)))
  const remove = (index: number) => set(props.value.filter((_, position) => position !== index))
  const move = (from: number, to: number) => {
    const next = [...props.value]
    const [item] = next.splice(from, 1)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, item!)
    set(next)
  }
  const add = (rule: Rule) => set([...props.value, rule])

  // A rule from elsewhere: its pencil opens it on its line, where its action can be changed. A change
  // back to the rule's own action removes the change.
  const Locked = (line: () => Line<OperatorPermissionRow>) => {
    const row = () => line().row!
    const at = () => before().indexOf(row())
    const change = () => line().own
    const open = () => change() !== undefined || !!editing[at()]
    const choose = (action: Action) => {
      const index = change()
      if (index !== undefined) return action === row().action ? remove(index) : update(index, { action })
      if (action === row().action) return
      const next = [...props.value]
      next.splice(insertAt(before(), props.value, at()), 0, {
        permission: row().permission,
        pattern: row().pattern,
        action,
      })
      set(next)
    }
    return (
      <tr
        data-locked=""
        data-part={row().part}
        data-open={open() ? "" : undefined}
        data-replaced={line().replacedBy ? "" : undefined}
        hidden={!shown(row().permission)}
      >
        <td>
          <Show when={at() >= 0 && !open()}>
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              icon={<Icon name="edit" />}
              aria-label={language.t("operator.permissionEditor.changeRule", { number: line().number })}
              title={language.t(`operator.permissionEditor.changeHint.${props.mode}`)}
              onClick={(event) => {
                const tr = event.currentTarget.closest("tr")
                setEditing(at(), true)
                tr?.querySelector<HTMLElement>("td[data-slot='operator-rule-action'] button")?.focus()
              }}
            />
          </Show>
        </td>
        <LineNumber line={line()} mode={props.mode} />
        <td>
          <code>{row().permission}</code>
        </td>
        <td>
          <code>{row().pattern}</code>
        </td>
        <td data-slot="operator-rule-action">
          <Show when={open()} fallback={<ActionTag action={line().rule.action} />}>
            <SelectV2<Action>
              appearance="base"
              aria-label={language.t("operator.permissionEditor.changeAction", { number: line().number })}
              options={ACTIONS}
              current={line().rule.action}
              label={(action) => language.t(`operator.permission.action.${action}`)}
              onSelect={(action) => action && choose(action)}
            />
          </Show>
        </td>
        <td>
          <span class="inline-flex items-center gap-1 flex-wrap">
            <Show
              when={change() !== undefined}
              fallback={
                <>
                  {origin(row().from)}
                  <Show when={row().part === "config"}>
                    <button type="button" data-slot="operator-link" onClick={() => navigate("/operator/config")}>
                      {language.t("operator.permissionEditor.openConfig")}
                    </button>
                  </Show>
                </>
              }
            >
              {changedText(props.mode, row(), origins()[change()!]?.from)}
              <Show when={!origins()[change()!]}>
                <Tag>{language.t("operator.permissionEditor.notSaved")}</Tag>
              </Show>
            </Show>
            <LineMarks line={line()} />
          </span>
        </td>
        <td data-align="end">
          <Show when={change() !== undefined}>
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              icon={<Icon name="reset" />}
              aria-label={language.t("operator.permissionEditor.undoChange", { number: line().number })}
              title={language.t("operator.permissionEditor.undoChange", { number: line().number })}
              onClick={() => {
                setEditing(at(), false)
                remove(change()!)
              }}
            />
          </Show>
        </td>
      </tr>
    )
  }

  // A rule of the editable part that changes no rule above: every field can be edited, and it can be
  // moved and removed.
  const Own = (line: () => Line<OperatorPermissionRow>) => {
    const index = () => line().own!
    const rule = () => props.value[index()]!
    const hint = () => hintOf(rule(), props.forms)
    return (
      <>
        <tr
          data-editable=""
          data-duplicate={duplicate(index()) ? "" : undefined}
          data-changed={changed(index()) ? "" : undefined}
          data-dragging={dragging() === index() ? "" : undefined}
          data-replaced={line().replacedBy ? "" : undefined}
          hidden={!shown(rule().permission)}
          draggable="true"
          onDragStart={(event) => {
            // Inputs keep their own drag (text selection); the row moves from its handle.
            if ((event.target as HTMLElement).closest("input")) return event.preventDefault()
            setDragging(index())
            event.dataTransfer?.setData("text/plain", String(index()))
          }}
          onDragOver={(event) => {
            if (dragging() === undefined) return
            event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            const from = dragging()
            setDragging(undefined)
            if (from !== undefined && from !== index()) move(from, index())
          }}
          onDragEnd={() => setDragging(undefined)}
        >
          <td>
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              icon={<Icon name="edit" />}
              aria-label={language.t("operator.permissionEditor.editRule", { index: index() + 1 })}
              onClick={(event) =>
                (event.currentTarget.closest("tr")?.querySelector("input") as HTMLInputElement | null)?.focus()
              }
            />
          </td>
          <LineNumber line={line()} mode={props.mode} />
          <td>
            <TextInputV2
              appearance="base"
              value={rule().permission}
              list={list}
              aria-label={language.t("operator.permissionEditor.permissionOf", { index: index() + 1 })}
              onChange={(event) => update(index(), { permission: event.currentTarget.value.trim() })}
            />
          </td>
          <td>
            <TextInputV2
              appearance="base"
              value={rule().pattern}
              placeholder="*"
              aria-label={language.t("operator.permissionEditor.patternOf", { index: index() + 1 })}
              onChange={(event) => update(index(), { pattern: event.currentTarget.value.trim() || "*" })}
            />
          </td>
          <td data-slot="operator-rule-action">
            <SelectV2<Action>
              appearance="base"
              aria-label={language.t("operator.permissionEditor.actionOf", { index: index() + 1 })}
              options={ACTIONS}
              current={rule().action}
              label={(action) => language.t(`operator.permission.action.${action}`)}
              onSelect={(action) => action && update(index(), { action })}
            />
          </td>
          <td>
            <span class="inline-flex items-center gap-1 flex-wrap">
              <Show when={origins()[index()]} fallback={<Tag>{language.t("operator.permissionEditor.newRule")}</Tag>}>
                {(row) => (
                  <span
                    title={
                      row().from.kind === "session-task" ? language.t("operator.permissionEditor.taskNote") : undefined
                    }
                  >
                    {origin(row().from)}
                  </span>
                )}
              </Show>
              <LineMarks line={line()} />
            </span>
          </td>
          <td data-align="end">
            <span class="inline-flex items-center">
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={language.t("operator.rules.up")}
                icon={<Icon name="arrow-up" />}
                disabled={index() === 0}
                onClick={() => move(index(), index() - 1)}
              />
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={language.t("operator.permissionEditor.down")}
                icon={<Icon name="arrow-down-to-line" />}
                disabled={index() === props.value.length - 1}
                onClick={() => move(index(), index() + 1)}
              />
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={language.t("operator.rules.remove")}
                icon={<Icon name="trash" />}
                onClick={() => remove(index())}
              />
            </span>
          </td>
        </tr>
        <Show when={hint()}>
          {(kind) => (
            <tr data-slot="operator-rule-hint" hidden={!shown(rule().permission)}>
              <td />
              <td />
              <td colSpan={5}>
                <p data-slot="operator-note" data-warning="" data-testid="rule-hint">
                  {language.t(`operator.permissionEditor.hint.${kind()}`, { permission: rule().permission })}
                </p>
              </td>
            </tr>
          )}
        </Show>
      </>
    )
  }

  return (
    <div data-component="operator-permission-editor" data-testid="permission-editor">
      <p data-slot="operator-note">
        {language.t("operator.permissionEditor.order")}{" "}
        {language.t(`operator.permissionEditor.changeNote.${props.mode}`)}
      </p>
      <Show when={props.filter}>
        <p data-slot="operator-note">
          {language.t("operator.permissionEditor.filtered", { permission: props.filter ?? "" })}{" "}
          <button type="button" data-slot="operator-link" onClick={() => props.onClearFilter?.()}>
            {language.t("operator.permissionEditor.showAll")}
          </button>
        </p>
      </Show>
      <datalist id={list}>
        <For each={props.known}>{(name) => <option value={name} />}</For>
      </datalist>
      <div data-component="operator-table">
        <table aria-label={language.t("operator.permissionEditor.label")}>
          <colgroup>
            <col style={{ width: "36px" }} />
            <col style={{ width: "40px" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "100px" }} />
            <col />
            <col style={{ width: "92px" }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" aria-label={language.t("operator.permissionEditor.editColumn")} />
              <th scope="col" data-align="end">
                #
                <FieldHelp field="#" text={language.t("operator.help.ruleNumber")} />
              </th>
              <th scope="col">{language.t("operator.column.permission")}</th>
              <th scope="col">{language.t("operator.column.pattern")}</th>
              <th scope="col">{language.t("operator.column.action")}</th>
              <th scope="col">
                {language.t("operator.toolPrompt.column.from")}
                <FieldHelp
                  field={language.t("operator.toolPrompt.column.from")}
                  text={language.t("operator.help.ruleFrom")}
                />
              </th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            <Index each={lines()}>
              {(line) => (
                <Show when={line().kind === "own"} fallback={Locked(line)}>
                  {Own(line)}
                </Show>
              )}
            </Index>
          </tbody>
        </table>
        <Show when={!props.value.length}>
          <div data-slot="operator-table-empty">
            {language.t(
              props.mode === "agent"
                ? "operator.permissionEditor.noAgentRules"
                : "operator.permissionEditor.sameAsAgent",
            )}
          </div>
        </Show>
      </div>

      <div data-slot="operator-rule-add" data-testid="permission-add">
        <TextInputV2
          ref={permissionField}
          appearance="base"
          value={draft.permission}
          list={list}
          placeholder={language.t("operator.rules.permission")}
          aria-label={language.t("operator.permissionEditor.newPermission")}
          onInput={(event) => setDraft("permission", event.currentTarget.value)}
        />
        <TextInputV2
          ref={patternField}
          appearance="base"
          value={draft.pattern}
          placeholder="*"
          aria-label={language.t("operator.permissionEditor.newPattern")}
          onInput={(event) => setDraft("pattern", event.currentTarget.value)}
        />
        <SelectV2<Action>
          appearance="base"
          aria-label={language.t("operator.permissionEditor.newAction")}
          options={ACTIONS}
          current={draft.action}
          label={(action) => language.t(`operator.permission.action.${action}`)}
          onSelect={(action) => action && setDraft("action", action)}
        />
        <ButtonV2
          size="small"
          variant="outline"
          onClick={() => {
            const permission = (permissionField?.value ?? draft.permission).trim()
            if (!permission) return permissionField?.focus()
            add({ permission, pattern: (patternField?.value ?? draft.pattern).trim() || "*", action: draft.action })
            setDraft({ permission: "", pattern: "*", action: "ask" })
          }}
        >
          {language.t("operator.rules.add")}
        </ButtonV2>
      </div>

      <Show when={check()?.duplicates.length}>
        <div data-slot="operator-order-check" data-testid="permission-duplicates">
          <For each={check()?.duplicates ?? []}>
            {(item) => (
              <p data-slot="operator-note" data-warning="">
                {language.t("operator.permissionEditor.duplicate", {
                  earlier: before().length + item.earlier + 1,
                  later: before().length + item.later + 1,
                })}{" "}
                <button
                  type="button"
                  data-slot="operator-link"
                  onClick={() => set(props.value.filter((_, position) => position !== item.earlier))}
                >
                  {language.t("operator.permissionEditor.removeEarlier")}
                </button>
              </p>
            )}
          </For>
        </div>
      </Show>
      <Show when={check()?.changed.length && !check()?.duplicates.length ? check() : undefined}>
        {(found) => (
          <div data-slot="operator-order-check" data-testid="permission-reorder">
            <p data-slot="operator-note" data-warning="">
              {language.t("operator.permissionEditor.reorder")}
            </p>
            <ol data-slot="operator-saved-order">
              <For each={found().saved}>
                {(rule) => {
                  const flipped = () =>
                    found().changed.some((index) => {
                      const item = props.value[index]
                      return (
                        !!item &&
                        item.permission.trim() === rule.permission &&
                        (item.pattern.trim() || "*") === rule.pattern
                      )
                    })
                  return (
                    <li data-changed={flipped() ? "" : undefined}>
                      <code>
                        {rule.permission} {rule.pattern} {rule.action}
                      </code>
                    </li>
                  )
                }}
              </For>
            </ol>
            <ButtonV2 size="small" variant="outline" onClick={() => set(found().saved)}>
              {language.t("operator.permissionEditor.useSavedOrder")}
            </ButtonV2>
          </div>
        )}
      </Show>
    </div>
  )
}

// The editable part's rules from the saved full list (agent: its own rows; session: the session's).
export function editableRules(rows: ReadonlyArray<OperatorPermissionRow>, part: "agent" | "session"): Rule[] {
  return rows
    .filter((row) => row.part === part)
    .map((row) => ({ permission: row.permission, pattern: row.pattern, action: row.action }))
}

// A rule's place in evaluation order. A change shown on another rule's line keeps the number of where
// it is checked.
function LineNumber(props: { line: Line<OperatorPermissionRow>; mode: "agent" | "session" }) {
  const language = useLanguage()
  const moved = () => props.line.kind === "locked" && props.line.own !== undefined
  return (
    <td
      data-align="end"
      title={
        moved()
          ? language.t(`operator.permissionEditor.changedNumber.${props.mode}`, { number: props.line.number })
          : undefined
      }
    >
      {props.line.number}
    </td>
  )
}

function ActionTag(props: { action: Action }) {
  const language = useLanguage()
  return (
    <Tag variant={props.action === "allow" ? "accent" : "neutral"}>
      {language.t(`operator.permission.action.${props.action}`)}
    </Tag>
  )
}

// What a line says about rules shown above it that are checked after it (see permission-lines.ts).
export function LineMarks(props: { line: Line<OperatorPermissionRow> }) {
  const language = useLanguage()
  const numbers = () => (props.line.partly ?? []).map((number) => `#${number}`).join(", ")
  return (
    <>
      <Show when={props.line.replacedBy}>
        {(number) => (
          <Tag data-warning="" title={language.t("operator.permissionEditor.replacedByHint", { number: number() })}>
            {language.t("operator.permissionEditor.replacedBy", { number: number() })}
          </Tag>
        )}
      </Show>
      <Show when={props.line.partly?.length}>
        <Tag data-warning="" title={language.t("operator.permissionEditor.partlyHint", { numbers: numbers() })}>
          {language.t("operator.permissionEditor.partly", { numbers: numbers() })}
        </Tag>
      </Show>
    </>
  )
}

// Where a changed rule's line comes from: who made the change (`by`, the saved change's origin; none
// while it is not saved), and the rule it changes.
export function useChangedText() {
  const language = useLanguage()
  const origin = useOriginText()
  return (mode: "agent" | "session", row: OperatorPermissionRow, by?: OperatorPermissionRow["from"]): string => {
    const was = { action: language.t(`operator.permission.action.${row.action}`), origin: origin(row.from) }
    return by
      ? language.t("operator.permissionEditor.changedBy", { ...was, by: origin(by) })
      : language.t(`operator.permissionEditor.changedFrom.${mode}`, was)
  }
}

// A rule's lines for the read-only list: `rows` is the saved full list with the editable part at
// `start`..`end` (the agent's own rules).
export function savedLines(rows: ReadonlyArray<OperatorPermissionRow>, part: { start: number; end: number }) {
  return linesOf(rows.slice(0, part.start), rows.slice(part.start, part.end), rows.slice(part.end))
}
