import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { useAskText } from "../../ui/confirm"
import { FieldHelp } from "../../ui/field-help"
import type { Params } from "./model"

// "+ Filter" (observability_spec.md §8.1): any §7.2 filter the tab takes, including those without a facet (cost and
// duration bounds, tokens, HTTP status, finish reason, …). Flags (possible loops, stuck) are set at once; the rest ask
// for a value. The filter then shows as a chip, like one picked from a facet.

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Value = "list" | "cost" | "duration" | "tokens" | "http" | "flag"
const VALUE: Record<string, Value> = {
  kind: "list",
  status: "list",
  agent: "list",
  agentType: "list",
  model: "list",
  provider: "list",
  tool: "list",
  mcp: "list",
  errorType: "list",
  finish: "list",
  decision: "list",
  sessionStatus: "list",
  http: "http",
  minCost: "cost",
  maxCost: "cost",
  minDuration: "duration",
  maxDuration: "duration",
  minTokens: "tokens",
  loop: "flag",
  stuck: "flag",
}
const FIELDS: Record<string, ReadonlyArray<string>> = {
  sessions: ["sessionStatus", "agent", "agentType", "model", "minCost", "maxCost", "loop", "stuck"],
  events: [
    "kind",
    "status",
    "agent",
    "agentType",
    "model",
    "provider",
    "tool",
    "mcp",
    "errorType",
    "finish",
    "decision",
    "http",
    "minCost",
    "maxCost",
    "minDuration",
    "maxDuration",
    "minTokens",
    "loop",
  ],
  metrics: ["agent", "agentType", "model", "provider", "tool", "mcp", "status", "errorType"],
}

export function AddFilter(props: { tab: string; current: Params; onAdd: (key: string, value: string) => void }) {
  const t = useLanguage().t
  const ask = useAskText()
  const fields = () => (FIELDS[props.tab] ?? []).filter((key) => !props.current[key])
  const add = async (key: string) => {
    const kind = VALUE[key] ?? "list"
    if (kind === "flag") return props.onAdd(key, "1")
    const name = t(`operator.obs.filter.${key}` as Key)
    const answer = await ask({
      title: t("operator.obs.addFilterTitle", { name }),
      label: t(`operator.obs.filterValue.${kind}` as Key),
      confirm: t("operator.obs.addFilterApply"),
    })
    if (answer) props.onAdd(key, answer.name.replace(/\s*,\s*/g, ","))
  }
  return (
    <span class="inline-flex items-center">
      <MenuV2>
        <MenuV2.Trigger as={ButtonV2} size="small" variant="ghost" data-testid="obs-add-filter">
          <Icon name="plus-small" size="small" />
          <span>{t("operator.obs.addFilter")}</span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <For each={fields()}>
              {(key) => (
                <MenuV2.Item onSelect={() => void add(key)}>{t(`operator.obs.filter.${key}` as Key)}</MenuV2.Item>
              )}
            </For>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <FieldHelp field={t("operator.obs.addFilter")} text={t("operator.obs.help.addFilter")} />
    </span>
  )
}
