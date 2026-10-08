export * as OperatorMcpAuthScope from "./mcp-auth-scope"

import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { OperatorNamespaceScope } from "./namespace-scope"

// MCP logins are kept per namespace (capability_scopes_spec.md §8): in the OpenCode namespace by
// server name, as upstream keeps them; in another namespace as `<namespace>/<server>`, so the same server
// name in two namespaces has two logins. The namespace is the one of the instance the call runs in;
// without an instance (a CLI command outside any project) the key is the server name. One line in
// mcp/auth.ts wraps the store's methods with this.

export const keyOf = Effect.fnUntraced(function* (mcpName: string) {
  const instance = yield* InstanceRef
  if (!instance) return mcpName
  const layer = yield* Effect.promise(() => OperatorNamespaceScope.layerOf(instance.directory, instance.worktree))
  return layer.namespace === "opencode" ? mcpName : `${layer.namespace}/${mcpName}`
})

// The store's methods that take a server name first.
const KEYED = [
  "get",
  "getForUrl",
  "set",
  "remove",
  "updateTokens",
  "updateClientInfo",
  "updateCodeVerifier",
  "clearCodeVerifier",
  "updateOAuthState",
  "getOAuthState",
  "clearOAuthState",
] as const

export function wrap<T extends object>(service: T): T {
  const next = { ...service } as Record<string, unknown>
  for (const name of KEYED) {
    const method = (service as Record<string, unknown>)[name]
    if (typeof method !== "function") continue
    next[name] = (mcpName: string, ...rest: unknown[]) =>
      keyOf(mcpName).pipe(
        Effect.flatMap((key) => (method as (...args: unknown[]) => Effect.Effect<unknown>)(key, ...rest)),
      )
  }
  return next as T
}
