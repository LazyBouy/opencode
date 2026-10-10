import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type {
  OperatorResolver,
  OperatorResolverFilter,
  OperatorResolverRule,
  OperatorResolverSource,
} from "@opencode-ai/sdk/v2/client"
import { createEffect, For, Index, type JSX, on, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Field } from "../ui/field"
import { move } from "./profile-model"

// A Dynamic layer's rules (dynamic_layer_resolution_spec.md §6): its sources, filters, scoring rules,
// selection and template. `RulesView` shows them; `RulesForm` edits them, every line in place.

type Kind = OperatorResolverSource["kind"]
type FilterKind = OperatorResolverFilter["kind"]
type RuleKind = OperatorResolverRule["kind"]
type Policy = OperatorResolver["select"]["policy"]

// The kinds a layer's own rules can read (memory comes with the memory layers); a helper only for yours.
const KINDS: Kind[] = ["file", "config", "url", "live", "registry", "agent-field", "text", "helper"]
const FILTERS: FilterKind[] = ["available", "permission", "size", "attribute", "flag"]
const RULES: RuleKind[] = ["precedence", "match", "prefer", "present", "recency", "size", "priority"]
const POLICIES: Policy[] = ["one", "top", "all"]

// Texts with line breaks are shown and typed on one line: \n, \t and \\.
export const escaped = (text: string | undefined) =>
  (text ?? "").replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t")
const unescaped = (text: string) =>
  text.replace(/\\(n|t|\\)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : "\\"))
const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
const optionalNumber = (text: string) => (text.trim() === "" || Number.isNaN(Number(text)) ? undefined : Number(text))
// `per`: "config=all, project=one".
const perText = (per: OperatorResolver["select"]["per"]) =>
  Object.entries(per ?? {})
    .map(([group, policy]) => `${group}=${policy}`)
    .join(", ")
const perOf = (text: string) => {
  const pairs = list(text).flatMap((pair) => {
    const [group, policy] = pair.split("=").map((part) => part.trim())
    return group && POLICIES.includes(policy as Policy) ? [[group, policy as Policy] as const] : []
  })
  return pairs.length ? Object.fromEntries(pairs) : undefined
}

export const hasHelper = (rules: OperatorResolver | undefined) =>
  !!rules?.sources.some((source) => source.kind === "helper")

const newFilter = (kind: FilterKind): OperatorResolverFilter =>
  kind === "available"
    ? { kind, need: "text" }
    : kind === "permission"
      ? { kind, permission: "" }
      : kind === "size"
        ? { kind, max: 4000 }
        : kind === "attribute"
          ? { kind, attribute: "", present: true }
          : { kind, attribute: "", reason: "" }
const newRule = (kind: RuleKind, weight = 1): OperatorResolverRule =>
  kind === "precedence"
    ? { kind, attribute: "name", weight }
    : kind === "match"
      ? { kind, attribute: "name", weight }
      : kind === "prefer"
        ? { kind, order: [], weight }
        : { kind, weight }

function useWords() {
  const language = useLanguage()
  const t = language.t
  return {
    kind: (kind: Kind) => t(`operator.layerRules.kind.${kind}` as "operator.layerRules.kind.file"),
    hint: (kind: Kind) => t(`operator.layerRules.where.${kind}` as "operator.layerRules.where.file"),
    filter: (filter: OperatorResolverFilter) => {
      if (filter.kind === "available")
        return t(filter.need === "exists" ? "operator.layerRules.filter.exists" : "operator.layerRules.filter.text")
      if (filter.kind === "permission")
        return t("operator.layerRules.filter.permissionIs", { permission: filter.permission })
      if (filter.kind === "size") return t("operator.layerRules.filter.sizeIs", { max: filter.max })
      if (filter.kind === "attribute")
        return t(filter.present ? "operator.layerRules.filter.has" : "operator.layerRules.filter.hasNot", {
          attribute: filter.attribute,
        })
      return t("operator.layerRules.filter.flagIs", { attribute: filter.attribute, reason: filter.reason })
    },
    rule: (rule: OperatorResolverRule) => {
      if (rule.kind === "precedence")
        return rule.order?.length
          ? t("operator.layerRules.rule.precedenceIs", { attribute: rule.attribute, order: rule.order.join(", ") })
          : t("operator.layerRules.rule.alphabetical", { attribute: rule.attribute })
      if (rule.kind === "match")
        return rule.pattern !== undefined
          ? t("operator.layerRules.rule.matchPattern", { attribute: rule.attribute, pattern: rule.pattern })
          : t("operator.layerRules.rule.matchEquals", { attribute: rule.attribute, value: rule.equals ?? "" })
      if (rule.kind === "prefer") return t("operator.layerRules.rule.preferIs", { order: rule.order.join(", ") })
      return t(`operator.layerRules.rule.${rule.kind}` as "operator.layerRules.rule.recency")
    },
    policy: (select: OperatorResolver["select"]) =>
      select.policy === "top"
        ? t("operator.layerRules.policy.topN", { n: select.n ?? 1 })
        : t(`operator.layerRules.policy.${select.policy}` as "operator.layerRules.policy.one"),
    t,
  }
}

// The rules, read-only: OpenCode's, a copy's, yours.
export function RulesView(props: { rules: OperatorResolver; note: string; actions?: JSX.Element }) {
  const words = useWords()
  const select = () => props.rules.select
  return (
    <section data-component="operator-rules" data-testid="layer-rules">
      <h4 data-slot="operator-panel-title">
        {words.t("operator.layerRules.title")} <span data-slot="operator-note">{props.note}</span>
      </h4>
      <div data-component="operator-table">
        <table aria-label={words.t("operator.layerRules.sources")}>
          <thead>
            <tr>
              <th>{words.t("operator.layerRules.kind")}</th>
              <th>{words.t("operator.layerRules.location")}</th>
              <th>{words.t("operator.layerRules.group")}</th>
              <th>{words.t("operator.layerRules.name")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rules.sources}>
              {(source) => (
                <tr data-testid="rules-source">
                  <td>{words.kind(source.kind)}</td>
                  <td>
                    <code>{source.location}</code>
                    <Show when={source.text}>{(text) => <pre data-component="operator-code">{text()}</pre>}</Show>
                  </td>
                  <td>{source.group ?? "—"}</td>
                  <td>{source.name ?? "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <dl data-component="record-fields">
        <dt>{words.t("operator.layerRules.filters")}</dt>
        <dd data-testid="rules-filters">
          <Show when={props.rules.filter.length} fallback="—">
            {props.rules.filter.map(words.filter).join(" · ")}
          </Show>
        </dd>
        <dt>{words.t("operator.layerRules.scoring")}</dt>
        <dd data-testid="rules-scoring">
          <Show when={props.rules.score.length} fallback="—">
            {props.rules.score.map((rule) => `${words.rule(rule)} × ${rule.weight}`).join(" · ")}
          </Show>
        </dd>
        <dt>{words.t("operator.layerRules.selection")}</dt>
        <dd data-testid="rules-selection">
          {[
            words.policy(select()),
            ...(select().per ? [words.t("operator.layerRules.perIs", { per: perText(select().per) })] : []),
            ...(select().groups?.length
              ? [words.t("operator.layerRules.groupsIs", { groups: select().groups!.join(", ") })]
              : []),
            ...(select().unique ? [words.t("operator.layerRules.uniqueIs", { attribute: select().unique! })] : []),
            ...(select().budget ? [words.t("operator.layerRules.budgetIs", { chars: select().budget! })] : []),
            ...(select().perSource ? [words.t("operator.layerRules.perSourceIs", { chars: select().perSource! })] : []),
          ].join(" · ")}
        </dd>
        <dt>{words.t("operator.layerRules.template")}</dt>
        <dd>
          <pre data-component="operator-code" data-testid="rules-template">
            {[
              props.rules.template.header !== undefined ? `header: ${escaped(props.rules.template.header)}` : "",
              `item: ${escaped(props.rules.template.item)}`,
              `separator: ${escaped(props.rules.template.separator)}`,
              props.rules.template.footer !== undefined ? `footer: ${escaped(props.rules.template.footer)}` : "",
              props.rules.template.empty !== undefined ? `empty: ${escaped(props.rules.template.empty)}` : "",
            ]
              .filter(Boolean)
              .join("\n")}
          </pre>
        </dd>
      </dl>
      <Show when={props.actions}>
        <div data-slot="operator-actions">{props.actions}</div>
      </Show>
    </section>
  )
}

// The rules, edited in place: each line of a list edits where it is, and moves or goes with its buttons.
export function RulesForm(props: {
  value: OperatorResolver
  // Your Dynamic layers can have a helper source (it writes from the layer's prompt).
  helper: boolean
  onChange: (rules: OperatorResolver) => void
}) {
  const words = useWords()
  const t = words.t
  const [draft, setDraft] = createStore<OperatorResolver>(structuredClone(unwrap(props.value)))
  createEffect(
    on(
      () => props.value,
      (value) => setDraft(reconcile(structuredClone(unwrap(value)))),
      { defer: true },
    ),
  )
  const emit = () => props.onChange(structuredClone(unwrap(draft)))
  const update = (change: (rules: OperatorResolver) => OperatorResolver) => {
    setDraft(reconcile(change(structuredClone(unwrap(draft)))))
    emit()
  }
  const kinds = () => KINDS.filter((kind) => kind !== "helper" || props.helper)
  const lineButtons = (count: number, index: number, name: string, apply: (step: -1 | 1 | 0) => void) => (
    <span class="flex items-center">
      <IconButtonV2
        variant="ghost-muted"
        size="small"
        disabled={index === 0}
        aria-label={t("operator.profile.up", { name })}
        icon={<Icon name="arrow-up" />}
        onClick={() => apply(-1)}
      />
      <IconButtonV2
        variant="ghost-muted"
        size="small"
        disabled={index === count - 1}
        aria-label={t("operator.profile.down", { name })}
        icon={<Icon name="chevron-down" />}
        onClick={() => apply(1)}
      />
      <IconButtonV2
        variant="ghost-muted"
        size="small"
        aria-label={t("operator.profile.removeFrom", { name })}
        icon={<Icon name="close-small" />}
        onClick={() => apply(0)}
      />
    </span>
  )
  const reorder = <T,>(items: ReadonlyArray<T>, index: number, step: -1 | 1 | 0) =>
    step === 0 ? items.filter((_, at) => at !== index) : move([...items], index, step)

  // One setting of Selection or Template: its name, its control.
  const setting = (label: string, control: JSX.Element) => (
    <tr data-editable="">
      <th scope="row">{label}</th>
      <td>{control}</td>
    </tr>
  )
  const selectNumber = (key: "n" | "budget" | "perSource", label: string) =>
    setting(
      label,
      <TextInputV2
        appearance="base"
        aria-label={label}
        value={draft.select[key] === undefined ? "" : String(draft.select[key])}
        onInput={(event) => {
          const value = optionalNumber(event.currentTarget.value)
          update((rules) => ({ ...rules, select: { ...rules.select, [key]: value } }))
        }}
      />,
    )
  const selectText = (key: "overflow" | "unique", label: string, placeholder?: string) =>
    setting(
      label,
      <TextInputV2
        appearance="base"
        aria-label={label}
        placeholder={placeholder}
        value={draft.select[key] ?? ""}
        onInput={(event) => {
          const value = key === "unique" ? event.currentTarget.value.trim() : event.currentTarget.value
          update((rules) => ({ ...rules, select: { ...rules.select, [key]: value || undefined } }))
        }}
      />,
    )
  const templateText = (key: "header" | "item" | "separator" | "footer" | "empty", label: string) =>
    setting(
      label,
      <TextInputV2
        appearance="base"
        aria-label={label}
        value={escaped(draft.template[key])}
        onInput={(event) => {
          const raw = event.currentTarget.value
          const value = unescaped(raw)
          update((rules) => ({
            ...rules,
            template: {
              ...rules.template,
              [key]: key === "item" || key === "separator" ? value : raw === "" ? undefined : value,
            },
          }))
        }}
      />,
    )

  return (
    <div data-component="operator-rules-form" data-testid="rules-form">
      <h4 data-slot="operator-panel-title">{t("operator.layerRules.title")}</h4>

      <Field group label={t("operator.layerRules.sources")} hint={t("operator.help.rulesSources")}>
        <div data-component="operator-table">
          <table aria-label={t("operator.layerRules.sources")}>
            <thead>
              <tr>
                <th data-slot="operator-rules-kind">{t("operator.layerRules.kind")}</th>
                <th>{t("operator.layerRules.location")}</th>
                <th data-slot="operator-rules-group">{t("operator.layerRules.group")}</th>
                <th data-slot="operator-rules-group">{t("operator.layerRules.sourceName")}</th>
                <th data-slot="operator-rules-narrow">{t("operator.layerRules.priority")}</th>
                <th data-slot="operator-rules-actions" />
              </tr>
            </thead>
            <tbody>
              <Index each={draft.sources}>
                {(source, index) => (
                  <>
                    <tr data-editable="" data-testid="rules-source-line">
                      <td data-slot="operator-rules-kind">
                        <SelectV2<Kind>
                          appearance="base"
                          aria-label={t("operator.layerRules.kind")}
                          options={kinds()}
                          current={source().kind}
                          label={words.kind}
                          onSelect={(kind) =>
                            kind &&
                            kind !== source().kind &&
                            // Another kind starts the line again (its location means something else).
                            update((rules) => ({
                              ...rules,
                              sources: rules.sources.map((item, at) =>
                                at === index
                                  ? { kind, location: "", ...(item.group ? { group: item.group } : {}) }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </td>
                      <td>
                        <TextInputV2
                          appearance="base"
                          aria-label={t("operator.layerRules.location")}
                          placeholder={words.hint(source().kind)}
                          value={source().location}
                          onInput={(event) => {
                            setDraft("sources", index, "location", event.currentTarget.value)
                            emit()
                          }}
                        />
                      </td>
                      <td>
                        <TextInputV2
                          appearance="base"
                          aria-label={t("operator.layerRules.group")}
                          value={source().group ?? ""}
                          onInput={(event) => {
                            const value = event.currentTarget.value.trim()
                            update((rules) => ({
                              ...rules,
                              sources: rules.sources.map((item, at) =>
                                at === index ? { ...item, group: value || undefined } : item,
                              ),
                            }))
                          }}
                        />
                      </td>
                      <td>
                        <TextInputV2
                          appearance="base"
                          aria-label={t("operator.layerRules.sourceName")}
                          value={source().name ?? ""}
                          onInput={(event) => {
                            const value = event.currentTarget.value
                            update((rules) => ({
                              ...rules,
                              sources: rules.sources.map((item, at) =>
                                at === index ? { ...item, name: value || undefined } : item,
                              ),
                            }))
                          }}
                        />
                      </td>
                      <td data-slot="operator-rules-narrow">
                        <TextInputV2
                          appearance="base"
                          aria-label={t("operator.layerRules.priority")}
                          value={source().priority === undefined ? "" : String(source().priority)}
                          onInput={(event) => {
                            const value = optionalNumber(event.currentTarget.value)
                            update((rules) => ({
                              ...rules,
                              sources: rules.sources.map((item, at) =>
                                at === index ? { ...item, priority: value } : item,
                              ),
                            }))
                          }}
                        />
                      </td>
                      <td data-slot="operator-rules-actions">
                        {lineButtons(
                          draft.sources.length,
                          index,
                          source().location || words.kind(source().kind),
                          (step) => update((rules) => ({ ...rules, sources: reorder(rules.sources, index, step) })),
                        )}
                      </td>
                    </tr>
                    <Show when={source().kind === "text"}>
                      <tr data-editable="">
                        <td colSpan={6}>
                          <TextareaV2
                            class="operator-editor"
                            rows={4}
                            aria-label={t("operator.layerRules.text")}
                            value={source().text ?? ""}
                            onInput={(event) => {
                              setDraft("sources", index, "text", event.currentTarget.value)
                              emit()
                            }}
                          />
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </Index>
            </tbody>
          </table>
        </div>
        <span>
          <ButtonV2
            size="small"
            variant="outline"
            onClick={() =>
              update((rules) => ({ ...rules, sources: [...rules.sources, { kind: "file", location: "" }] }))
            }
          >
            {t("operator.layerRules.addSource")}
          </ButtonV2>
        </span>
      </Field>

      <Field group label={t("operator.layerRules.filters")} hint={t("operator.help.rulesFilters")}>
        <div data-component="operator-table">
          <table aria-label={t("operator.layerRules.filters")}>
            <tbody>
              <Index each={draft.filter}>
                {(filter, index) => {
                  const set = (next: OperatorResolverFilter) =>
                    update((rules) => ({
                      ...rules,
                      filter: rules.filter.map((item, at) => (at === index ? next : item)),
                    }))
                  return (
                    <tr data-editable="" data-testid="rules-filter-line">
                      <td data-slot="operator-rules-kind">
                        <SelectV2<FilterKind>
                          appearance="base"
                          aria-label={t("operator.layerRules.filter")}
                          options={FILTERS}
                          current={filter().kind}
                          label={(kind) =>
                            t(`operator.layerRules.filterKind.${kind}` as "operator.layerRules.filterKind.size")
                          }
                          onSelect={(kind) => kind && kind !== filter().kind && set(newFilter(kind))}
                        />
                      </td>
                      <td>
                        <div data-slot="operator-rules-settings">
                          {(() => {
                            const item = filter()
                            if (item.kind === "available")
                              return (
                                <SelectV2<"exists" | "text">
                                  appearance="base"
                                  aria-label={t("operator.layerRules.need")}
                                  options={["exists", "text"]}
                                  current={item.need}
                                  label={(need) =>
                                    t(`operator.layerRules.filter.${need}` as "operator.layerRules.filter.text")
                                  }
                                  onSelect={(need) => need && set({ ...item, need })}
                                />
                              )
                            if (item.kind === "permission")
                              return (
                                <TextInputV2
                                  appearance="base"
                                  aria-label={t("operator.rules.permission")}
                                  placeholder="skill"
                                  value={item.permission}
                                  onInput={(event) => set({ ...item, permission: event.currentTarget.value.trim() })}
                                />
                              )
                            if (item.kind === "size")
                              return (
                                <TextInputV2
                                  appearance="base"
                                  aria-label={t("operator.layerRules.max")}
                                  placeholder={t("operator.layerRules.max")}
                                  value={String(item.max)}
                                  onInput={(event) =>
                                    set({ ...item, max: optionalNumber(event.currentTarget.value) ?? 0 })
                                  }
                                />
                              )
                            return (
                              <>
                                <TextInputV2
                                  appearance="base"
                                  aria-label={t("operator.layerRules.attribute")}
                                  placeholder={t("operator.layerRules.attribute")}
                                  value={item.attribute}
                                  onInput={(event) => set({ ...item, attribute: event.currentTarget.value.trim() })}
                                />
                                <Show
                                  when={item.kind === "attribute" ? item : undefined}
                                  fallback={
                                    <TextInputV2
                                      appearance="base"
                                      aria-label={t("operator.layerRules.reason")}
                                      placeholder={t("operator.layerRules.reason")}
                                      value={item.kind === "flag" ? item.reason : ""}
                                      onInput={(event) =>
                                        item.kind === "flag" && set({ ...item, reason: event.currentTarget.value })
                                      }
                                    />
                                  }
                                >
                                  {(attribute) => (
                                    <CheckboxV2
                                      label={t("operator.layerRules.present")}
                                      checked={attribute().present}
                                      onChange={(present: boolean) => set({ ...attribute(), present })}
                                    />
                                  )}
                                </Show>
                              </>
                            )
                          })()}
                        </div>
                      </td>
                      <td data-slot="operator-rules-actions">
                        {lineButtons(draft.filter.length, index, words.filter(filter()), (step) =>
                          update((rules) => ({ ...rules, filter: reorder(rules.filter, index, step) })),
                        )}
                      </td>
                    </tr>
                  )
                }}
              </Index>
            </tbody>
          </table>
        </div>
        <span>
          <ButtonV2
            size="small"
            variant="outline"
            onClick={() => update((rules) => ({ ...rules, filter: [...rules.filter, newFilter("available")] }))}
          >
            {t("operator.layerRules.addFilter")}
          </ButtonV2>
        </span>
      </Field>

      <Field group label={t("operator.layerRules.scoring")} hint={t("operator.help.rulesScoring")}>
        <div data-component="operator-table">
          <table aria-label={t("operator.layerRules.scoring")}>
            <tbody>
              <Index each={draft.score}>
                {(rule, index) => {
                  const set = (next: OperatorResolverRule) =>
                    update((rules) => ({
                      ...rules,
                      score: rules.score.map((item, at) => (at === index ? next : item)),
                    }))
                  return (
                    <tr data-editable="" data-testid="rules-rule-line">
                      <td data-slot="operator-rules-kind">
                        <SelectV2<RuleKind>
                          appearance="base"
                          aria-label={t("operator.layerRules.rule")}
                          options={RULES}
                          current={rule().kind}
                          label={(kind) =>
                            t(`operator.layerRules.ruleKind.${kind}` as "operator.layerRules.ruleKind.size")
                          }
                          onSelect={(kind) => kind && kind !== rule().kind && set(newRule(kind, rule().weight))}
                        />
                      </td>
                      <td>
                        <div data-slot="operator-rules-settings">
                          <TextInputV2
                            appearance="base"
                            aria-label={t("operator.layerRules.weight")}
                            placeholder={t("operator.layerRules.weight")}
                            value={String(rule().weight)}
                            onInput={(event) =>
                              set({ ...rule(), weight: optionalNumber(event.currentTarget.value) ?? 0 })
                            }
                          />
                          {(() => {
                            const item = rule()
                            if (item.kind !== "precedence" && item.kind !== "match") return undefined
                            return (
                              <TextInputV2
                                appearance="base"
                                aria-label={t("operator.layerRules.attribute")}
                                placeholder={t("operator.layerRules.attribute")}
                                value={item.attribute}
                                onInput={(event) => set({ ...item, attribute: event.currentTarget.value.trim() })}
                              />
                            )
                          })()}
                          {(() => {
                            const item = rule()
                            if (item.kind === "precedence" || item.kind === "prefer")
                              return (
                                <TextInputV2
                                  appearance="base"
                                  aria-label={t("operator.layerRules.order")}
                                  placeholder={t("operator.layerRules.order")}
                                  value={(item.order ?? []).join(", ")}
                                  onInput={(event) => {
                                    const order = list(event.currentTarget.value)
                                    if (item.kind === "prefer") set({ ...item, order })
                                    else set({ ...item, order: order.length ? order : undefined })
                                  }}
                                />
                              )
                            if (item.kind === "match")
                              return (
                                <>
                                  <TextInputV2
                                    appearance="base"
                                    aria-label={t("operator.layerRules.equals")}
                                    placeholder={t("operator.layerRules.equals")}
                                    value={item.equals ?? ""}
                                    onInput={(event) =>
                                      set({ ...item, equals: event.currentTarget.value || undefined })
                                    }
                                  />
                                  <TextInputV2
                                    appearance="base"
                                    aria-label={t("operator.layerRules.pattern")}
                                    placeholder={t("operator.layerRules.pattern")}
                                    value={item.pattern ?? ""}
                                    onInput={(event) =>
                                      set({ ...item, pattern: event.currentTarget.value || undefined })
                                    }
                                  />
                                </>
                              )
                            return undefined
                          })()}
                        </div>
                      </td>
                      <td data-slot="operator-rules-actions">
                        {lineButtons(draft.score.length, index, words.rule(rule()), (step) =>
                          update((rules) => ({ ...rules, score: reorder(rules.score, index, step) })),
                        )}
                      </td>
                    </tr>
                  )
                }}
              </Index>
            </tbody>
          </table>
        </div>
        <span>
          <ButtonV2
            size="small"
            variant="outline"
            onClick={() => update((rules) => ({ ...rules, score: [...rules.score, newRule("recency")] }))}
          >
            {t("operator.layerRules.addRule")}
          </ButtonV2>
        </span>
      </Field>

      <Field group label={t("operator.layerRules.selection")} hint={t("operator.help.rulesSelection")}>
        <div data-component="operator-table" data-testid="rules-selection-form">
          <table aria-label={t("operator.layerRules.selection")}>
            <tbody>
              {setting(
                t("operator.layerRules.policy"),
                <SelectV2<Policy>
                  appearance="base"
                  aria-label={t("operator.layerRules.policy")}
                  options={POLICIES}
                  current={draft.select.policy}
                  label={(policy) => t(`operator.layerRules.policy.${policy}` as "operator.layerRules.policy.one")}
                  onSelect={(policy) =>
                    policy &&
                    update((rules) => ({
                      ...rules,
                      select: { ...rules.select, policy, ...(policy === "top" ? { n: rules.select.n ?? 3 } : {}) },
                    }))
                  }
                />,
              )}
              <Show when={draft.select.policy === "top"}>{selectNumber("n", t("operator.layerRules.n"))}</Show>
              {selectNumber("budget", t("operator.layerRules.budget"))}
              {selectNumber("perSource", t("operator.layerRules.perSource"))}
              {selectText("overflow", t("operator.layerRules.overflow"))}
              {selectText("unique", t("operator.layerRules.unique"), "path")}
              {setting(
                t("operator.layerRules.groups"),
                <TextInputV2
                  appearance="base"
                  aria-label={t("operator.layerRules.groups")}
                  placeholder="global, project, config"
                  value={(draft.select.groups ?? []).join(", ")}
                  onInput={(event) => {
                    const groups = list(event.currentTarget.value)
                    update((rules) => ({
                      ...rules,
                      select: { ...rules.select, groups: groups.length ? groups : undefined },
                    }))
                  }}
                />,
              )}
              {setting(
                t("operator.layerRules.per"),
                <TextInputV2
                  appearance="base"
                  aria-label={t("operator.layerRules.per")}
                  placeholder="config=all"
                  value={perText(draft.select.per)}
                  onInput={(event) => {
                    const per = perOf(event.currentTarget.value)
                    update((rules) => ({ ...rules, select: { ...rules.select, per } }))
                  }}
                />,
              )}
            </tbody>
          </table>
        </div>
      </Field>

      <Field group label={t("operator.layerRules.template")} hint={t("operator.help.rulesTemplate")}>
        <div data-component="operator-table" data-testid="rules-template-form">
          <table aria-label={t("operator.layerRules.template")}>
            <tbody>
              {templateText("header", t("operator.layerRules.header"))}
              {templateText("item", t("operator.layerRules.item"))}
              {templateText("separator", t("operator.layerRules.separator"))}
              {templateText("footer", t("operator.layerRules.footer"))}
              {templateText("empty", t("operator.layerRules.empty"))}
              {setting(
                t("operator.layerRules.keepEmpty"),
                <CheckboxV2
                  hideLabel
                  label={t("operator.layerRules.keepEmpty")}
                  checked={!!draft.template.keepEmpty}
                  onChange={(keepEmpty: boolean) =>
                    update((rules) => ({
                      ...rules,
                      template: { ...rules.template, keepEmpty: keepEmpty || undefined },
                    }))
                  }
                />,
              )}
            </tbody>
          </table>
        </div>
      </Field>
    </div>
  )
}
