import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useOperatorClient } from "../data"

// A session's hook runs of one event (SPEC-0022 §9), kept fresh: each recorded run is announced
// (`operator.hook.ran`) and refetches its session's lists.
export function useSessionHookRuns(sessionID: () => string, directory: () => string | undefined, event: string) {
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const queryClient = useQueryClient()
  const key = () => api.key("hook-runs", sessionID(), event)
  const query = useQuery(() => ({
    queryKey: key(),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.hook.runs({ directory: directory(), session: sessionID(), event, limit: "500" })
        .then((result) => result.data!),
  }))
  const stop = serverSdk().event.listen((item) => {
    const details = item.details as { type?: string; properties?: { sessionID?: string; event?: string } }
    if (details?.type !== "operator.hook.ran") return
    if (details.properties?.sessionID !== sessionID() || details.properties.event !== event) return
    void queryClient.invalidateQueries({ queryKey: key() })
  })
  onCleanup(stop)
  return query
}
