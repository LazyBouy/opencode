import type { OperatorTelemetryAlertEvent } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { ready, useOperatorClient } from "./data"
import type { OperatorPage } from "./pages"

// Firing alerts (observability_spec.md §14.5), kept light: the sidebar's badge, the Alerts tab and the Inbox share one
// query, refreshed every 30 s (the server evaluates every 60 s).

/** Firing alerts, newest first. A server without the console's API (another OpenCode) has none. */
export function useFiringAlerts() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("telemetry-alerts", "firing"),
    refetchInterval: 30_000,
    queryFn: () =>
      api
        .client()
        .operator.telemetry.alertEvents({ firing: "1" }, { throwOnError: true })
        .then((result): OperatorTelemetryAlertEvent[] => (Array.isArray(result.data) ? result.data : [])),
  }))
}

/** What the badges count: firing, not acknowledged, not muted. */
export const needsAttention = (events: ReadonlyArray<OperatorTelemetryAlertEvent>) =>
  events.filter((event) => event.ack_ms === null && !event.muted)

/** The count a nav item shows, if any: Observability counts the firing alerts no one acknowledged. */
export function usePageBadges() {
  const firing = useFiringAlerts()
  return (id: OperatorPage["id"]) => (id === "observability" ? needsAttention(ready(firing) ?? []).length : 0)
}
