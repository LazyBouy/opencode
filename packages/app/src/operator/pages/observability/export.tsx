import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useQuery } from "@tanstack/solid-query"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../../data"
import { requestError } from "../config-helpers"

// Export (observability_spec.md §16): the tab's current filter, sort and range as CSV (the visible columns) or JSON
// Lines (every stored field), streamed by the server and saved as opencode-<tab>-<from>-<to>.<ext>. Opening the menu
// counts the rows; past 100,000 it says how many match and asks to narrow the range.

const RANGES: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "14d": 14 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  "90d": 90 * 24 * 60 * 60_000,
  "365d": 365 * 24 * 60 * 60_000,
}

/** opencode-<tab>-<from>-<to>.<ext>, times as the viewer's clock has them (the server's rule, §16). */
export function exportName(tab: string, format: "csv" | "jsonl", query: Record<string, string>, now = Date.now()) {
  const to = query.to ? Number(query.to) : now
  const from = query.from ? Number(query.from) : now - (RANGES[query.range ?? "24h"] ?? RANGES["24h"]!)
  const stamp = (ms: number) => {
    const date = new Date(ms)
    const pad = (value: number) => String(value).padStart(2, "0")
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`
  }
  return `opencode-${tab}-${stamp(from)}-${stamp(to)}.${format === "csv" ? "csv" : "jsonl"}`
}

export function ExportMenu(props: {
  tab: "sessions" | "events" | "logs"
  query: Record<string, string>
  sort?: string
  /** The visible columns, for CSV. */
  columns?: ReadonlyArray<string>
}) {
  const language = useLanguage()
  const t = language.t
  const api = useOperatorClient()
  // Exact numbers: a limit is 100,000, not "100K".
  const exact = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  const [open, setOpen] = createSignal(false)
  const [state, setState] = createSignal<{ busy?: boolean; error?: string }>({})
  const params = () => ({ ...props.query, tab: props.tab, ...(props.sort ? { sort: props.sort } : {}) })
  const count = useQuery(() => ({
    queryKey: api.key("telemetry-export-count", params()),
    enabled: open(),
    queryFn: () =>
      api
        .client()
        .operator.telemetry.exportCount(params(), { throwOnError: true })
        .then((result) => result.data!),
  }))
  const tooMany = () => {
    const found = ready(count)
    return !!found && found.rows > found.limit
  }
  const download = async (format: "csv" | "jsonl") => {
    setState({ busy: true })
    try {
      const result = await api.client().operator.telemetry.export(
        {
          ...params(),
          format,
          tz: String(-new Date().getTimezoneOffset()),
          ...(format === "csv" && props.columns?.length ? { cols: props.columns.join(",") } : {}),
        },
        { parseAs: "blob", throwOnError: true },
      )
      // The server's name when the browser lets it be read (not across origins), else the same rule here.
      const disposition = result.response.headers.get("content-disposition") ?? ""
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? exportName(props.tab, format, props.query)
      const url = URL.createObjectURL(result.data as unknown as Blob)
      const link = document.createElement("a")
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setState({})
    } catch (error) {
      setState({ error: requestError(error) })
    }
  }
  return (
    <span class="inline-flex items-center gap-2">
      <MenuV2 onOpenChange={setOpen}>
        <MenuV2.Trigger as={ButtonV2} size="small" variant="outline" data-testid="obs-export">
          <span>{t("operator.obs.export.menu")}</span>
          <Icon name="chevron-down" size="small" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Group>
              <MenuV2.GroupLabel>
                <span data-testid="obs-export-count">
                  {count.isPending
                    ? t("common.loading")
                    : tooMany()
                      ? t("operator.obs.export.tooMany", {
                          n: exact(ready(count)!.rows),
                          limit: exact(ready(count)!.limit),
                        })
                      : t("operator.obs.export.rows", { n: exact(ready(count)?.rows ?? 0) })}
                </span>
              </MenuV2.GroupLabel>
              <MenuV2.Item disabled={tooMany() || state().busy} onSelect={() => void download("csv")}>
                {t("operator.obs.export.csv")}
              </MenuV2.Item>
              <MenuV2.Item disabled={tooMany() || state().busy} onSelect={() => void download("jsonl")}>
                {t("operator.obs.export.jsonl")}
              </MenuV2.Item>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <Show when={state().error}>
        <span data-slot="operator-error" role="alert">
          {state().error}
        </span>
      </Show>
    </span>
  )
}
