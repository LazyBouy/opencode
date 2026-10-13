import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createEffect, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import {
  HEX,
  hexOf,
  hsvOf,
  isThemeColor,
  rgbOf,
  rgbOfHsv,
  THEME_COLORS,
  type ThemeColor,
} from "../pages/agent-form-checks"
import { SelectV2 } from "./select"

// An agent's colour (agent_form_spec.md §4): None, one of OpenCode's seven theme colours (a swatch in the current
// theme), or Custom colour…: a colour area and hue slider, R, G and B, and the hex code, all kept in step. A theme
// colour is stored by its name, a custom one as #RRGGBB.

// The theme's colour for each name, as the chat shows agents (session-ui message-part.tsx).
export const THEME_SWATCH: Record<ThemeColor, string> = {
  primary: "var(--v2-text-text-accent)",
  secondary: "var(--v2-text-text-muted)",
  accent: "var(--v2-icon-icon-accent)",
  success: "var(--v2-state-fg-success)",
  warning: "var(--v2-state-fg-warning)",
  error: "var(--v2-state-fg-danger)",
  info: "var(--v2-state-fg-info)",
}

const NONE = "@none"
const CUSTOM = "@custom"
type Choice = ThemeColor | typeof NONE | typeof CUSTOM

export function Swatch(props: { color: string | undefined }) {
  return (
    <span
      data-slot="operator-swatch"
      style={{
        background: props.color ? (isThemeColor(props.color) ? THEME_SWATCH[props.color] : props.color) : "none",
      }}
    />
  )
}

export function ColorField(props: { value: string; onChange: (value: string) => void }) {
  const language = useLanguage()
  const t = language.t
  // Custom is chosen once a hex is set, or when picked (before a colour is).
  const [custom, setCustom] = createSignal(false)
  const choice = (): Choice =>
    !props.value ? (custom() ? CUSTOM : NONE) : isThemeColor(props.value) ? props.value : CUSTOM
  const name = (option: Choice) =>
    option === NONE
      ? t("operator.color.none")
      : option === CUSTOM
        ? t("operator.color.custom")
        : t(`operator.color.${option}` as "operator.color.primary")

  // The custom colour's hue is kept apart: a grey has none of its own.
  const [hue, setHue] = createSignal(24)
  const rgb = () => rgbOf(props.value) ?? { r: 255, g: 102, b: 0 }
  const hsv = () => ({ ...hsvOf(rgb()), h: hsvOf(rgb()).s === 0 ? hue() : hsvOf(rgb()).h })
  createEffect(() => {
    const found = rgbOf(props.value)
    if (found && hsvOf(found).s > 0) setHue(hsvOf(found).h)
  })
  const setHsv = (next: { h: number; s: number; v: number }) => {
    setHue(next.h)
    props.onChange(hexOf(rgbOfHsv(next)))
  }
  const [hexText, setHexText] = createSignal<string>()

  let area: HTMLDivElement | undefined
  const pick = (event: PointerEvent) => {
    if (!area) return
    const box = area.getBoundingClientRect()
    const s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    const v = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height))
    setHsv({ h: hsv().h, s, v })
  }
  const keys = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02
    const now = hsv()
    const moves: Record<string, () => void> = {
      ArrowLeft: () => setHsv({ ...now, s: Math.max(0, now.s - step) }),
      ArrowRight: () => setHsv({ ...now, s: Math.min(1, now.s + step) }),
      ArrowUp: () => setHsv({ ...now, v: Math.min(1, now.v + step) }),
      ArrowDown: () => setHsv({ ...now, v: Math.max(0, now.v - step) }),
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    move()
  }
  const channel = (key: "r" | "g" | "b", text: string) => {
    const value = Number(text)
    if (!Number.isInteger(value) || value < 0 || value > 255) return
    props.onChange(hexOf({ ...rgb(), [key]: value }))
  }

  return (
    <div class="flex flex-col gap-2" data-testid="color-field">
      <div class="flex flex-wrap items-center gap-2">
        <SelectV2<Choice>
          appearance="base"
          aria-label={t("operator.agentForm.color")}
          options={[NONE, ...THEME_COLORS, CUSTOM]}
          current={choice()}
          label={name}
          children={(option: Choice) => (
            <span class="inline-flex items-center gap-2">
              <Show when={option !== NONE && option !== CUSTOM}>
                <Swatch color={option} />
              </Show>
              {name(option)}
            </span>
          )}
          onSelect={(option) => {
            if (!option) return
            setCustom(option === CUSTOM)
            if (option === NONE) props.onChange("")
            else if (option === CUSTOM) props.onChange(HEX.test(props.value) ? props.value : hexOf(rgb()))
            else props.onChange(option)
          }}
        />
        <Show when={props.value}>
          <span class="inline-flex items-center gap-1" data-testid="color-chosen">
            <Swatch color={props.value} />
            <code>{isThemeColor(props.value) ? name(props.value) : props.value}</code>
          </span>
        </Show>
      </div>
      <Show when={choice() === CUSTOM}>
        <div data-component="operator-color-picker" data-testid="color-picker">
          <div
            ref={area}
            data-slot="operator-color-area"
            role="slider"
            tabIndex={0}
            aria-label={t("operator.color.area")}
            aria-valuetext={`${Math.round(hsv().s * 100)}%, ${Math.round(hsv().v * 100)}%`}
            style={{ "background-color": `hsl(${hsv().h}, 100%, 50%)` }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              pick(event)
            }}
            onPointerMove={(event) => event.buttons && pick(event)}
            onKeyDown={keys}
          >
            <span
              data-slot="operator-color-marker"
              style={{ left: `${hsv().s * 100}%`, top: `${(1 - hsv().v) * 100}%` }}
            />
          </div>
          <input
            type="range"
            min="0"
            max="359"
            data-slot="operator-color-hue"
            aria-label={t("operator.color.hue")}
            value={Math.round(hsv().h)}
            onInput={(event) => setHsv({ ...hsv(), h: Number(event.currentTarget.value) })}
          />
          <div class="flex flex-wrap items-center gap-2">
            <For each={["r", "g", "b"] as const}>
              {(key) => (
                <label class="inline-flex items-center gap-1">
                  <span>{key.toUpperCase()}</span>
                  <TextInputV2
                    appearance="base"
                    inputMode="numeric"
                    class="operator-color-channel"
                    aria-label={t(`operator.color.${key}` as "operator.color.r")}
                    value={String(rgb()[key])}
                    onInput={(event) => channel(key, event.currentTarget.value)}
                  />
                </label>
              )}
            </For>
            <label class="inline-flex items-center gap-1">
              <span>{t("operator.color.hex")}</span>
              <TextInputV2
                appearance="base"
                class="operator-color-hex"
                aria-label={t("operator.color.hex")}
                value={hexText() ?? props.value}
                onInput={(event) => {
                  const text = event.currentTarget.value.trim()
                  setHexText(text)
                  const hex = text.startsWith("#") ? text : `#${text}`
                  if (HEX.test(hex)) props.onChange(hex.toUpperCase())
                }}
                onBlur={() => setHexText(undefined)}
              />
            </label>
          </div>
        </div>
      </Show>
    </div>
  )
}
