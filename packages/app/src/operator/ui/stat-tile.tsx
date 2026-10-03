import { type JSX, Show } from "solid-js"
import { Sparkline } from "./sparkline"

export function StatTile(props: {
  label: string
  value: JSX.Element
  hint?: JSX.Element
  trend?: readonly number[]
  trendLabel?: string
  tone?: "neutral" | "good" | "warn" | "bad"
}) {
  return (
    <div data-component="operator-stat" data-tone={props.tone ?? "neutral"}>
      <div data-slot="operator-stat-label">{props.label}</div>
      <div data-slot="operator-stat-value">{props.value}</div>
      <Show when={props.hint}>
        <div data-slot="operator-stat-hint">{props.hint}</div>
      </Show>
      <Show when={props.trend && props.trend.length > 1 ? props.trend : undefined}>
        {(trend) => <Sparkline values={trend()} label={props.trendLabel ?? props.label} />}
      </Show>
    </div>
  )
}
