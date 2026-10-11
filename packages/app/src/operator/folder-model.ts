import { useQuery } from "@tanstack/solid-query"
import { ready, useOperatorClient } from "./data"

// A new chat's model (default_models_spec.md §9): the agent's own model, else the folder's default model as the
// server resolves it (Project → Namespace → Settings → OpenCode decides), the value Providers & Models shows for
// the project. Used by context/local.tsx (a fork seam), ahead of the app's own recent models. Shares the
// Providers & Models query, so a change there reaches new chats at once.

export type FolderModel = { providerID: string; modelID: string }

export function useFolderDefaultModel(directory: () => string | undefined) {
  const api = useOperatorClient()
  const query = useQuery(() => ({
    queryKey: api.key("model-defaults", directory()),
    enabled: !!directory(),
    // A server without the fork's routes has no answer: the app's own choice applies.
    retry: false,
    queryFn: () =>
      api
        .client()
        .operator.model.defaults({ directory: directory() })
        .then((result) => result.data ?? null),
  }))
  return (): FolderModel | undefined => {
    const value = ready(query)?.chain?.model.effective.model
    if (!value) return undefined
    const at = value.indexOf("/")
    return at > 0 ? { providerID: value.slice(0, at), modelID: value.slice(at + 1) } : undefined
  }
}
