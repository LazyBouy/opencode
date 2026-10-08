import type { OperatorPermissionLocks } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"

// An agent's locked rules (fixes_spec.md §4.2): the rules of its list its sessions may not override,
// by permission and pattern, and, for a subagent, whether it also checks its parent's locks.
export function useAgentLocks(agent: () => string, directory: () => string) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const key = () => api.key("agent-locks", directory(), agent())
  const query = useQuery(() => ({
    queryKey: key(),
    enabled: !!agent() && !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.agentPermissions.locks({ name: agent(), directory: directory() })
        .then((result) => result.data ?? { locks: [], inherit: "own" as const }),
  }))
  const current = (): OperatorPermissionLocks => ready(query) ?? { locks: [], inherit: "own" }
  const locked = (rule: { permission: string; pattern: string }) =>
    current().locks.some((lock) => lock.permission === rule.permission && lock.pattern === rule.pattern)
  const save = (next: OperatorPermissionLocks) =>
    api
      .client()
      .operator.agentPermissions.saveLocks(
        { name: agent(), directory: directory(), operatorPermissionLocks: next },
        { throwOnError: true },
      )
      .then(async (result) => {
        queryClient.setQueryData(key(), result.data)
        // Session editors and waiting requests show the locks.
        await Promise.all(
          ["session-permissions", "permission"].map((part) =>
            queryClient.invalidateQueries({ queryKey: api.key(part) }),
          ),
        )
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.locks.failed"), description: requestError(error) }),
      )
  return {
    query,
    current,
    locked,
    // Replaces the agent's locks and deletions (the Permissions editor's save).
    replace: (next: OperatorPermissionLocks) => save(next),
    // Locks or unlocks one rule.
    set: (rule: { permission: string; pattern: string }, lock: boolean) => {
      const others = current().locks.filter(
        (item) => !(item.permission === rule.permission && item.pattern === rule.pattern),
      )
      return save({
        ...current(),
        locks: lock ? [...others, { permission: rule.permission, pattern: rule.pattern }] : others,
      })
    },
    all: (rules: ReadonlyArray<{ permission: string; pattern: string }>, lock: boolean) =>
      save({
        ...current(),
        locks: lock ? rules.map((rule) => ({ permission: rule.permission, pattern: rule.pattern })) : [],
      }),
    inherit: (value: OperatorPermissionLocks["inherit"]) => save({ ...current(), inherit: value }),
  }
}
