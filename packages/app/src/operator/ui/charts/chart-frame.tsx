import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "../field-help"

// A chart's frame (observability_spec.md §12.1, §17): title, (i), unit, the source note, the empty, loading and error
// states, and "Show as table".

export function ChartFrame(props: {
  id: string
  title: string
  help: string
  unit?: string
  /** "From events" or "From hourly totals (≈)", and what didn't apply. */
  note?: JSX.Element
  loading: boolean
  error?: string
  onRetry?: () => void
  /** Set when there is nothing to draw: what to say. */
  empty?: string
  /** The table alternative; absent for charts that are tables. */
  table?: () => JSX.Element
  asTable: boolean
  onAsTable: (value: boolean) => void
  wide?: boolean
  children: JSX.Element
}) {
  const t = useLanguage().t
  return (
    <section
      data-component="operator-chart-frame"
      data-testid="obs-chart"
      data-metric={props.id}
      data-wide={props.wide ? "" : undefined}
      aria-labelledby={`obs-chart-${props.id}`}
    >
      <header>
        <h4 id={`obs-chart-${props.id}`}>{props.title}</h4>
        <FieldHelp field={props.title} text={props.help} />
        <Show when={props.unit}>
          <span data-slot="operator-note">{props.unit}</span>
        </Show>
        <Show when={props.table && !props.empty && !props.loading && !props.error}>
          <ButtonV2
            size="small"
            variant="ghost"
            aria-pressed={props.asTable}
            data-testid="obs-chart-as-table"
            onClick={() => props.onAsTable(!props.asTable)}
          >
            {props.asTable ? t("operator.obs.metrics.asChart") : t("operator.obs.metrics.asTable")}
          </ButtonV2>
        </Show>
      </header>
      <Show when={!props.loading} fallback={<div data-slot="operator-chart-state">{t("common.loading")}</div>}>
        <Show
          when={!props.error}
          fallback={
            <div data-slot="operator-error" role="alert">
              {props.error}
              <Show when={props.onRetry}>
                <ButtonV2 size="small" variant="outline" onClick={() => props.onRetry!()}>
                  {t("operator.obs.retry")}
                </ButtonV2>
              </Show>
            </div>
          }
        >
          <Show
            when={!props.empty}
            fallback={
              <div data-slot="operator-chart-state" data-testid="obs-chart-empty">
                {props.empty}
              </div>
            }
          >
            <Show when={props.asTable && props.table} fallback={props.children}>
              {props.table!()}
            </Show>
          </Show>
        </Show>
      </Show>
      <Show when={props.note}>
        <footer data-slot="operator-note" data-testid="obs-chart-source">
          {props.note}
        </footer>
      </Show>
    </section>
  )
}
