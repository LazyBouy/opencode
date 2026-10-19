import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { OperatorDashboardItem } from "@opencode-ai/sdk/v2/client"
import { A } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ageOf, formatCost, formatCount } from "../../format"
import { FieldHelp } from "../../ui/field-help"
import { hrefOf, SHOWN } from "./model"

// Needs attention (dashboard_spec.md §5): what needs a person now, in scope, whatever the range. Each item is an icon,
// its words (a count and the worst case) and a link; critical ones say so in words as well as colour. At most 6 on
// one line, then "+N more". Nothing to show: All clear, with the running count, so the check is seen to have run.
// Building history, telemetry off (approvals still come from the pending list) and an unreachable server have their
// own words. A polite live region announces changes, at most once every 30 s.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Item = OperatorDashboardItem
const ANNOUNCE = 30_000

const ICONS: Record<Item["kind"], string> = {
  approvals: "shield",
  alerts: "warning",
  errors: "circle-x",
  stuck: "status",
  loops: "reset",
  rate_limited: "circle-ban-sign",
  mcp: "mcp",
  queue: "bullet-list",
  budget: "warning",
  telemetry: "eye",
}

/** An item's words, built from its numbers (§9.1: the server sends numbers, not sentences). */
export function useItemText() {
  const language = useLanguage()
  const t = language.t
  const age = (ms: number | undefined) => {
    const found = ageOf(ms ?? 0)
    return t(`operator.dash.age.${found.unit}` as Key, { n: found.n })
  }
  const count = (n: number) => formatCount(n, language.intl())
  const cost = (n: number | undefined) => formatCost(n ?? 0, language.intl())
  return (item: Item) => {
    const one = item.count === 1
    const worst = item.worst
    switch (item.kind) {
      case "approvals":
        return one
          ? t("operator.dash.item.approvals.one", { age: age(worst.ageMs) })
          : t("operator.dash.item.approvals.many", { count: count(item.count), age: age(worst.ageMs) })
      case "alerts":
        if (one) return t("operator.dash.item.alerts.one", { name: worst.label ?? "" })
        return worst.critical
          ? t("operator.dash.item.alerts.critical", { count: count(item.count), critical: count(worst.critical) })
          : t("operator.dash.item.alerts.many", { count: count(item.count) })
      case "errors":
        return one
          ? t("operator.dash.item.errors.one")
          : t("operator.dash.item.errors.many", { count: count(item.count) })
      case "stuck":
        return one
          ? t("operator.dash.item.stuck.one", { age: age(worst.ageMs) })
          : t("operator.dash.item.stuck.many", { count: count(item.count), age: age(worst.ageMs) })
      case "loops":
        return one
          ? t("operator.dash.item.loops.one")
          : t("operator.dash.item.loops.many", { count: count(item.count) })
      case "rate_limited":
        return worst.label
          ? t("operator.dash.item.rateLimited.provider", { count: count(item.count), provider: worst.label })
          : t("operator.dash.item.rateLimited.plain", { count: count(item.count) })
      case "mcp": {
        const text =
          worst.status === "needs_auth"
            ? t("operator.dash.item.mcp.auth", { server: worst.label ?? "" })
            : t("operator.dash.item.mcp.down", { server: worst.label ?? "" })
        return one ? text : t("operator.dash.item.more", { text, count: count(item.count - 1) })
      }
      case "queue":
        return t("operator.dash.item.queue", { count: count(item.count), age: age(worst.ageMs) })
      case "budget":
        return t("operator.dash.item.budget", { amount: cost(worst.amount), limit: cost(worst.limit) })
      case "telemetry":
        return worst.status === "off"
          ? t("operator.dash.item.telemetry.off")
          : t("operator.dash.item.telemetry.dropped", { count: count(item.count) })
    }
  }
}

export function AttentionStrip(props: {
  items: ReadonlyArray<Item> | undefined
  /** Top sessions running or waiting now. */
  running: number | undefined
  loading: boolean
  unreachable: boolean
  onRetry: () => void
  /** Building history: the share done. */
  building: number | undefined
  scope: { ns?: string; dir?: string }
  onShowRunning: () => void
}) {
  const language = useLanguage()
  const t = language.t
  const text = useItemText()
  const [expanded, setExpanded] = createSignal(false)
  const items = () => props.items ?? []
  const shown = createMemo(() => (expanded() ? items() : items().slice(0, SHOWN)))
  const hidden = () => items().length - shown().length

  // The live region: what changed since the last announcement, at most once every 30 s; nothing on first load.
  const [said, setSaid] = createSignal("")
  let counts: Map<string, number> | undefined
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let waiting = ""
  const announce = (message: string) => {
    waiting = message
    if (timer) return
    const wait = last + ANNOUNCE - Date.now()
    const speak = () => {
      timer = undefined
      last = Date.now()
      setSaid(waiting)
    }
    if (wait <= 0) speak()
    else timer = setTimeout(speak, wait)
  }
  onCleanup(() => timer && clearTimeout(timer))
  createEffect(
    on(
      () => props.items,
      (list) => {
        if (!list) return
        const next = new Map(list.map((item) => [item.kind, item.count]))
        const before = counts
        counts = next
        if (!before) return
        const changed = list.filter((item) => before.get(item.kind) !== item.count)
        if (changed.length) announce(changed.map(text).join(". "))
        else if (!list.length && before.size) announce(t("operator.dash.allClearSpoken"))
      },
    ),
  )

  const runningText = () => {
    const n = props.running ?? 0
    if (!n) return t("operator.dash.runningNone")
    return n === 1
      ? t("operator.dash.runningOne")
      : t("operator.dash.runningMany", { count: formatCount(n, language.intl()) })
  }

  return (
    <section
      data-component="operator-dash-attention"
      aria-labelledby="dash-attention-title"
      data-testid="dash-attention"
    >
      <h2 id="dash-attention-title" data-slot="operator-dash-block-title">
        {t("operator.dash.attention.title")}
        <FieldHelp field={t("operator.dash.attention.title")} text={t("operator.dash.help.attention")} />
      </h2>
      <div class="sr-only" aria-live="polite" data-testid="dash-attention-live">
        {said()}
      </div>
      <Show
        when={!props.unreachable}
        fallback={
          <p data-slot="operator-dash-attention-note" data-testid="dash-unreachable">
            <Icon name="warning" size="small" />
            <span>{t("operator.dash.unreachable")}</span>
            <ButtonV2 size="small" variant="outline" onClick={() => props.onRetry()}>
              {t("operator.dash.retry")}
            </ButtonV2>
          </p>
        }
      >
        <Show when={props.building !== undefined}>
          <p data-slot="operator-dash-attention-note" data-testid="dash-building">
            {t("operator.dash.building", { percent: Math.round((props.building ?? 0) * 100) })}
          </p>
        </Show>
        <Show
          when={items().length}
          fallback={
            <Show when={!props.loading && props.items}>
              <p data-slot="operator-dash-clear" data-testid="dash-all-clear">
                <Icon name="circle-check" size="small" />
                <span>
                  <strong>{t("operator.dash.allClear")}</strong> {t("operator.dash.nothingNeedsYou")}{" "}
                  <button type="button" data-slot="operator-link" onClick={() => props.onShowRunning()}>
                    {runningText()}
                  </button>
                </span>
              </p>
            </Show>
          }
        >
          <ul data-slot="operator-dash-items" aria-labelledby="dash-attention-title">
            <For each={shown()}>
              {(item) => (
                <li data-slot="operator-dash-item" data-severity={item.severity} data-kind={item.kind}>
                  <A href={hrefOf(item.link, props.scope)} data-testid={`dash-item-${item.kind}`}>
                    <Icon name={ICONS[item.kind] as Parameters<typeof Icon>[0]["name"]} size="small" />
                    <Show
                      when={item.severity === "critical"}
                      fallback={<span class="sr-only">{t("operator.dash.severity.warning")}: </span>}
                    >
                      <Tag data-slot="operator-dash-critical">{t("operator.dash.severity.critical")}</Tag>
                    </Show>
                    <span>{text(item)}</span>
                  </A>
                  <Show when={item.alert}>
                    <Tag data-testid={`dash-item-${item.kind}-alert`}>{t("operator.dash.alertFiring")}</Tag>
                  </Show>
                </li>
              )}
            </For>
            <Show when={hidden() > 0 || expanded()}>
              <li>
                <button
                  type="button"
                  data-slot="operator-link"
                  aria-expanded={expanded()}
                  data-testid="dash-attention-more"
                  onClick={() => setExpanded(!expanded())}
                >
                  {expanded() ? t("operator.dash.fewer") : t("operator.dash.more", { count: hidden() })}
                </button>
              </li>
            </Show>
          </ul>
        </Show>
      </Show>
    </section>
  )
}
