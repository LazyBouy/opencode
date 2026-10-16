import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { csv } from "./model"

// "Show as table" (observability_spec.md §12.1, §18): the chart's numbers, one row per time step (or bucket) and one
// column per series, with a CSV download of the raw values.

export function ChartTable(props: {
  label: string
  header: ReadonlyArray<string>
  /** What the table shows. */
  rows: ReadonlyArray<ReadonlyArray<string>>
  /** What the CSV holds: raw numbers, ISO times. */
  raw: ReadonlyArray<ReadonlyArray<string | number | null>>
  filename: string
}) {
  const t = useLanguage().t
  const download = () => {
    const blob = new Blob([csv(props.header, props.raw)], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${props.filename}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div data-component="operator-chart-table">
      <div data-slot="operator-chart-table-scroll">
        <table data-component="operator-table" aria-label={props.label}>
          <thead>
            <tr>
              <For each={props.header}>{(cell) => <th scope="col">{cell}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell, index) => (index() ? <td data-align="end">{cell}</td> : <th scope="row">{cell}</th>)}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <ButtonV2 size="small" variant="outline" onClick={download} data-testid="obs-chart-csv">
        {t("operator.obs.metrics.csv")}
      </ButtonV2>
    </div>
  )
}
