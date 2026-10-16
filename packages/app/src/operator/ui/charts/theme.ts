import { createSignal, onCleanup, onMount } from "solid-js"

// Chart colours from the theme (observability_spec.md §18): canvas can't read CSS variables, so they are resolved to
// rgba here and again when the colour scheme changes. One palette that holds up for common colour blindness (the
// agent colours: blue, orange, pink, green, purple), errors in the theme's danger colour, and never colour alone:
// each series also has its own dash (lines) or pattern (stacked fills).

export type Tone = "danger" | "warning" | "success" | "muted"
export type Rgb = [number, number, number]
export type ChartTheme = {
  palette: Rgb[]
  tones: Record<Tone, Rgb>
  text: Rgb
  grid: Rgb
  background: Rgb
}

const PALETTE = [
  "--v2-agent-build-solid",
  "--v2-agent-explore-solid",
  "--v2-agent-plan-solid",
  "--v2-agent-review-solid",
  "--v2-agent-writer-solid",
]
const TONES: Record<Tone, string> = {
  danger: "--v2-state-fg-danger",
  warning: "--v2-state-fg-warning",
  success: "--v2-state-fg-success",
  muted: "--v2-text-text-muted",
}

/** Line dashes by series index: solid first. */
export const DASHES: number[][] = [[], [6, 3], [2, 3], [10, 3, 2, 3], [1, 4], [12, 5]]
/** Fill patterns by series index (stacked areas and bars): solid first; errors always hatched. */
export const PATTERNS = ["solid", "hatch", "dots", "cross", "back", "solid"] as const
export type Pattern = (typeof PATTERNS)[number]

export const rgba = (color: Rgb, alpha = 1) => `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`
/** A colour laid over the background, opaque: stacked fills drawn over each other never blend. */
export const over = (color: Rgb, background: Rgb, amount: number): Rgb =>
  color.map((value, index) => Math.round(value * amount + background[index]! * (1 - amount))) as Rgb

function resolve(token: string, probe: HTMLElement, pixel: CanvasRenderingContext2D | null): Rgb {
  probe.style.color = `var(${token})`
  const css = getComputedStyle(probe).color
  if (!pixel) return [128, 128, 128]
  // The canvas parses whatever colour syntax the theme uses (hex, rgb, oklch, color-mix…).
  pixel.clearRect(0, 0, 1, 1)
  pixel.fillStyle = "#808080"
  pixel.fillStyle = css
  pixel.fillRect(0, 0, 1, 1)
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data
  return [r ?? 128, g ?? 128, b ?? 128]
}

function read(host: HTMLElement): ChartTheme {
  const probe = document.createElement("span")
  probe.style.display = "none"
  host.appendChild(probe)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const pixel = canvas.getContext("2d", { willReadFrequently: true })
  const theme: ChartTheme = {
    palette: PALETTE.map((token) => resolve(token, probe, pixel)),
    tones: Object.fromEntries(
      Object.entries(TONES).map(([tone, token]) => [tone, resolve(token, probe, pixel)]),
    ) as Record<Tone, Rgb>,
    text: resolve("--v2-text-text-muted", probe, pixel),
    grid: resolve("--v2-border-border-muted", probe, pixel),
    background: resolve("--v2-background-bg-base", probe, pixel),
  }
  probe.remove()
  return theme
}

/** The theme's chart colours, read under `host` and again when the scheme changes. */
export function useChartTheme(host: () => HTMLElement | undefined) {
  const [theme, setTheme] = createSignal<ChartTheme>()
  onMount(() => {
    const sync = () => {
      const element = host()
      if (element) setTheme(read(element))
    }
    sync()
    const observer = new MutationObserver(sync)
    for (const element of [document.documentElement, document.body])
      observer.observe(element, { attributes: true, attributeFilter: ["data-color-scheme", "data-theme", "class"] })
    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    media?.addEventListener?.("change", sync)
    onCleanup(() => {
      observer.disconnect()
      media?.removeEventListener?.("change", sync)
    })
  })
  return theme
}

/** An opaque fill pattern in a colour, for stacked areas and bars. */
export function patternFill(
  ctx: CanvasRenderingContext2D,
  pattern: Pattern,
  color: Rgb,
  background: Rgb,
): string | CanvasPattern {
  const fill = rgba(over(color, background, 0.6))
  if (pattern === "solid") return fill
  const size = 8
  const tile = document.createElement("canvas")
  tile.width = size
  tile.height = size
  const draw = tile.getContext("2d")
  if (!draw) return fill
  draw.fillStyle = rgba(over(color, background, 0.22))
  draw.fillRect(0, 0, size, size)
  draw.strokeStyle = rgba(color)
  draw.fillStyle = rgba(color)
  draw.lineWidth = 1.5
  draw.beginPath()
  if (pattern === "hatch" || pattern === "cross") {
    draw.moveTo(0, size)
    draw.lineTo(size, 0)
  }
  if (pattern === "back" || pattern === "cross") {
    draw.moveTo(0, 0)
    draw.lineTo(size, size)
  }
  draw.stroke()
  if (pattern === "dots") {
    draw.beginPath()
    draw.arc(size / 2, size / 2, 1.5, 0, Math.PI * 2)
    draw.fill()
  }
  return ctx.createPattern(tile, "repeat") ?? fill
}
