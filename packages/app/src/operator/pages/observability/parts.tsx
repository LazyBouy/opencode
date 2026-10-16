import { Icon } from "@opencode-ai/ui/icon"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { formatCost, formatCount } from "../../format"
import { cacheHit, durationParts, STATUS_ICON, tokensOf } from "./model"

// Small pieces the Observability tabs share: a status as an icon and a word (§9.2, §18), durations, tokens with their
// split in the tooltip, costs.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

/** A status's word: a session's (§9.2) or a span's. */
export function useStatusWord() {
  const language = useLanguage()
  return (status: string | null | undefined, scope: "session" | "span" = "span") =>
    status ? language.t(`operator.obs.status.${scope}.${status}` as Key) : ""
}

export function Status(props: { status: string | null | undefined; scope?: "session" | "span" }) {
  const word = useStatusWord()
  return (
    <span data-slot="operator-obs-status" data-status={props.status ?? undefined}>
      <Show when={props.status && STATUS_ICON[props.status]}>
        {(icon) => <Icon name={icon() as Parameters<typeof Icon>[0]["name"]} size="small" />}
      </Show>
      <span>{word(props.status, props.scope ?? "span")}</span>
    </span>
  )
}

/** A duration in words: 850 ms, 12.4 s, 2 m 4 s. */
export function useDuration() {
  const language = useLanguage()
  return (ms: number | null | undefined) => {
    if (ms === null || ms === undefined) return ""
    return durationParts(ms)
      .map((part) =>
        language.t(`operator.obs.unit.${part.unit}` as Key, {
          n: new Intl.NumberFormat(language.intl(), { maximumFractionDigits: 1 }).format(part.value),
        }),
      )
      .join(" ")
  }
}

type Tokened = {
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}

/** Total tokens; the tooltip splits input, cache read, cache write, output and reasoning (never one mixed total). */
export function Tokens(props: { row: Tokened }) {
  const language = useLanguage()
  const n = (value: number | null) => formatCount(value ?? 0, language.intl())
  const total = () => tokensOf(props.row)
  return (
    <span
      title={language.t("operator.obs.tokensSplit", {
        input: n(props.row.tokens_input),
        read: n(props.row.tokens_cache_read),
        write: n(props.row.tokens_cache_write),
        output: n(props.row.tokens_output),
        reasoning: n(props.row.tokens_reasoning),
      })}
    >
      {total() ? n(total()) : ""}
    </span>
  )
}

export function Percent(props: { value: number | undefined }) {
  const language = useLanguage()
  return (
    <span>
      {props.value === undefined
        ? ""
        : new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 1 }).format(props.value)}
    </span>
  )
}

export function CacheHit(props: { row: Tokened }) {
  return <Percent value={cacheHit(props.row)} />
}

export function Cost(props: { value: number | null | undefined; title?: string }) {
  const language = useLanguage()
  return <span title={props.title}>{props.value ? formatCost(props.value, language.intl()) : ""}</span>
}

/** A count, empty when 0 (never a red "0"). */
export function Count(props: { value: number | null | undefined; tone?: "bad" }) {
  const language = useLanguage()
  return (
    <span data-tone={props.value && props.tone ? props.tone : undefined}>
      {props.value ? formatCount(props.value, language.intl()) : ""}
    </span>
  )
}
