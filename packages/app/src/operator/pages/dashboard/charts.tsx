import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "../../ui/field-help"

// The two charts (dashboard_spec.md §7), Activity and Spend: their place on the page, kept so the layout doesn't move
// when they arrive (§14 phase 3 draws them with Observability's chart components).

export function DashboardCharts() {
  const t = useLanguage().t
  const charts = [
    { id: "activity", title: t("operator.dash.chart.activity"), help: t("operator.dash.help.activity") },
    { id: "spend", title: t("operator.dash.chart.spend"), help: t("operator.dash.help.spendCost") },
  ]
  return (
    <For each={charts}>
      {(chart) => (
        <section
          data-component="operator-panel"
          data-slot="operator-dash-chart"
          aria-labelledby={`dash-chart-${chart.id}`}
          data-testid={`dash-chart-${chart.id}`}
        >
          <h2 id={`dash-chart-${chart.id}`} data-slot="operator-panel-title">
            {chart.title}
            <FieldHelp field={chart.title} text={chart.help} />
          </h2>
          <div data-slot="operator-dash-chart-area" />
        </section>
      )}
    </For>
  )
}
