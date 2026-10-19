import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { DateTime } from "luxon"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "./field-help"
import { SelectV2 } from "./select"

// One time range for a whole page (observability_spec.md §8.2): a preset relative to now (it moves with time on
// refresh), or a custom from and to in local time (it stays). Charts zoom by setting a custom range; Reset zoom goes
// back to the range before.

export const PRESETS = ["15m", "1h", "6h", "24h", "7d", "14d", "30d", "90d", "365d"] as const
const CUSTOM = "@custom"

export type TimeRangeValue = { range?: string; from?: number; to?: number }

const toInput = (time: number) => DateTime.fromMillis(time).toFormat("yyyy-LL-dd'T'HH:mm")
const fromInput = (text: string) => {
  const parsed = DateTime.fromFormat(text, "yyyy-LL-dd'T'HH:mm")
  return parsed.isValid ? parsed.toMillis() : undefined
}

export function TimeRange(props: {
  value: TimeRangeValue
  onChange: (value: TimeRangeValue) => void
  /** The range before a zoom, for Reset zoom. */
  zoomedFrom?: TimeRangeValue
  onResetZoom?: () => void
  presets?: ReadonlyArray<string>
}) {
  const language = useLanguage()
  const t = language.t
  const custom = () => props.value.from !== undefined && props.value.to !== undefined
  const [editing, setEditing] = createSignal(false)
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const open = () => {
    const now = Date.now()
    setFrom(toInput(props.value.from ?? now - 24 * 60 * 60_000))
    setTo(toInput(props.value.to ?? now))
    setEditing(true)
  }
  const valid = () => {
    const start = fromInput(from())
    const end = fromInput(to())
    return start !== undefined && end !== undefined && end > start ? { from: start, to: end } : undefined
  }
  const label = (option: string) =>
    option === CUSTOM
      ? custom()
        ? t("operator.timeRange.customShown", {
            from: DateTime.fromMillis(props.value.from!)
              .setLocale(language.intl())
              .toLocaleString(DateTime.DATETIME_SHORT),
            to: DateTime.fromMillis(props.value.to!).setLocale(language.intl()).toLocaleString(DateTime.DATETIME_SHORT),
          })
        : t("operator.timeRange.custom")
      : t(`operator.timeRange.${option}` as "operator.timeRange.24h")
  return (
    <span class="inline-flex flex-wrap items-center gap-2" data-component="operator-time-range">
      <span class="inline-flex items-center">
        <SelectV2<string>
          appearance="base"
          aria-label={t("operator.timeRange.label")}
          options={[...(props.presets ?? PRESETS), CUSTOM]}
          current={custom() ? CUSTOM : (props.value.range ?? "24h")}
          label={label}
          onSelect={(option) => {
            if (!option) return
            if (option === CUSTOM) return open()
            setEditing(false)
            props.onChange({ range: option })
          }}
        />
        <FieldHelp field={t("operator.timeRange.label")} text={t("operator.help.timeRange")} />
      </span>
      <Show when={props.zoomedFrom && props.onResetZoom}>
        <ButtonV2 size="small" variant="ghost" onClick={() => props.onResetZoom!()}>
          {t("operator.timeRange.resetZoom")}
        </ButtonV2>
      </Show>
      <Show when={editing()}>
        <span class="inline-flex flex-wrap items-center gap-2" role="group" aria-label={t("operator.timeRange.custom")}>
          <TextInputV2
            appearance="base"
            type="datetime-local"
            aria-label={t("operator.timeRange.from")}
            value={from()}
            onInput={(event) => setFrom(event.currentTarget.value)}
          />
          <TextInputV2
            appearance="base"
            type="datetime-local"
            aria-label={t("operator.timeRange.to")}
            value={to()}
            onInput={(event) => setTo(event.currentTarget.value)}
          />
          <ButtonV2
            size="small"
            variant="contrast"
            disabled={!valid()}
            onClick={() => {
              const value = valid()
              if (!value) return
              setEditing(false)
              props.onChange(value)
            }}
          >
            {t("operator.timeRange.apply")}
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </ButtonV2>
        </span>
      </Show>
    </span>
  )
}
