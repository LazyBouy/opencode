import { useQuery } from "@tanstack/solid-query"
import { onCleanup } from "solid-js"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useTabs } from "@/context/tabs"

// Data access for operator pages: the server's SDK client, query keys scoped to the server, and
// helpers that several pages share.

export function useOperatorClient() {
  const serverSdk = useServerSDK()
  return {
    client: () => serverSdk().client,
    key: (...parts: unknown[]) => [serverSdk().scope, "operator", ...parts],
  }
}

// A query's data without suspending: undefined until it has data. Reading `.data` of a query that has
// none yet suspends the nearest <Suspense>, which for a page is the one around the whole layout
// (pages/layout-new.tsx): the page is rebuilt and its scroll positions reset.
export function ready<T>(query: { readonly status: string; readonly data: T | undefined }): T | undefined {
  return query.status === "success" ? query.data : undefined
}

export function useServerStatus() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("status"),
    queryFn: () =>
      api
        .client()
        .operator.status()
        .then((result) => result.data!),
    staleTime: 60_000,
  }))
}

export function usePendingPermissions() {
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const query = useQuery(() => ({
    queryKey: api.key("permission"),
    queryFn: () =>
      api
        .client()
        .operator.permission.pending()
        .then((result) => result.data ?? []),
    refetchInterval: 15_000,
  }))
  // Asked and replied events from any project change the list; refresh it right away.
  const stop = serverSdk().event.listen((event) => {
    const type = (event.details as { type?: string } | undefined)?.type
    if (type === "permission.asked" || type === "permission.replied") void query.refetch()
  })
  onCleanup(stop)
  return query
}

export function useOpenSession() {
  const tabs = useTabs()
  const server = useServer()
  return (sessionID: string) => tabs.select(tabs.addSessionTab({ server: server.key, sessionId: sessionID }))
}
