export * as OperatorPermissionEffective from "./permission-effective"

import { Effect, Fiber } from "effect"
import { OperatorPermissionModel as Model } from "./permission-model"
import { OperatorPermissionReach } from "./permission-reach"

// The effective permissions R of a session (tool_prompt_from_permission.md §3.3), where upstream reads
// them: the tool list (request.ts: a tool is offered only if some call to it could be allowed or asked,
// §4), the task tool's subagents (registry.ts) and the skills list and MCP instructions
// (session/system.ts). Asks are decided by the permission hook (permission-live.ts).
//
// R is the lines of every level (permission-live.ts), decided as permission-model.ts says, plus one
// ordered list of them for upstream code that checks the last rule that matches. permission-live.ts
// registers the handler; this module has no service imports, so upstream files can import it.

type Rule = { readonly permission: string; readonly pattern: string; readonly action: "allow" | "ask" | "deny" }
type Agent = { readonly name: string; readonly permission: ReadonlyArray<Rule> }

export type Effective = {
  /** One ordered list, for checks of the last rule that matches. */
  readonly rules: ReadonlyArray<Rule>
  /** The lines in levels; absent without the fork's handler (then `rules` is upstream's list). */
  readonly lines?: ReadonlyArray<Model.Line<unknown>>
}

export type Draft = { agentRules?: ReadonlyArray<Rule>; sessionRules?: ReadonlyArray<Rule> }

export const handlers: {
  effective?: (input: {
    sessionID?: string
    agent: string
    session?: ReadonlyArray<Rule>
    draft?: Draft
    permission?: string
  }) => Effect.Effect<Effective>
} = {}

// The session a loop step runs for, by fiber: the fork's messages hook records it at the start of the
// step, so the step's skills list (which upstream builds from the agent alone) can use the session's R.
export const loopSessions = new WeakMap<object, string>()

// An agent carrying draft rules (the Tool Prompt's preview of unsaved rules), for the lists upstream
// builds from it.
export const DRAFT = Symbol.for("opencode.operator.permissionDraft")
export const withDraft = <T extends Agent>(agent: T, draft: Draft): T => Object.assign({ ...agent }, { [DRAFT]: draft })
const draftOf = (agent: Agent) => (agent as { [DRAFT]?: Draft })[DRAFT]

// Without the fork's handler (or if it fails): what upstream used, the agent's rules then the session's.
const fallback = (agent: Agent, session?: ReadonlyArray<Rule>): Effective => ({
  rules: [...agent.permission, ...(session ?? [])],
})

// R for a request (request.ts): the session is known.
export function forRequest(input: { sessionID: string; agent: Agent; permission?: ReadonlyArray<Rule> }) {
  return Effect.suspend(
    () =>
      handlers.effective?.({ sessionID: input.sessionID, agent: input.agent.name }) ??
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
    const draft = draftOf(agent)
    if (!handler) return Effect.succeed(merged(agent, session))
    return handler({
      ...(sessionID && !draft ? { sessionID } : {}),
      agent: agent.name,
      ...(session ? { session } : {}),
      ...(draft ? { draft } : {}),
    }).pipe(Effect.map((effective) => ({ ...agent, permission: [...effective.rules] }) as T))
  }).pipe(Effect.catchCause(() => Effect.succeed(merged(agent, session))))
}
const merged = <T extends Agent>(agent: T, session?: ReadonlyArray<Rule>) =>
  session?.length ? ({ ...agent, permission: fallback(agent, session).rules } as T) : agent

// The permission a tool asks with, as Permission.disabled maps it: edit, write and apply_patch share
// `edit`; the MCP resource tools use `read`; every other tool its id.
const EDITS = ["edit", "write", "apply_patch"]
const READS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
export function permissionOf(tool: string) {
  return EDITS.includes(tool) ? "edit" : READS.includes(tool) ? "read" : tool
}

// Reachability by permission and the lines (or rules) that apply to it, so an unchanged list costs nothing.
const cache = new Map<string, unknown>()
function remember<A>(key: string, make: () => A): A {
  if (cache.has(key)) return cache.get(key) as A
  const result = make()
  if (cache.size > 2000) cache.clear()
  cache.set(key, result)
  return result
}

/** Which decisions the inputs of a permission get from the lines (permission-model.ts `reach`). */
export function reachOf<T>(permission: string, lines: ReadonlyArray<Model.Line<T>>): Model.Reachability<T> {
  const applicable = lines.filter((line) => OperatorPermissionReach.applies(permission, line))
  const key = JSON.stringify([
    permission,
    applicable.map((line) => [line.permission, line.pattern, line.action, line.level, line.lockedAt ?? null]),
  ])
  // Cached by content, with lines by position, so the result maps onto these lines.
  const found = remember(key, () => {
    const result = Model.reach(applicable, permission)
    return {
      ...result,
      live: result.live.map(({ line, lock, ...item }) => ({
        ...item,
        line: line ? applicable.indexOf(line) : -1,
        lock: lock ? applicable.indexOf(lock) : -1,
      })),
    }
  })
  return {
    ...found,
    live: found.live.map(({ line, lock, ...item }) => ({
      ...item,
      ...(line >= 0 ? { line: applicable[line]! } : {}),
      ...(lock >= 0 ? { lock: applicable[lock]! } : {}),
    })),
  }
}

function reachable(permission: string, effective: Effective) {
  if (effective.lines) return reachOf(permission, effective.lines).reachable
  const rules = effective.rules
  const key = JSON.stringify([
    "rules",
    permission,
    rules.filter((rule) => OperatorPermissionReach.applies(permission, rule)),
  ])
  return remember(key, () => OperatorPermissionReach.reach(permission, rules).reachable)
}

// The tools no call could ever be allowed or asked for (§4): dropped from the list.
export function unreachable(tools: ReadonlyArray<string>, effective: Effective) {
  return new Set(tools.filter((tool) => !reachable(permissionOf(tool), effective)))
}
