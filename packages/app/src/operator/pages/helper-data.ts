import { useQuery } from "@tanstack/solid-query"
import { useOperatorClient } from "../data"

/** One namespace's helpers (agent_types_spec.md §4), or every namespace's; asked for only while `enabled`. */
export function useHelpers(ns: () => string | undefined, enabled: () => boolean = () => true) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("helpers", ns() ?? "all"),
    enabled: enabled(),
    queryFn: () =>
      api
        .client()
        .operator.helper.list(ns() ? { ns: ns() } : {})
        .then((result) => result.data ?? []),
  }))
}
