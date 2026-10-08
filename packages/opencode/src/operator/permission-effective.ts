export * as OperatorPermissionEffective from "./permission-effective"

import { Effect, Fiber } from "effect"
import { OperatorPermissionReach } from "./permission-reach"

// The effective permission list R of a session (tool_prompt_from_permission.md §3.3), and where
// upstream reads it: every ask (the permission hook returns R, complete and last, so R decides), the
// tool list (request.ts: a tool is offered only if some call to it could be allowed, §4), the task
// tool's subagents (registry.ts) and the skills list and MCP instructions (session/system.ts).
//
// R today, lowest first, the last rule that matches deciding: the agent's rules as loaded with the
// project (OpenCode's defaults, the built-in agent's, config `permission`, the agent's own), the
// agent's rules written since (permission-live.ts), the session's rules as they are now (Allow for
// session and "Always" approvals included), then the locked rules, re-applied last. permission-live.ts
// registers the handler; this module has no service imports, so upstream files can import it.
//
// An ask that is given a narrower list than the agent's (the workflow tool approval, /merge's deny-only
// list) keeps it: its R leaves out the agent's loaded rules (permission-live.ts `rules`).

type Rule = { readonly permission: string; readonly pattern: string; readonly action: "allow" | "ask" | "deny" }
type Agent = { readonly name: string; readonly permission: ReadonlyArray<Rule> }

export const handlers: {
  effective?: (input: {
    sessionID?: string
    agent: string
    base: ReadonlyArray<Rule>
    session?: ReadonlyArray<Rule>
  }) => Effect.Effect<ReadonlyArray<Rule>>
} = {}

// The session a loop step runs for, by fiber: the fork's messages hook records it at the start of the
// step, so the step's skills list (which upstream builds from the agent alone) can use the session's R.
export const loopSessions = new WeakMap<object, string>()

// Without the fork's handler (or if it fails): what upstream used, the agent's rules then the session's.
const fallback = (agent: Agent, session?: ReadonlyArray<Rule>) => [...agent.permission, ...(session ?? [])]
const merged = <T extends Agent>(agent: T, session?: ReadonlyArray<Rule>) =>
  session?.length ? ({ ...agent, permission: fallback(agent, session) } as T) : agent

// R for a request (request.ts): the session is known.
export function forRequest(input: { sessionID: string; agent: Agent; permission?: ReadonlyArray<Rule> }) {
  return Effect.suspend(
    () =>
      handlers.effective?.({ sessionID: input.sessionID, agent: input.agent.name, base: input.agent.permission }) ??
      Effect.succeed(fallback(input.agent, input.permission)),
  ).pipe(Effect.catchCause(() => Effect.succeed(fallback(input.agent, input.permission))))
}

// The agent with R as its rules, where upstream passes only the agent (and maybe the session's rules):
// the loop step's session when the fiber is one, else the given session rules.
export function withEffective<T extends Agent>(agent: T, session?: ReadonlyArray<Rule>) {
  return Effect.suspend(() => {
    const fiber = Fiber.getCurrent()
    const sessionID = fiber ? loopSessions.get(fiber) : undefined
    const handler = handlers.effective
    if (!handler) return Effect.succeed(merged(agent, session))
    return handler({
      ...(sessionID ? { sessionID } : {}),
      agent: agent.name,
      base: agent.permission,
      ...(session ? { session } : {}),
    }).pipe(Effect.map((permission) => ({ ...agent, permission: [...permission] }) as T))
  }).pipe(Effect.catchCause(() => Effect.succeed(merged(agent, session))))
}

// The permission a tool asks with, as Permission.disabled maps it: edit, write and apply_patch share
// `edit`; the MCP resource tools use `read`; every other tool its id.
const EDITS = ["edit", "write", "apply_patch"]
const READS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
export function permissionOf(tool: string) {
  return EDITS.includes(tool) ? "edit" : READS.includes(tool) ? "read" : tool
}

// Reachability results by permission and the rules that apply to it, so an unchanged list costs nothing.
const cache = new Map<string, boolean>()
function reachable(permission: string, rules: ReadonlyArray<Rule>) {
  const key = JSON.stringify([permission, rules.filter((rule) => OperatorPermissionReach.applies(permission, rule))])
  const known = cache.get(key)
  if (known !== undefined) return known
  const result = OperatorPermissionReach.reach(permission, rules).reachable
  if (cache.size > 2000) cache.clear()
  cache.set(key, result)
  return result
}

// The tools no call could ever be allowed for (§4): dropped from the list.
export function unreachable(tools: ReadonlyArray<string>, rules: ReadonlyArray<Rule>) {
  return new Set(tools.filter((tool) => !reachable(permissionOf(tool), rules)))
}
