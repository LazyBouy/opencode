import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "./select"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorPermissionLevel as Level, OperatorPermissionRow } from "@opencode-ai/sdk/v2/client"
import { createUniqueId, For, Index, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "./field-help"
import { useOriginText } from "./permission-origin"
import { type Action, hintOf, type PatternForm, type Rule } from "./rules"
import { PatternHelp, useToolPatterns } from "./tool-pattern"

const ACTIONS: Action[] = ["allow", "ask", "deny"]

// Permissions in levels (tool_prompt_from_permission.md §3, §7), one editor for every level: Namespace,
// Project, Agent, Session. A call is checked tool first, then the most specific line that matches decides,
// at any level and in any order (the server's permission-model.ts), so lines are kept in the order they
// were added. A level starts from
// what it inherits and can change an inherited line's action (a line of its own with the same permission
// and pattern), delete it, lock it ("Can be overridden below: no", binding every level below), and add
// lines. A line a level above locked can't be changed, deleted or locked again here.

export type Key = { permission: string; pattern: string }
export type LevelValue = { lines: Rule[]; deleted: Key[]; locks: Key[] }

const sameKey = (a: Key, b: Key) => a.permission === b.permission && a.pattern === b.pattern
const keyOf = (rule: Key): Key => ({ permission: rule.permission, pattern: rule.pattern })

export function useLevelText() {
  const language = useLanguage()
  return (level: Level | undefined) => (level ? language.t(`operator.levels.level.${level}`) : "")
}

// A line's origin with its level: "Namespace · in /work/.opencode/opencode.jsonc".
export function useLineFrom() {
  const origin = useOriginText()
  const levelText = useLevelText()
  return (row: OperatorPermissionRow) => {
    const text = origin(row.from)
    // A built-in line's origin already says so.
    const level = row.level === "opencode" ? "" : levelText(row.level)
    return level && !text.startsWith(level) ? `${level} · ${text}` : text
  }
}

// The lines in force (read only), broadest first: as the server says they decide.
export function LevelTable(props: {
  rows: ReadonlyArray<OperatorPermissionRow>
  deleted?: ReadonlyArray<OperatorPermissionRow>
  level: Level
  label: string
  filter?: string
}) {
  const language = useLanguage()
  const from = useLineFrom()
  const levelText = useLevelText()
  const shown = (permission: string) =>
    !props.filter || permission === props.filter || permission === "*" || permission.includes("*")
  return (
    <div data-component="operator-table" data-testid="level-table">
      <table aria-label={props.label}>
        <thead>
          <tr>
            <th scope="col">{language.t("operator.column.permission")}</th>
            <th scope="col">{language.t("operator.column.pattern")}</th>
            <th scope="col">{language.t("operator.column.action")}</th>
            <th scope="col">
              {language.t("operator.toolPrompt.column.from")}
              <FieldHelp
                field={language.t("operator.toolPrompt.column.from")}
                text={language.t("operator.levels.fromHelp")}
              />
            </th>
            <th scope="col">
              {language.t("operator.levels.overridable")}
              <FieldHelp
                field={language.t("operator.levels.overridable")}
                text={language.t("operator.levels.overridableHelp")}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows.filter((row) => shown(row.permission))}>
            {(row) => (
              <tr data-level={row.level} data-locked={row.locked ? "" : undefined}>
                <td>
                  <code>{row.permission}</code>
                </td>
                <td>
                  <code>{row.pattern}</code>
                </td>
                <td>
                  <ActionTag action={row.action} />
                </td>
                <td>{from(row)}</td>
                <td>
                  <Show when={row.locked} fallback={language.t("operator.levels.yes")}>
                    {(locked) => (
                      <span class="inline-flex items-center gap-1">
                        <Icon name="shield" size="small" />
                        {language.t("operator.levels.lockedBy", { level: levelText(locked()) })}
                      </span>
                    )}
                  </Show>
                </td>
              </tr>
            )}
          </For>
          <For each={(props.deleted ?? []).filter((row) => shown(row.permission))}>
            {(row) => (
              <tr data-deleted="">
                <td>
                  <s>
                    <code>{row.permission}</code>
                  </s>
                </td>
                <td>
                  <s>
                    <code>{row.pattern}</code>
                  </s>
                </td>
                <td>
                  <ActionTag action={row.action} />
                </td>
                <td>{language.t("operator.levels.deletedHere", { from: from(row) })}</td>
                <td />
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

// Editing a level: what it inherits (each line can be changed, deleted or locked here, unless a level
// above locked it), then the level's own lines in the order they were added.
export function LevelEditor(props: {
  level: Level
  // The lines the level inherits, as they are before its own changes (broadest first).
  inherited: ReadonlyArray<OperatorPermissionRow>
  // The level's own lines as saved, with where each came from (a session's: by you, Always, Allow for
  // session); a line not among them is new.
  ownRows?: ReadonlyArray<OperatorPermissionRow>
  value: LevelValue
  onChange: (value: LevelValue) => void
  canDeleteOpenCode: boolean
  // Deleting inherited lines here (the agent form leaves it to the Permissions tab).
  canDelete?: boolean
  // Sessions don't lock: no level is below them.
  canLock: boolean
  forms: Readonly<Record<string, PatternForm>>
  known: ReadonlyArray<string>
  // The project whose tools' permission patterns help with a new rule (the page's chosen one when none).
  directory?: string
  filter?: string
  onClearFilter?: () => void
}) {
  const language = useLanguage()
  const from = useLineFrom()
  const levelText = useLevelText()
  const list = createUniqueId()
  const [draft, setDraft] = createStore({ permission: "", pattern: "*", action: "ask" as Action })
  const patterns = useToolPatterns(() => props.directory)
  let permissionField: HTMLInputElement | undefined
  let patternField: HTMLInputElement | undefined

  const shown = (permission: string) =>
    !props.filter || permission === props.filter || permission === "*" || permission.includes("*")
  const set = (change: Partial<LevelValue>) => props.onChange({ ...props.value, ...change })
  const locked = (key: Key) => props.value.locks.some((item) => sameKey(item, key))
  const toggleLock = (key: Key, lock: boolean) =>
    set({
      locks: lock
        ? [...props.value.locks.filter((item) => !sameKey(item, key)), keyOf(key)]
        : props.value.locks.filter((item) => !sameKey(item, key)),
    })
  // The level's own lines that change no inherited line: added here.
  const added = () =>
    props.value.lines
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => !props.inherited.some((row) => sameKey(row, rule)))

  // An inherited line: its action here is the level's own line with the same key, else its own.
  const Inherited = (row: () => OperatorPermissionRow) => {
    const own = () => props.value.lines.findIndex((rule) => sameKey(rule, row()))
    const action = () => (own() >= 0 ? props.value.lines[own()]!.action : row().action)
    const deleted = () => props.value.deleted.some((key) => sameKey(key, row()))
    const above = () => (row().locked && row().locked !== props.level ? row().locked : undefined)
    const protectedLine = () => row().level === "opencode" && !props.canDeleteOpenCode
    const choose = (next: Action) => {
      const lines = props.value.lines.filter((rule) => !sameKey(rule, row()))
      set({ lines: next === row().action ? lines : [...lines, { ...keyOf(row()), action: next }] })
    }
    return (
      <tr
        data-level={row().level}
        data-deleted={deleted() ? "" : undefined}
        data-changed={own() >= 0 ? "" : undefined}
        hidden={!shown(row().permission)}
      >
        <td>
          <Show when={deleted()} fallback={<code>{row().permission}</code>}>
            <s>
              <code>{row().permission}</code>
            </s>
          </Show>
        </td>
        <td>
          <Show when={deleted()} fallback={<code>{row().pattern}</code>}>
            <s>
              <code>{row().pattern}</code>
            </s>
          </Show>
        </td>
        <td data-slot="operator-rule-action">
          <Show when={!above() && !deleted()} fallback={<ActionTag action={row().action} />}>
            <SelectV2<Action>
              appearance="base"
              aria-label={language.t("operator.levels.actionOf", {
                permission: row().permission,
                pattern: row().pattern,
              })}
              options={ACTIONS}
              current={action()}
              label={(item) => language.t(`operator.permission.action.${item}`)}
              onSelect={(item) => item && choose(item)}
            />
          </Show>
        </td>
        <td>
          <span class="inline-flex items-center gap-1 flex-wrap">
            {from(row())}
            <Show when={own() >= 0}>
              <Tag>{language.t("operator.levels.changedHere", { action: row().action })}</Tag>
            </Show>
            <Show when={deleted()}>
              <Tag>{language.t("operator.levels.deleted")}</Tag>
            </Show>
          </span>
        </td>
        <td>
          <Show
            when={!above()}
            fallback={
              <span class="inline-flex items-center gap-1" data-testid="locked-above">
                <Icon name="shield" size="small" />
                {language.t("operator.levels.lockedBy", { level: levelText(above()) })}
              </span>
            }
          >
            <Show when={props.canLock && !deleted()}>
              <CheckboxV2
                label={language.t("operator.locks.mayOverride", { rule: `${row().permission} ${row().pattern}` })}
                hideLabel
                checked={!locked(row())}
                onChange={(checked: boolean) => toggleLock(row(), !checked)}
              />
            </Show>
          </Show>
        </td>
        <td data-align="end">
          <Show
            when={deleted()}
            fallback={
              <Show when={props.canDelete !== false && !above() && !protectedLine()}>
                <IconButtonV2
                  variant="ghost-muted"
                  size="small"
                  icon={<Icon name="trash" />}
                  aria-label={language.t("operator.levels.deleteLine", {
                    permission: row().permission,
                    pattern: row().pattern,
                  })}
                  onClick={() =>
                    set({
                      deleted: [...props.value.deleted, keyOf(row())],
                      lines: props.value.lines.filter((rule) => !sameKey(rule, row())),
                      locks: props.value.locks.filter((item) => !sameKey(item, row())),
                    })
                  }
                />
              </Show>
            }
          >
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => set({ deleted: props.value.deleted.filter((key) => !sameKey(key, row())) })}
            >
              {language.t("operator.levels.restore")}
            </ButtonV2>
          </Show>
        </td>
      </tr>
    )
  }

  const Own = (item: () => { rule: Rule; index: number }) => {
    const rule = () => item().rule
    const update = (change: Partial<Rule>) => {
      const lines = props.value.lines.map((line, position) =>
        position === item().index ? { ...line, ...change } : line,
      )
      // A lock follows its line when the line's permission or pattern changes.
      const locks =
        change.permission !== undefined || change.pattern !== undefined
          ? props.value.locks.map((key) => (sameKey(key, rule()) ? keyOf({ ...rule(), ...change }) : key))
          : props.value.locks
      set({ lines, locks })
    }
    const hint = () => hintOf(rule(), props.forms)
    return (
      <>
        <tr data-editable="" data-level={props.level} hidden={!shown(rule().permission)}>
          <td>
            <TextInputV2
              appearance="base"
              value={rule().permission}
              list={list}
              aria-label={language.t("operator.permissionEditor.permissionOf", { index: item().index + 1 })}
              onChange={(event) => update({ permission: event.currentTarget.value.trim() })}
            />
          </td>
          <td>
            <TextInputV2
              appearance="base"
              value={rule().pattern}
              placeholder="*"
              aria-label={language.t("operator.permissionEditor.patternOf", { index: item().index + 1 })}
              onChange={(event) => update({ pattern: event.currentTarget.value.trim() || "*" })}
            />
          </td>
          <td data-slot="operator-rule-action">
            <SelectV2<Action>
              appearance="base"
              aria-label={language.t("operator.permissionEditor.actionOf", { index: item().index + 1 })}
              options={ACTIONS}
              current={rule().action}
              label={(action) => language.t(`operator.permission.action.${action}`)}
              onSelect={(action) => action && update({ action })}
            />
          </td>
          <td>
            <Show
              when={(props.ownRows ?? []).find((row) => sameKey(row, rule()) && row.action === rule().action)}
              fallback={
                <span class="inline-flex items-center gap-1">
                  {language.t("operator.levels.addedHere", { level: levelText(props.level) })}
                  <Tag>{language.t("operator.permissionEditor.notSaved")}</Tag>
                </span>
              }
            >
              {(row) => from(row())}
            </Show>
          </td>
          <td>
            <Show when={props.canLock}>
              <CheckboxV2
                label={language.t("operator.locks.mayOverride", { rule: `${rule().permission} ${rule().pattern}` })}
                hideLabel
                checked={!locked(rule())}
                onChange={(checked: boolean) => toggleLock(rule(), !checked)}
              />
            </Show>
          </td>
          <td data-align="end">
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              icon={<Icon name="trash" />}
              aria-label={language.t("operator.rules.remove")}
              onClick={() =>
                set({
                  lines: props.value.lines.filter((_, position) => position !== item().index),
                  locks: props.value.locks.filter((key) => !sameKey(key, rule())),
                })
              }
            />
          </td>
        </tr>
        <Show when={hint()}>
          {(kind) => (
            <tr data-slot="operator-rule-hint" hidden={!shown(rule().permission)}>
              <td colSpan={6}>
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

  const header = () => (
    <thead>
      <tr>
        <th scope="col">{language.t("operator.column.permission")}</th>
        <th scope="col">{language.t("operator.column.pattern")}</th>
        <th scope="col">{language.t("operator.column.action")}</th>
        <th scope="col">{language.t("operator.toolPrompt.column.from")}</th>
        <th scope="col">
          {language.t("operator.levels.overridable")}
          <FieldHelp
            field={language.t("operator.levels.overridable")}
            text={language.t("operator.levels.overridableHelp")}
          />
        </th>
        <th scope="col" />
      </tr>
    </thead>
  )

  return (
    <div data-component="operator-level-editor" data-testid="level-editor">
      <p data-slot="operator-note">{language.t("operator.levels.how")}</p>
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

      <h4 data-slot="operator-panel-title">{language.t("operator.levels.inherited")}</h4>
      <div data-component="operator-table" data-testid="level-inherited">
        <table aria-label={language.t("operator.levels.inherited")}>
          {header()}
          <tbody>
            <Index each={props.inherited}>{(row) => Inherited(row)}</Index>
          </tbody>
        </table>
        <Show when={!props.inherited.length}>
          <div data-slot="operator-table-empty">{language.t("operator.levels.inheritsNothing")}</div>
        </Show>
      </div>

      <h4 data-slot="operator-panel-title">{language.t("operator.levels.own", { level: levelText(props.level) })}</h4>
      <div data-component="operator-table" data-testid="level-own">
        <table aria-label={language.t("operator.levels.own", { level: levelText(props.level) })}>
          {header()}
          <tbody>
            <Index each={added()}>{(item) => Own(item)}</Index>
          </tbody>
        </table>
        <Show when={!added().length}>
          <div data-slot="operator-table-empty">{language.t("operator.levels.noOwn")}</div>
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
            const rule = {
              permission,
              pattern: (patternField?.value ?? draft.pattern).trim() || "*",
              action: draft.action,
            }
            // The same permission and pattern again replaces the earlier line.
            set({ lines: [...props.value.lines.filter((line) => !sameKey(line, rule)), rule] })
            setDraft({ permission: "", pattern: "*", action: "ask" })
          }}
        >
          {language.t("operator.rules.add")}
        </ButtonV2>
      </div>
      <PatternHelp patterns={patterns.data} permission={draft.permission} />
    </div>
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
