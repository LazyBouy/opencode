import { useQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { formatCount } from "../format"

// A prompt text's counters (agent_form_spec.md §6.2): characters · words · tokens. Tokens are counted by the
// model's tokenizer when one is plugged in (tokenizers.ts), else estimated (characters ÷ 4, marked ≈), and are
// asked for again about 200 ms after typing stops.

export function TextCounters(props: { text: string; model?: string; directory?: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [settled, setSettled] = createSignal(props.text)
  createEffect(
    on(
      () => props.text,
      (text) => {
        const timer = setTimeout(() => setSettled(text), 200)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )
  const counted = useQuery(() => ({
    queryKey: api.key("token-count", props.directory, props.model, settled()),
    enabled: settled().length > 0,
    staleTime: Infinity,
    queryFn: () =>
      api
        .client()
        .operator.call.count({
          ...(props.directory ? { directory: props.directory } : {}),
          ...(props.model ? { model: props.model } : {}),
          text: settled(),
        })
        .then((result) => result.data),
  }))
  const words = () => props.text.trim().split(/\s+/).filter(Boolean).length
  const tokens = () => {
    // Read without suspending: a count on its way leaves the page (and what is typed) as it is.
    const found = settled() === props.text ? ready(counted) : undefined
    return found ?? { tokens: Math.ceil(props.text.length / 4) }
  }
  const count = (value: number) => formatCount(value, language.intl())
  return (
    <p data-slot="operator-note" data-testid="text-counters" aria-live="polite">
      {language.t("operator.counters.line", {
        characters: count(props.text.length),
        words: count(words()),
        tokens: tokens().tokenizer ? count(tokens().tokens) : `≈${count(tokens().tokens)}`,
      })}
      <span title={language.t("operator.counters.tokensHelp")}>
        {tokens().tokenizer
          ? ` · ${language.t("operator.counters.by", { tokenizer: tokens().tokenizer! })}`
          : ` · ${language.t("operator.counters.estimated")}`}
      </span>
    </p>
  )
}
