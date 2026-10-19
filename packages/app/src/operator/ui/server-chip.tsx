import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useQuery } from "@tanstack/solid-query"
import { createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useOperatorClient } from "../data"
import { ageOf, formatDateTime } from "../format"

// The server chip (dashboard_spec.md §4.2): a status dot, its word and the version, "● Running · 1.4.2 · up 3 d".
// Not responding: the last two status requests failed. Reconnecting: the event stream has been quiet for longer than
// two heartbeats (the server sends one every 10 s). The tooltip has the platform, architecture and start time; a
// click checks again.

const POLL = 30_000
const QUIET = 25_000

export type ServerState = "running" | "notResponding" | "reconnecting"

export function useServerHealth() {
  const api = useOperatorClient()
  const sdk = useServerSDK()
  const [failures, setFailures] = createSignal(0)
  const status = useQuery(() => ({
    queryKey: api.key("status", "health"),
    refetchInterval: POLL,
    retry: false,
    queryFn: () =>
      api
        .client()
        .operator.status({ throwOnError: true })
        .then((result) => {
          setFailures(0)
          return result.data
        })
        .catch((error: unknown) => {
          setFailures((count) => count + 1)
          throw error
        }),
  }))
  const [heard, setHeard] = createSignal(Date.now())
  const [clock, setClock] = createSignal(Date.now())
  const stop = sdk().event.listen(() => setHeard(Date.now()))
  const timer = setInterval(() => setClock(Date.now()), 5000)
  onCleanup(() => {
    stop()
    clearInterval(timer)
  })
  const state = (): ServerState =>
    failures() >= 2 ? "notResponding" : clock() - heard() > QUIET ? "reconnecting" : "running"
  return { status, state, check: () => void status.refetch() }
}

export function ServerChip(props: { health: ReturnType<typeof useServerHealth> }) {
  const language = useLanguage()
  const t = language.t
  const data = () => (props.health.status.status === "success" ? props.health.status.data : undefined)
  const uptime = () => {
    const found = data()
    if (!found) return ""
    const age = ageOf(Date.now() - found.startedAt)
    return t(`operator.dash.age.${age.unit}`, { n: age.n })
  }
  const tooltip = () => {
    const found = data()
    return found
      ? t("operator.dash.server.tooltip", {
          platform: found.platform,
          arch: found.arch,
          time: formatDateTime(found.startedAt, language.intl()),
        })
      : t("operator.dash.server.unknown")
  }
  return (
    <TooltipV2 value={tooltip()} placement="bottom">
      <button
        type="button"
        data-component="operator-server-chip"
        data-state={props.health.state()}
        data-testid="dash-server"
        onClick={() => props.health.check()}
      >
        <span data-slot="operator-server-dot" aria-hidden="true" />
        <span>{t(`operator.dash.server.${props.health.state()}`)}</span>
        <Show when={data()}>
          {(found) => (
            <span data-slot="operator-server-version">
              {t("operator.dash.server.version", { version: found().version, uptime: uptime() })}
            </span>
          )}
        </Show>
      </button>
    </TooltipV2>
  )
}
