import { A } from "@solidjs/router"
import { type JSX, Show } from "solid-js"
import { FieldHelp } from "./field-help"
import { Sparkline } from "./sparkline"

// A stat tile (dashboard_spec.md §6): a label, a value, the change against the previous period (an arrow and words,
// with a tone: never colour alone), a hint line, an optional bar (today's budget) and a sparkline. With `href` the
// whole tile is one link named by its full sentence; its (i) is a separate button above the link. Loading shows the
// tile's shape, never a value that later changes.

export type StatChange = { text: string; arrow?: "up" | "down"; tone?: "good" | "warn" | "neutral" }

export function StatTile(props: {
  label: string
  value: JSX.Element
  hint?: JSX.Element
  trend?: readonly number[]
  /** The sparkline's name, e.g. "from 0.9% to 5.2%". */
  trendLabel?: string
  tone?: "neutral" | "good" | "warn" | "bad"
  change?: StatChange
  /** The whole tile links here. */
  href?: string
  /** The link's name: the tile's full sentence. */
  name?: string
  help?: string
  loading?: boolean
  /** A bar under the hint, with its words (a share in 0–1). */
  progress?: { share: number; text: string; tone?: "warn" }
  testId?: string
}) {
  return (
    <div
      data-component="operator-stat"
      data-tone={props.tone ?? "neutral"}
      data-link={props.href ? "" : undefined}
      data-loading={props.loading ? "" : undefined}
      data-testid={props.testId}
      aria-busy={props.loading ? "true" : undefined}
    >
      <div data-slot="operator-stat-label">
        <Show when={props.href} fallback={<span>{props.label}</span>}>
          {(href) => (
            <A href={href()} data-slot="operator-stat-link" aria-label={props.name ?? props.label}>
              {props.label}
            </A>
          )}
        </Show>
        <span data-slot="operator-stat-help">
          <FieldHelp field={props.label} text={props.help} />
        </span>
      </div>
      <Show
        when={!props.loading}
        fallback={
          <>
            <div data-slot="operator-stat-skeleton" data-size="value" />
            <div data-slot="operator-stat-skeleton" data-size="line" />
            <div data-slot="operator-stat-skeleton" data-size="trend" />
          </>
        }
      >
        <div data-slot="operator-stat-value">{props.value}</div>
        <Show when={props.change}>
          {(change) => (
            <div data-slot="operator-stat-change" data-tone={change().tone ?? "neutral"}>
              <Show when={change().arrow}>
                <span aria-hidden="true">{change().arrow === "up" ? "▲" : "▼"} </span>
              </Show>
              {change().text}
            </div>
          )}
        </Show>
        <Show when={props.hint}>
          <div data-slot="operator-stat-hint">{props.hint}</div>
        </Show>
        <Show when={props.progress}>
          {(progress) => (
            <div data-slot="operator-stat-progress" data-tone={progress().tone}>
              <span data-slot="operator-stat-bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, progress().share * 100))}%` }} />
              </span>
              <span>{progress().text}</span>
            </div>
          )}
        </Show>
        <Show when={props.trend && props.trend.length > 1 ? props.trend : undefined}>
          {(trend) => <Sparkline values={trend()} label={props.trendLabel ?? props.label} />}
        </Show>
      </Show>
    </div>
  )
}
