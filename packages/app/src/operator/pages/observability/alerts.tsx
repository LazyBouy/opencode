import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type {
  OperatorTelemetryAlertEvent,
  OperatorTelemetryAlertRule,
  OperatorTelemetryAlertRuleInput,
  OperatorTelemetryAlertRuleView,
} from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useFiringAlerts } from "../../alert-badge"
import { ready, useOperatorClient } from "../../data"
import { formatAgo, formatDateTime, shortPath } from "../../format"
import { useConfirm, useMoveToTrash } from "../../ui/confirm"
import { type Column, DataTable } from "../../ui/data-table"
import { Field } from "../../ui/field"
import { FieldHelp } from "../../ui/field-help"
import { useNamespaceScope } from "../../ui/namespace-picker"
import { OverlayFrame, useOverlayFrame } from "../../ui/overlay-frame"
import { useOverlayParams } from "../../ui/overlay-nav"
import { SelectV2 } from "../../ui/select"
import { requestError } from "../config-helpers"
import { useDuration } from "./parts"

// Alerts (observability_spec.md §14): what is firing now (Acknowledge, Mute, View events), the rules (condition in
// words, scope, state, last fired, on or off; a row opens its editor), and the history of alert events in the range.
// The server evaluates the rules every 60 s; nothing is sent outside the app.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Rule = OperatorTelemetryAlertRule
type RuleView = OperatorTelemetryAlertRuleView
type AlertEvent = OperatorTelemetryAlertEvent
type Input = OperatorTelemetryAlertRuleInput
type Metric = Input["metric"]

export const METRICS: ReadonlyArray<Metric> = [
  "turn_error_rate",
  "call_error_rate",
  "tool_error_rate",
  "denials",
  "rate_limits",
  "retries_exhausted",
  "oldest_approval",
  "turn_active_p95",
  "ttft_p95",
  "cost",
  "loops",
  "mcp_down",
  "oldest_queued",
]
const UNIT: Record<Metric, "percent" | "count" | "minutes" | "seconds" | "usd"> = {
  turn_error_rate: "percent",
  call_error_rate: "percent",
  tool_error_rate: "percent",
  denials: "count",
  rate_limits: "count",
  retries_exhausted: "count",
  oldest_approval: "minutes",
  turn_active_p95: "seconds",
  ttft_p95: "seconds",
  cost: "usd",
  loops: "count",
  mcp_down: "minutes",
  oldest_queued: "minutes",
}
const WINDOWLESS = new Set<Metric>(["oldest_approval", "mcp_down", "oldest_queued"])
const MINIMUM = new Set<Metric>([
  "turn_error_rate",
  "call_error_rate",
  "tool_error_rate",
  "turn_active_p95",
  "ttft_p95",
])
const OPS: ReadonlyArray<Input["op"]> = [">", ">=", "<", "<="]
const OP_SIGN: Record<string, string> = { ">": ">", ">=": "≥", "<": "<", "<=": "≤" }
const WINDOWS: ReadonlyArray<Input["window"]> = ["5", "15", "30", "60", "today"]
const SCOPE_FIELDS = ["ns", "dir", "agent", "model", "provider", "tool"] as const
const STATE_ICON: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  ok: "circle-check",
  insufficient: "status-active",
  firing: "warning",
  muted: "stop",
  error: "circle-x",
  disabled: "circle-ban-sign",
}
const MIN = 60_000
// "Any" as an option of its own in a scope select (an empty value would leave the select without a name).
const ANY = "*"

export { needsAttention, useFiringAlerts } from "../../alert-badge"

export function useAlertWords() {
  const language = useLanguage()
  const t = language.t
  const value = (metric: string, amount: number | null | undefined) => {
    if (amount === null || amount === undefined) return "—"
    const locale = language.intl()
    const unit = UNIT[metric as Metric] ?? "count"
    const number = (digits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(amount)
    if (unit === "percent")
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(amount / 100)
    if (unit === "usd")
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumSignificantDigits: 4 }).format(
        amount,
      )
    if (unit === "minutes") return t("operator.obs.alerts.minutes", { n: number(1) })
    if (unit === "seconds") return t("operator.obs.alerts.seconds", { n: number(1) })
    return number(0)
  }
  /** A rule's condition in words: "Model call error rate > 20 % over 15 min, at least 10 calls". */
  const condition = (rule: Pick<Input, "metric" | "op" | "threshold" | "window" | "minCount" | "consecutive">) => {
    const parts = [
      `${t(`operator.obs.alerts.metric.${rule.metric}` as Key)} ${OP_SIGN[rule.op]} ${value(rule.metric, rule.threshold)}`,
    ]
    if (!WINDOWLESS.has(rule.metric))
      parts[0] += ` ${rule.window === "today" ? t("operator.obs.alerts.today") : t("operator.obs.alerts.over", { n: rule.window })}`
    if (MINIMUM.has(rule.metric) && rule.minCount)
      parts.push(t(`operator.obs.alerts.atLeast.${rule.metric}` as Key, { n: rule.minCount }))
    if (rule.consecutive > 1) parts.push(t("operator.obs.alerts.forTimes", { n: rule.consecutive }))
    return parts.join(", ")
  }
  const scope = (value: Record<string, string | undefined>) =>
    SCOPE_FIELDS.filter((field) => value[field])
      .map(
        (field) =>
          `${t(`operator.obs.filter.${field}` as Key)}: ${field === "dir" ? shortPath(value[field]!) : value[field]}`,
      )
      .join(" · ")
  const severity = (level: string) => t(`operator.obs.alerts.severity.${level}` as Key)
  return { value, condition, scope, severity }
}

/** The Events filter and time for View events: the rule's filter over its window up to now (or the end). */
export function eventsLink(event: AlertEvent, now = Date.now()) {
  const window = event.win === "today" ? 24 * 60 * MIN : Number(event.win) * MIN || 15 * MIN
  return { filter: event.link, from: event.start_ms - window, to: event.end_ms ?? now }
}

export function Severity(props: { level: string }) {
  const words = useAlertWords()
  return (
    <span data-slot="operator-obs-status" data-status={props.level === "critical" ? "error" : "interrupted"}>
      <Icon name={props.level === "critical" ? "circle-x" : "warning"} size="small" />
      <span>{words.severity(props.level)}</span>
    </span>
  )
}

function useAlertActions() {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const refresh = () =>
    Promise.all(
      ["telemetry-alerts", "telemetry-alert-rules", "telemetry-alert-history"].map((key) =>
        queryClient.invalidateQueries({ queryKey: api.key(key) }),
      ),
    )
  return {
    refresh,
    acknowledge: (id: string) => api.client().operator.telemetry.alertAck({ id }, { throwOnError: true }).then(refresh),
    mute: (id: string, value: "1h" | "4h" | "24h" | "always" | "off") =>
      api.client().operator.telemetry.alertRuleMute({ id, for: value }, { throwOnError: true }).then(refresh),
  }
}

const MUTES = ["1h", "4h", "24h", "always"] as const

function MuteMenu(props: { ruleID: string; muted: boolean }) {
  const t = useLanguage().t
  const actions = useAlertActions()
  return (
    <Show
      when={!props.muted}
      fallback={
        <ButtonV2 size="small" variant="outline" onClick={() => void actions.mute(props.ruleID, "off")}>
          {t("operator.obs.alerts.unmute")}
        </ButtonV2>
      }
    >
      <SelectV2<string>
        appearance="base"
        aria-label={t("operator.obs.alerts.mute")}
        placeholder={t("operator.obs.alerts.mute")}
        options={[...MUTES]}
        current={undefined}
        label={(value) => t(`operator.obs.alerts.muteFor.${value}` as Key)}
        onSelect={(value) => value && void actions.mute(props.ruleID, value as (typeof MUTES)[number])}
      />
    </Show>
  )
}

/** The firing alerts as cards: severity, rule, since, value against threshold, scope; View events, Acknowledge, Mute. */
export function FiringList(props: {
  events: ReadonlyArray<AlertEvent>
  rules?: ReadonlyArray<RuleView>
  onEvents: (event: AlertEvent) => void
}) {
  const language = useLanguage()
  const t = language.t
  const words = useAlertWords()
  const actions = useAlertActions()
  const current = (event: AlertEvent) => props.rules?.find((item) => item.rule.id === event.rule_id)?.state.value
  return (
    <ul data-component="operator-obs-firing" aria-label={t("operator.obs.alerts.firingNow")}>
      <For each={props.events}>
        {(event) => (
          <li data-testid="obs-alert-firing" data-acked={event.ack_ms !== null ? "" : undefined}>
            <div data-slot="operator-obs-firing-head">
              <Severity level={event.severity} />
              <strong>{event.name}</strong>
              <span data-slot="operator-note" title={formatDateTime(event.start_ms, language.intl())}>
                {t("operator.obs.alerts.since", { when: formatAgo(event.start_ms, language.intl()) })}
              </span>
              <Show when={event.muted}>
                <Tag>{t("operator.obs.alerts.state.muted")}</Tag>
              </Show>
            </div>
            <p data-slot="operator-obs-firing-value">
              {t("operator.obs.alerts.valueAgainst", {
                value: words.value(event.metric, current(event) ?? event.value),
                op: OP_SIGN[event.op] ?? event.op,
                threshold: words.value(event.metric, event.threshold),
              })}
              <Show when={words.scope(event.scope)}>
                {(text) => <span data-slot="operator-note"> · {text()}</span>}
              </Show>
            </p>
            <div data-slot="operator-actions">
              <ButtonV2 size="small" variant="outline" onClick={() => props.onEvents(event)}>
                {t("operator.obs.alerts.viewEvents")}
              </ButtonV2>
              <Show
                when={event.ack_ms === null}
                fallback={
                  <span data-slot="operator-note">
                    {t("operator.obs.alerts.acknowledgedBy", {
                      who: event.ack_by ?? "",
                      when: formatAgo(event.ack_ms ?? undefined, language.intl()),
                    })}
                  </span>
                }
              >
                <ButtonV2 size="small" variant="contrast" onClick={() => void actions.acknowledge(event.id)}>
                  {t("operator.obs.alerts.acknowledge")}
                </ButtonV2>
              </Show>
              <MuteMenu ruleID={event.rule_id} muted={event.muted} />
            </div>
          </li>
        )}
      </For>
    </ul>
  )
}

export function AlertsTab(props: {
  /** The range for History. */
  range: Record<string, string>
  onEvents: (filter: Record<string, string>, from: number, to: number) => void
  onOpenRule: (id: string) => void
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const words = useAlertWords()
  const duration = useDuration()
  const actions = useAlertActions()
  const firing = useFiringAlerts()
  const rules = useQuery(() => ({
    queryKey: api.key("telemetry-alert-rules"),
    refetchInterval: 30_000,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.alertRules({ throwOnError: true })
        .then((result) => result.data!),
  }))
  const history = useQuery(() => ({
    queryKey: api.key("telemetry-alert-history", props.range),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.alertEvents({ ...props.range, limit: "500" }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const open = (event: AlertEvent) => {
    const link = eventsLink(event)
    props.onEvents(link.filter, link.from, link.to)
  }
  const toggle = (view: RuleView, enabled: boolean) => {
    const { id, builtin: _builtin, mute: _mute, createdAt: _created, updatedAt: _updated, ...input } = view.rule
    void api
      .client()
      .operator.telemetry.alertRuleUpdate(
        { id, operatorTelemetryAlertRuleInput: { ...input, enabled } },
        { throwOnError: true },
      )
      .then(actions.refresh)
  }
  const stateWord = (view: RuleView) =>
    view.muted && view.state.state !== "disabled"
      ? t("operator.obs.alerts.state.muted")
      : t(`operator.obs.alerts.state.${view.state.state}` as Key)

  const ruleColumns: Column<RuleView>[] = [
    {
      id: "name",
      header: t("operator.obs.alerts.col.name"),
      help: t("operator.obs.help.alertName"),
      value: (view) => view.rule.name,
      cell: (view) => (
        <span class="inline-flex items-center gap-2">
          <span>{view.rule.name}</span>
          <Show when={view.rule.builtin}>
            <Tag>{t("operator.obs.alerts.builtin")}</Tag>
          </Show>
        </span>
      ),
    },
    {
      id: "condition",
      header: t("operator.obs.alerts.col.condition"),
      help: t("operator.obs.help.alertCondition"),
      cell: (view) => words.condition(view.rule),
    },
    {
      id: "scope",
      header: t("operator.obs.alerts.col.scope"),
      help: t("operator.obs.help.alertScope"),
      cell: (view) => words.scope(view.rule.scope) || t("operator.obs.alerts.everywhere"),
    },
    {
      id: "severity",
      optional: true,
      header: t("operator.obs.alerts.col.severity"),
      help: t("operator.obs.help.alertSeverity"),
      value: (view) => view.rule.severity,
      cell: (view) => <Severity level={view.rule.severity} />,
    },
    {
      id: "state",
      header: t("operator.obs.alerts.col.state"),
      help: t("operator.obs.help.alertState"),
      value: (view) => view.state.state,
      cell: (view) => (
        <span
          data-slot="operator-obs-status"
          data-status={
            view.state.state === "firing" ? "error" : view.state.state === "error" ? "interrupted" : undefined
          }
          title={view.state.error ?? undefined}
        >
          <Icon name={STATE_ICON[view.muted ? "muted" : view.state.state] ?? "status-active"} size="small" />
          <span>{stateWord(view)}</span>
          <Show when={view.state.value !== null && view.state.state !== "disabled"}>
            <span data-slot="operator-note"> {words.value(view.rule.metric, view.state.value)}</span>
          </Show>
        </span>
      ),
    },
    {
      id: "lastFired",
      header: t("operator.obs.alerts.col.lastFired"),
      help: t("operator.obs.help.alertLastFired"),
      value: (view) => view.state.last_fired_ms ?? 0,
      cell: (view) =>
        view.state.last_fired_ms ? (
          <span title={formatDateTime(view.state.last_fired_ms, language.intl())}>
            {formatAgo(view.state.last_fired_ms, language.intl())}
          </span>
        ) : (
          t("operator.obs.alerts.never")
        ),
    },
    {
      id: "enabled",
      header: t("operator.obs.alerts.col.enabled"),
      help: t("operator.obs.help.alertEnabled"),
      value: (view) => (view.rule.enabled ? 1 : 0),
      cell: (view) => (
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <CheckboxV2
            label={t("operator.obs.alerts.on")}
            checked={view.rule.enabled}
            onChange={(checked: boolean) => toggle(view, checked)}
          />
        </span>
      ),
    },
  ]
  const historyColumns: Column<AlertEvent>[] = [
    {
      id: "start",
      header: t("operator.obs.alerts.col.started"),
      help: t("operator.obs.help.alertStarted"),
      value: (event) => event.start_ms,
      cell: (event) => formatDateTime(event.start_ms, language.intl()),
    },
    {
      id: "name",
      header: t("operator.obs.alerts.col.name"),
      help: t("operator.obs.help.alertName"),
      value: (event) => event.name,
      cell: (event) => event.name,
    },
    {
      id: "severity",
      header: t("operator.obs.alerts.col.severity"),
      help: t("operator.obs.help.alertSeverity"),
      value: (event) => event.severity,
      cell: (event) => <Severity level={event.severity} />,
    },
    {
      id: "duration",
      align: "end",
      header: t("operator.obs.alerts.col.duration"),
      help: t("operator.obs.help.alertDuration"),
      value: (event) => (event.end_ms ?? Date.now()) - event.start_ms,
      cell: (event) =>
        event.end_ms === null ? t("operator.obs.alerts.stillFiring") : duration(event.end_ms - event.start_ms),
    },
    {
      id: "value",
      align: "end",
      header: t("operator.obs.alerts.col.value"),
      help: t("operator.obs.help.alertValue"),
      cell: (event) => words.value(event.metric, event.value),
    },
    {
      id: "worst",
      align: "end",
      header: t("operator.obs.alerts.col.worst"),
      help: t("operator.obs.help.alertWorst"),
      cell: (event) => words.value(event.metric, event.worst),
    },
    {
      id: "threshold",
      optional: true,
      align: "end",
      header: t("operator.obs.alerts.col.threshold"),
      help: t("operator.obs.help.alertThreshold"),
      cell: (event) => `${OP_SIGN[event.op] ?? event.op} ${words.value(event.metric, event.threshold)}`,
    },
    {
      id: "ack",
      header: t("operator.obs.alerts.col.acknowledged"),
      help: t("operator.obs.help.alertAcknowledged"),
      cell: (event) =>
        event.ack_ms !== null
          ? t("operator.obs.alerts.acknowledgedBy", {
              who: event.ack_by ?? "",
              when: formatAgo(event.ack_ms, language.intl()),
            })
          : "",
    },
  ]

  return (
    <div data-component="operator-obs-alerts">
      <section data-slot="operator-obs-section" data-testid="obs-alerts-firing">
        <header>
          <h3>{t("operator.obs.alerts.firingNow")}</h3>
          <FieldHelp field={t("operator.obs.alerts.firingNow")} text={t("operator.obs.help.firingNow")} />
        </header>
        <Show
          when={ready(firing)?.length}
          fallback={<p data-slot="operator-note">{t("operator.obs.alerts.noneFiring")}</p>}
        >
          <FiringList events={ready(firing)!} rules={ready(rules)} onEvents={open} />
        </Show>
      </section>
      <section data-slot="operator-obs-section" data-testid="obs-alerts-rules">
        <header>
          <h3>{t("operator.obs.alerts.rules")}</h3>
          <FieldHelp field={t("operator.obs.alerts.rules")} text={t("operator.obs.help.alertRules")} />
          <ButtonV2 size="small" variant="outline" onClick={() => props.onOpenRule("new")} data-testid="obs-alert-new">
            {t("operator.obs.alerts.newRule")}
          </ButtonV2>
        </header>
        <DataTable<RuleView>
          label={t("operator.obs.alerts.rules")}
          rows={ready(rules) ?? []}
          columns={ruleColumns}
          columnsKey="observability-alert-rules"
          loading={rules.isPending}
          search={(view) => `${view.rule.name} ${words.condition(view.rule)}`}
          onRowClick={(view) => props.onOpenRule(view.rule.id)}
          rowAttrs={(view) => ({ "data-testid": "obs-alert-rule", "data-rule": view.rule.id })}
        />
      </section>
      <section data-slot="operator-obs-section" data-testid="obs-alerts-history">
        <header>
          <h3>{t("operator.obs.alerts.history")}</h3>
          <FieldHelp field={t("operator.obs.alerts.history")} text={t("operator.obs.help.alertHistory")} />
        </header>
        <DataTable<AlertEvent>
          label={t("operator.obs.alerts.history")}
          rows={ready(history) ?? []}
          columns={historyColumns}
          columnsKey="observability-alert-history"
          loading={history.isPending}
          empty={<p data-slot="operator-note">{t("operator.obs.alerts.noHistory")}</p>}
          onRowClick={open}
          rowAttrs={() => ({ "data-testid": "obs-alert-event" })}
        />
      </section>
    </div>
  )
}

const BLANK: Input = {
  name: "",
  metric: "call_error_rate",
  op: ">",
  threshold: 20,
  window: "15",
  minCount: 10,
  consecutive: 1,
  scope: {},
  severity: "warning",
  enabled: true,
}

const inputOf = (rule: Rule): Input => {
  const { id: _id, builtin: _builtin, mute: _mute, createdAt: _created, updatedAt: _updated, ...input } = rule
  return { ...input, scope: { ...input.scope } }
}

/** A rule's editor, in its overlay (`rule=<id>` or `rule=new`). */
export function RuleOverlay() {
  const t = useLanguage().t
  const api = useOperatorClient()
  const [params, setParams] = useOverlayParams<{ rule?: string }>()
  const rules = useQuery(() => ({
    queryKey: api.key("telemetry-alert-rules"),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.alertRules({ throwOnError: true })
        .then((result) => result.data!),
  }))
  const view = () => (params.rule === "new" ? undefined : ready(rules)?.find((item) => item.rule.id === params.rule))
  const [dirty, setDirty] = createSignal(false)
  return (
    <OverlayFrame
      label={params.rule === "new" ? t("operator.obs.alerts.newRule") : (view()?.rule.name ?? params.rule)}
      editing={dirty()}
    >
      <div data-component="operator-obs-rule" data-testid="obs-alert-editor">
        <Show
          when={params.rule === "new" || view()}
          fallback={
            <p data-slot="operator-note">{rules.isPending ? t("common.loading") : t("operator.obs.alerts.missing")}</p>
          }
        >
          <RuleForm
            view={view()}
            onDirty={setDirty}
            onDone={() => {
              setDirty(false)
              setParams({ rule: undefined })
            }}
          />
        </Show>
      </div>
    </OverlayFrame>
  )
}

function RuleForm(props: { view: RuleView | undefined; onDirty: (dirty: boolean) => void; onDone: () => void }) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  const words = useAlertWords()
  const actions = useAlertActions()
  const confirm = useConfirm()
  const moveToTrash = useMoveToTrash()
  const frame = useOverlayFrame()
  const namespaces = useNamespaceScope()
  const [store, setStore] = createStore<{
    input: Input
    threshold: string
    minCount: string
    busy: boolean
    error?: string
  }>({
    input: props.view ? inputOf(props.view.rule) : { ...BLANK, scope: {} },
    threshold: String(props.view?.rule.threshold ?? BLANK.threshold),
    minCount: props.view?.rule.minCount !== undefined ? String(props.view.rule.minCount) : props.view ? "" : "10",
    busy: false,
  })
  const set = <K extends keyof Input>(key: K, value: Input[K]) => {
    setStore("input", key, value)
    props.onDirty(true)
  }
  const setScope = (field: (typeof SCOPE_FIELDS)[number], value: string | undefined) => {
    setStore("input", "scope", { ...store.input.scope, [field]: value || undefined })
    props.onDirty(true)
  }
  // Values seen in the last 7 days, to pick a scope from.
  const facet = (field: string) =>
    useQuery(() => ({
      queryKey: api.key("telemetry-facet", "events", field, { range: "7d" }),
      queryFn: () =>
        api
          .client()
          .operator.telemetry.facets({ scope: "events", field, range: "7d" })
          .then((result) => (result.data ?? []).map((item) => item.value).filter(Boolean)),
    }))
  const seen = {
    dir: facet("dir"),
    agent: facet("agent"),
    model: facet("model"),
    provider: facet("provider"),
    tool: facet("tool"),
  }
  const optionsOf = (field: (typeof SCOPE_FIELDS)[number]) => {
    const values =
      field === "ns" ? namespaces.namespaces().map((item) => item.namespace.id) : (ready(seen[field]) ?? [])
    const current = store.input.scope[field]
    return [ANY, ...new Set([...values, ...(current ? [current] : [])])]
  }
  const metric = () => store.input.metric
  const parsed = () => {
    const threshold = Number(store.threshold)
    const minCount = store.minCount.trim() === "" ? undefined : Number(store.minCount)
    return {
      ...store.input,
      threshold,
      ...(minCount !== undefined && MINIMUM.has(metric()) ? { minCount } : { minCount: undefined }),
    } as Input
  }
  const preview = createMemo(() => {
    const input = parsed()
    return Number.isFinite(input.threshold) ? words.condition(input) : ""
  })

  const save = async () => {
    setStore({ busy: true, error: undefined })
    try {
      const input = parsed()
      if (props.view)
        await api
          .client()
          .operator.telemetry.alertRuleUpdate(
            { id: props.view.rule.id, operatorTelemetryAlertRuleInput: input },
            { throwOnError: true },
          )
      else
        await api
          .client()
          .operator.telemetry.alertRuleCreate({ operatorTelemetryAlertRuleInput: input }, { throwOnError: true })
      await actions.refresh()
      props.onDone()
    } catch (error) {
      setStore("error", requestError(error))
    } finally {
      setStore("busy", false)
    }
  }
  const remove = async () => {
    const view = props.view
    if (!view) return
    const moved = await moveToTrash(view.rule.name, () =>
      api
        .client()
        .operator.telemetry.alertRuleDelete({ id: view.rule.id }, { throwOnError: true })
        .then(actions.refresh),
    )
    if (moved) {
      props.onDirty(false)
      frame?.close()
    }
  }
  const reset = async () => {
    const view = props.view
    if (!view) return
    const ok = await confirm({
      title: t("operator.obs.alerts.resetTitle", { name: view.rule.name }),
      description: t("operator.obs.alerts.resetBody"),
      confirm: t("operator.obs.alerts.reset"),
    })
    if (!ok) return
    await api.client().operator.telemetry.alertRuleReset({ id: view.rule.id }, { throwOnError: true })
    await actions.refresh()
    props.onDone()
  }

  const select = <T extends string>(input: {
    label: string
    hint: string
    options: ReadonlyArray<T>
    current: T | undefined
    word: (value: T) => string
    onSelect: (value: T) => void
  }): JSX.Element => (
    <Field group label={input.label} hint={input.hint}>
      <SelectV2<T>
        appearance="base"
        aria-label={input.label}
        options={[...input.options]}
        current={input.current}
        label={input.word}
        onSelect={(value) => value !== undefined && value !== null && input.onSelect(value)}
      />
    </Field>
  )

  return (
    <div data-component="operator-form" data-testid="obs-alert-form">
      <Field label={t("operator.obs.alerts.field.name")} hint={t("operator.obs.help.alertName")}>
        <TextInputV2
          appearance="base"
          value={store.input.name}
          onInput={(event) => set("name", event.currentTarget.value)}
        />
      </Field>
      {select({
        label: t("operator.obs.alerts.field.metric"),
        hint: t("operator.obs.help.alertMetric"),
        options: METRICS,
        current: store.input.metric,
        word: (value) => t(`operator.obs.alerts.metric.${value}` as Key),
        onSelect: (value) => set("metric", value),
      })}
      <p data-slot="operator-note">{t(`operator.obs.alerts.metricHelp.${metric()}` as Key)}</p>
      <div class="flex flex-wrap items-end gap-2">
        {select({
          label: t("operator.obs.alerts.field.op"),
          hint: t("operator.obs.help.alertOp"),
          options: OPS,
          current: store.input.op,
          word: (value) => OP_SIGN[value]!,
          onSelect: (value) => set("op", value),
        })}
        <Field
          label={t("operator.obs.alerts.field.threshold", {
            unit: t(`operator.obs.alerts.unit.${UNIT[metric()]}` as Key),
          })}
          hint={t("operator.obs.help.alertThreshold")}
        >
          <TextInputV2
            appearance="base"
            type="number"
            value={store.threshold}
            onInput={(event) => {
              setStore("threshold", event.currentTarget.value)
              props.onDirty(true)
            }}
          />
        </Field>
      </div>
      <Show
        when={!WINDOWLESS.has(metric())}
        fallback={<p data-slot="operator-note">{t("operator.obs.alerts.noWindow")}</p>}
      >
        {select({
          label: t("operator.obs.alerts.field.window"),
          hint: t("operator.obs.help.alertWindow"),
          options: WINDOWS,
          current: store.input.window,
          word: (value) =>
            value === "today"
              ? t("operator.obs.alerts.windowToday")
              : t("operator.obs.alerts.windowMinutes", { n: value }),
          onSelect: (value) => set("window", value),
        })}
      </Show>
      <Show when={MINIMUM.has(metric())}>
        <Field label={t("operator.obs.alerts.field.minCount")} hint={t("operator.obs.help.alertMinCount")}>
          <TextInputV2
            appearance="base"
            type="number"
            value={store.minCount}
            onInput={(event) => {
              setStore("minCount", event.currentTarget.value)
              props.onDirty(true)
            }}
          />
        </Field>
      </Show>
      {select({
        label: t("operator.obs.alerts.field.for"),
        hint: t("operator.obs.help.alertFor"),
        options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        current: String(store.input.consecutive),
        word: (value) => t("operator.obs.alerts.evaluations", { n: value }),
        onSelect: (value) => set("consecutive", Number(value)),
      })}
      <Field group label={t("operator.obs.alerts.field.scope")} hint={t("operator.obs.help.alertScope")}>
        <div class="flex flex-wrap gap-2">
          <For each={SCOPE_FIELDS}>
            {(field) => (
              <SelectV2<string>
                appearance="base"
                aria-label={t(`operator.obs.filter.${field}` as Key)}
                options={optionsOf(field)}
                current={store.input.scope[field] ?? ANY}
                label={(value) =>
                  value !== ANY
                    ? `${t(`operator.obs.filter.${field}` as Key)}: ${field === "dir" ? shortPath(value) : field === "ns" ? namespaces.name(value) : value}`
                    : t("operator.obs.alerts.anyOf", { name: t(`operator.obs.filter.${field}` as Key) })
                }
                onSelect={(value) => value && setScope(field, value === ANY ? undefined : value)}
              />
            )}
          </For>
        </div>
      </Field>
      {select({
        label: t("operator.obs.alerts.field.severity"),
        hint: t("operator.obs.help.alertSeverity"),
        options: ["warning", "critical"] as const,
        current: store.input.severity,
        word: (value) => words.severity(value),
        onSelect: (value) => set("severity", value),
      })}
      <span class="inline-flex items-center">
        <CheckboxV2
          label={t("operator.obs.alerts.field.enabled")}
          checked={store.input.enabled}
          onChange={(checked: boolean) => set("enabled", checked)}
        />
        <FieldHelp field={t("operator.obs.alerts.field.enabled")} text={t("operator.obs.help.alertEnabled")} />
      </span>
      <Show when={preview()}>
        <p data-slot="operator-note" data-testid="obs-alert-preview">
          {t("operator.obs.alerts.firesWhen", { condition: preview() })}
        </p>
      </Show>
      <Show when={props.view}>
        {(view) => (
          <div class="flex flex-wrap items-center gap-2">
            <Show when={view().muted}>
              <span data-slot="operator-note">
                {view().rule.mute?.until
                  ? t("operator.obs.alerts.mutedUntil", {
                      when: formatDateTime(view().rule.mute!.until!, language.intl()),
                    })
                  : t("operator.obs.alerts.mutedAlways")}
              </span>
            </Show>
            <MuteMenu ruleID={view().rule.id} muted={view().muted} />
          </div>
        )}
      </Show>
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div data-slot="operator-actions">
        <Show when={props.view && !props.view.rule.builtin}>
          <ButtonV2 variant="danger" onClick={() => void remove()} data-testid="obs-alert-delete">
            {t("operator.obs.alerts.delete")}
          </ButtonV2>
        </Show>
        <Show when={props.view?.rule.builtin}>
          <ButtonV2 variant="outline" onClick={() => void reset()}>
            {t("operator.obs.alerts.reset")}
          </ButtonV2>
        </Show>
        <ButtonV2 variant="neutral" onClick={props.onDone}>
          {t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void save()} data-testid="obs-alert-save">
          {t("common.save")}
        </ButtonV2>
      </div>
    </div>
  )
}
