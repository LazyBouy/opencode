import type uPlot from "uplot"
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { pick, stack } from "./model"
import "./charts.css"
import { type ChartTheme, DASHES, PATTERNS, patternFill, rgba, type Rgb, type Tone, useChartTheme } from "./theme"

// Lines, stacked areas and stacked bars over time (observability_spec.md §12.1, §17), on uPlot: a cursor that shows
// every series' value, click-through on a point, drag to zoom, the previous period as dashed lines, and a dotted
// threshold. Keyboard: Left and Right move the cursor and announce its values; Enter opens the step. Pages never touch
// uPlot directly; it loads with the first chart.

export type ChartSeries = {
  key: string
  label: string
  values: ReadonlyArray<number | null>
  tone?: Tone
  /** Drawn as a line over the stacked series. */
  line?: boolean
}

export type TimeChartProps = {
  /** Each step's start (ms). */
  times: ReadonlyArray<number>
  step: number
  from: number
  to: number
  series: ReadonlyArray<ChartSeries>
  mode: "lines" | "area" | "bars"
  /** The previous period aligned to `times`: one line per series (lines), or the stack's total (area, bars). */
  compare?: ReadonlyArray<ReadonlyArray<number | null>>
  /** A dotted line at this value (e.g. 80 % of the context). */
  threshold?: number
  /** A fixed top for the value axis (e.g. 100 %). */
  max?: number
  format: (value: number) => string
  formatTime: (time: number) => string
  /** The accessible name: a text summary of the chart. */
  label: string
  compareLabel?: string
  /** A click (or Enter) on a step: the series it landed on (an index into `series`, or -1), and the step's start. */
  onPoint?: (series: number, time: number) => void
  onZoom?: (from: number, to: number) => void
  height?: number
}

type Plot = typeof uPlot
let loading: Promise<Plot> | undefined
/** uPlot loads with the first chart (the Metrics tab), not with the app. */
export const loadPlot = () =>
  (loading ??= Promise.all([import("uplot"), import("uplot/dist/uPlot.min.css")]).then(([module]) => module.default))

/** A series' colour: its tone, muted for Other, else the palette by position. */
export function colorOf(theme: ChartTheme, series: { key: string; tone?: Tone }, index: number): Rgb {
  if (series.tone) return theme.tones[series.tone]
  if (series.key === "Other") return theme.tones.muted
  return theme.palette[index % theme.palette.length]!
}

export const patternOf = (series: { tone?: Tone }, index: number) =>
  series.tone === "danger" ? "hatch" : PATTERNS[index % PATTERNS.length]!

export function TimeChart(props: TimeChartProps) {
  let host: HTMLDivElement | undefined
  let canvasHost: HTMLDivElement | undefined
  const theme = useChartTheme(() => host)
  const [module] = createResource(loadPlot)
  const [plot, setPlot] = createSignal<uPlot>()
  const [cursor, setCursor] = createSignal<{ idx: number; left: number; top: number }>()
  const [spoken, setSpoken] = createSignal("")
  const stacked = () => props.mode !== "lines"
  const height = () => props.height ?? 180
  // Which series are in the stack (bottom first) and which are lines, as indexes into props.series.
  const layout = () => {
    const all = props.series.map((series, index) => ({ series, index }))
    return {
      stack: stacked() ? all.filter((item) => !item.series.line) : [],
      lines: all.filter((item) => !stacked() || item.series.line),
    }
  }

  const build = (Plot: Plot, colors: ChartTheme, width: number): uPlot => {
    const xs = props.times.map((time) => time + props.step / 2)
    const { stack: inStack, lines } = layout()
    const tops = stack(inStack.map((item) => item.series.values))
    // Draw the stack's top first: each lower fill is opaque and covers the part below its own edge.
    const order = [
      ...inStack.map((item, at) => ({ ...item, values: tops[at]!, stacked: true })).reverse(),
      ...lines.map((item) => ({ ...item, values: [...item.series.values], stacked: false })),
    ]
    const data: Array<Array<number | null>> = [xs, ...order.map((item) => item.values)]
    const series: uPlot.Series[] = [{}]
    for (const item of order) {
      const color = colorOf(colors, item.series, item.index)
      const pattern = patternOf(item.series, item.index)
      series.push({
        label: item.series.label,
        stroke: rgba(color),
        width: item.stacked ? 1 : 2,
        points: { show: false },
        ...(item.stacked
          ? { fill: (self: uPlot) => patternFill(self.ctx, pattern, color, colors.background) }
          : { dash: DASHES[item.index % DASHES.length]! }),
        ...(item.stacked && props.mode === "bars" ? { paths: Plot.paths.bars!({ size: [0.8, 48], align: 0 }) } : {}),
      })
    }
    for (const [at, values] of (props.compare ?? []).entries()) {
      const color = stacked() ? colors.text : colorOf(colors, props.series[at] ?? { key: "" }, at)
      data.push([...values])
      series.push({
        label: props.compareLabel ?? "",
        stroke: rgba(color, 0.75),
        width: 1.5,
        dash: [4, 4],
        points: { show: false },
      })
    }
    const axis = {
      stroke: rgba(colors.text),
      grid: { stroke: rgba(colors.grid), width: 1 },
      ticks: { stroke: rgba(colors.grid), width: 1 },
    }
    const options: uPlot.Options = {
      width,
      height: height(),
      ms: 1,
      series,
      legend: { show: false },
      padding: [8, 12, 0, 0],
      scales: {
        x: { time: true, range: () => [props.from, props.to] },
        y: {
          range: (_self, _min, max) => {
            const top = props.max ?? Math.max(max ?? 0, props.threshold ?? 0)
            return [0, top > 0 ? (props.max ? top : top * 1.08) : 1]
          },
        },
      },
      axes: [axis, { ...axis, size: 72, values: (_self, splits) => splits.map((value) => props.format(value)) }],
      cursor: { drag: { x: true, y: false, setScale: false, dist: 8 }, points: { show: false }, y: false },
      hooks: {
        setCursor: [
          (self) => {
            const idx = self.cursor.idx
            if (idx === null || idx === undefined || self.cursor.left === undefined || self.cursor.left < 0)
              return setCursor(undefined)
            setCursor({ idx, left: self.cursor.left, top: self.cursor.top ?? 0 })
          },
        ],
        setSelect: [
          (self) => {
            const { left, width: wide } = self.select
            if (wide < 8) return
            const from = self.posToVal(left, "x")
            const to = self.posToVal(left + wide, "x")
            self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
            props.onZoom?.(Math.round(from), Math.round(to))
          },
        ],
        draw: [
          (self) => {
            if (props.threshold === undefined) return
            const ctx = self.ctx
            const y = self.valToPos(props.threshold, "y", true)
            ctx.save()
            ctx.strokeStyle = rgba(colors.tones.warning)
            ctx.lineWidth = 1.5 * devicePixelRatio
            ctx.setLineDash([2 * devicePixelRatio, 4 * devicePixelRatio])
            ctx.beginPath()
            ctx.moveTo(self.bbox.left, y)
            ctx.lineTo(self.bbox.left + self.bbox.width, y)
            ctx.stroke()
            ctx.restore()
          },
        ],
      },
    }
    const made = new Plot(options, data as uPlot.AlignedData, canvasHost!)
    made.over.addEventListener("click", () => {
      const idx = made.cursor.idx
      if (idx === null || idx === undefined || !props.onPoint) return
      props.onPoint(seriesAt(idx, made.posToVal(made.cursor.top ?? 0, "y")), props.times[idx]!)
    })
    return made
  }

  // The series a click lands on, as an index into props.series.
  const seriesAt = (idx: number, y: number) => {
    const { stack: inStack, lines } = layout()
    const items = inStack.length ? inStack : lines
    const found = pick(
      items.map((item) => item.series.values),
      idx,
      y,
      inStack.length > 0,
    )
    return found >= 0 ? items[found]!.index : -1
  }

  createEffect(() => {
    const Plot = module()
    const colors = theme()
    if (!Plot || !colors || !canvasHost) return
    const made = build(Plot, colors, Math.max(200, canvasHost.clientWidth))
    setCursor(undefined)
    onCleanup(() => made.destroy())
    setPlot(made)
  })

  onMount(() => {
    if (!canvasHost) return
    const observer = new ResizeObserver(() => {
      const made = plot()
      if (made && canvasHost) made.setSize({ width: Math.max(200, canvasHost.clientWidth), height: height() })
    })
    observer.observe(canvasHost)
    onCleanup(() => observer.disconnect())
  })

  const valuesAt = (idx: number) =>
    props.series
      .map((series, index) => ({ series, index, value: series.values[idx] }))
      .filter((item) => item.value !== null && item.value !== undefined)
  const sayAt = (idx: number) =>
    [
      props.formatTime(props.times[idx]!),
      ...valuesAt(idx).map((item) => `${item.series.label} ${props.format(item.value!)}`),
    ].join(", ")

  const move = (by: number) => {
    const made = plot()
    if (!made || !props.times.length) return
    const current = cursor()?.idx
    const next = Math.min(
      props.times.length - 1,
      Math.max(0, current === undefined ? (by > 0 ? 0 : props.times.length - 1) : current + by),
    )
    made.setCursor({
      left: made.valToPos(props.times[next]! + props.step / 2, "x"),
      top: made.bbox.height / devicePixelRatio / 2,
    })
    setSpoken(sayAt(next))
  }

  return (
    <div ref={host} data-component="operator-chart" data-mode={props.mode}>
      <div
        ref={canvasHost}
        data-slot="operator-chart-plot"
        role="img"
        tabIndex={0}
        aria-label={props.label}
        style={{ height: `${height()}px` }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault()
            move(event.key === "ArrowRight" ? 1 : -1)
          } else if (event.key === "Enter" && cursor() && props.onPoint) {
            event.preventDefault()
            const idx = cursor()!.idx
            const top = valuesAt(idx).toSorted((a, b) => b.value! - a.value!)[0]
            props.onPoint(top?.index ?? -1, props.times[idx]!)
          } else if (event.key === "Escape") plot()?.setCursor({ left: -10, top: -10 })
        }}
        onBlur={() => plot()?.setCursor({ left: -10, top: -10 })}
      >
        <Show when={plot() && cursor()}>
          {(at) => (
            <div
              data-slot="operator-chart-tip"
              style={{
                left: `${(plot()!.over.offsetLeft ?? 0) + at().left + 12}px`,
                top: `${Math.max(0, (plot()!.over.offsetTop ?? 0) + at().top - 12)}px`,
                ...(at().left > (canvasHost?.clientWidth ?? 0) / 2
                  ? { transform: "translateX(calc(-100% - 24px))" }
                  : {}),
              }}
            >
              <div data-slot="operator-chart-tip-time">{props.formatTime(props.times[at().idx]!)}</div>
              <For each={valuesAt(at().idx)}>
                {(item) => (
                  <div data-slot="operator-chart-tip-row">
                    <Swatch series={item.series} index={item.index} mode={props.mode} />
                    <span>{item.series.label}</span>
                    <strong>{props.format(item.value!)}</strong>
                  </div>
                )}
              </For>
              <Show when={props.compare && props.compareLabel}>
                <For each={props.compare}>
                  {(values) => (
                    <Show when={values[at().idx] !== null && values[at().idx] !== undefined}>
                      <div data-slot="operator-chart-tip-row" data-compare="">
                        <span>{props.compareLabel}</span>
                        <strong>{props.format(values[at().idx]!)}</strong>
                      </div>
                    </Show>
                  )}
                </For>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <Legend series={props.series} mode={props.mode} compareLabel={props.compare ? props.compareLabel : undefined} />
      <div role="status" aria-live="polite" data-slot="operator-sr-only">
        {spoken()}
      </div>
    </div>
  )
}

/** A series' mark: its dash for lines, its pattern for stacked fills. */
export function Swatch(props: { series: ChartSeries; index: number; mode: TimeChartProps["mode"] | "bars-list" }) {
  const filled = () => props.mode !== "lines" && !props.series.line
  return (
    <span
      data-slot="operator-chart-swatch"
      data-tone={props.series.tone ?? (props.series.key === "Other" ? "muted" : undefined)}
      data-color={props.series.tone || props.series.key === "Other" ? undefined : String(props.index % 5)}
      data-pattern={filled() ? patternOf(props.series, props.index) : undefined}
      data-dash={filled() ? undefined : String(props.index % DASHES.length)}
      aria-hidden="true"
    />
  )
}

function Legend(props: { series: ReadonlyArray<ChartSeries>; mode: TimeChartProps["mode"]; compareLabel?: string }) {
  return (
    <ul data-slot="operator-chart-legend">
      <For each={props.series}>
        {(series, index) => (
          <li>
            <Swatch series={series} index={index()} mode={props.mode} />
            <span>{series.label}</span>
          </li>
        )}
      </For>
      <Show when={props.compareLabel}>
        <li>
          <span data-slot="operator-chart-swatch" data-compare="" aria-hidden="true" />
          <span>{props.compareLabel}</span>
        </li>
      </Show>
    </ul>
  )
}
