import { createMemo, For } from "solid-js"
import { type ChartSeries, Swatch } from "./time-chart"

// Per-turn bucket charts (observability_spec.md §12.3, §17): one column per bucket, a bar per series (top 5 + Other
// when grouped), in plain HTML and CSS. Each bar names its bucket, series and count.

export function Histogram(props: {
  buckets: ReadonlyArray<string>
  series: ReadonlyArray<ChartSeries>
  format: (value: number) => string
  /** The accessible name: a text summary. */
  label: string
  /** What a bar says: "4 calls, build: 12 turns". */
  barLabel: (bucket: string, series: ChartSeries, value: number) => string
  height?: number
}) {
  const max = createMemo(() =>
    Math.max(1, ...props.series.flatMap((series) => series.values.map((value) => value ?? 0))),
  )
  return (
    <figure
      data-component="operator-histogram"
      aria-label={props.label}
      style={{ "--chart-height": `${props.height ?? 160}px` }}
    >
      <div data-slot="operator-histogram-plot">
        <For each={props.buckets}>
          {(bucket, at) => (
            <div data-slot="operator-histogram-bucket">
              <div data-slot="operator-histogram-bars">
                <For each={props.series}>
                  {(series, index) => {
                    const value = () => series.values[at()] ?? 0
                    return (
                      <span
                        data-slot="operator-histogram-bar"
                        data-tone={series.tone ?? (series.key === "Other" ? "muted" : undefined)}
                        data-color={series.tone || series.key === "Other" ? undefined : String(index() % 5)}
                        style={{ height: `${(value() / max()) * 100}%` }}
                        title={props.barLabel(bucket, series, value())}
                        aria-label={props.barLabel(bucket, series, value())}
                        role="img"
                      />
                    )
                  }}
                </For>
              </div>
              <span data-slot="operator-histogram-label">{bucket}</span>
            </div>
          )}
        </For>
      </div>
      <ul data-slot="operator-chart-legend">
        <For each={props.series.length > 1 ? props.series : []}>
          {(series, index) => (
            <li>
              <Swatch series={series} index={index()} mode="bars-list" />
              <span>{series.label}</span>
            </li>
          )}
        </For>
      </ul>
    </figure>
  )
}
