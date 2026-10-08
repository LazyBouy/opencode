export * as OperatorPermissionLive from "./permission-live"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorPermissionHook } from "./permission-hook"

// The effective list R every permission ask also checks, after the ones it was given (the fork line in
// permission/index.ts): complete (it starts with the agent's loaded rules, OpenCode's defaults first)
// and last, so it decides. The same R is what the tool list, the subagent list, the skills list and the
// MCP instructions use (permission-effective.ts). After the agent's loaded rules, in this order, the
// last that matches deciding:
// 1. an agent's own rules as just written (Allow for agent, the agent's Permissions editor): OpenCode
//    reads an agent's rules when its project loads, and the project reloads only when none of its
//    sessions is running (reload-when-idle.ts), so until then they apply from here, at once, even in
//    a running turn;
// 2. the session's own rules as they are now (OpenCode reads them once per turn), except for doom_loop,
//    which OpenCode asks with the agent's rules only;
// 3. the agent's locked rules, which sessions may not override (`locks`, registered by the locks
//    service).
// So: the agent's loaded rules < its rules written since < the session's < Always approvals < locks.
// An agent rule removed in the editor still applies until the project reloads.

type Rule = PermissionV1.Rule

export interface Interface {
  /** An agent's own rules as just written to its file or config entry, applied at once. */
  readonly written: (input: { directory: string; agent: string; rules: ReadonlyArray<Rule> }) => Effect.Effect<void>
  /** What an ask in this session checks last, for this permission. */
  readonly rules: (sessionID: string, permission: string) => Effect.Effect<ReadonlyArray<Rule>>
  /** An agent's own rules written since its project loaded, not read by OpenCode yet. */
  readonly pending: (directory: string, agent: string) => ReadonlyArray<Rule>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionLive") {}

// The locked rules of a session's agent (fixes_spec §4.2), registered by the locks service.
export const locks: {
  of?: (input: { directory: string; agent: string; parentID?: string }) => Effect.Effect<ReadonlyArray<Rule>>
} = {}

const keyOf = (directory: string, agent: string) => `${directory}\u0000${agent}`
const same = (a: Rule, b: Rule | undefined) =>
  !!b && a.permission === b.permission && a.pattern === b.pattern && a.action === b.action
const startsWith = (list: ReadonlyArray<Rule>, prefix: ReadonlyArray<Rule>) =>
  prefix.length <= list.length && prefix.every((rule, index) => same(rule, list[index]))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const written = new Map<string, ReadonlyArray<Rule>>()

    // A project that reloads has read what was written; every project, after a global reload.
    const onEvent = (event: GlobalEvent) => {
      const type = (event.payload as { type?: string } | undefined)?.type
      if (type === "global.disposed") return written.clear()
      if (type !== "server.instance.disposed" || !event.directory) return
      for (const key of written.keys()) if (key.startsWith(`${event.directory}\u0000`)) written.delete(key)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    // R: the agent's loaded rules (`base`), its rules written since, the session's rules now (from the
    // session, or as given when there is none), then the locked rules.
    const effective = Effect.fn("OperatorPermissionLive.effective")(function* (input: {
      sessionID?: string
      agent: string | undefined
      base: ReadonlyArray<Rule>
      session?: ReadonlyArray<Rule>
      permission?: string
    }) {
      const info = input.sessionID ? yield* sessions.get(SessionID.make(input.sessionID)) : undefined
      const directory = info?.directory ?? (yield* InstanceState.context).directory
      const agent = input.agent
      const own = agent ? (written.get(keyOf(directory, agent)) ?? []) : []
      const sessionRules = info ? (info.permission ?? []) : (input.session ?? [])
      const session = input.permission === "doom_loop" ? [] : sessionRules
      const locked =
        agent && locks.of
          ? yield* locks.of({
              directory,
              agent,
              ...(info?.parentID ? { parentID: info.parentID } : {}),
            })
          : []
      return [...input.base, ...own, ...session, ...locked]
    })

    // An ask's R. It starts with the agent's loaded rules only when the ask was given them (a tool's ask,
    // doom_loop): then R is complete and decides. An ask that passes its own narrower list (the workflow
    // tool approval: none, so it always asks; /merge: only the deny rules) keeps it, and R's later parts
    // (rules saved since, the session's, the locks) follow it, so they still apply.
    const rules = Effect.fn("OperatorPermissionLive.rules")(function* (
      sessionID: string,
      permission: string,
      given?: ReadonlyArray<Rule>,
    ) {
      const info = yield* sessions.get(SessionID.make(sessionID))
      // A session started without an agent has the agent new sessions start with.
      const agent = info.agent ?? (yield* agents.defaultAgent())
      const loaded = (yield* agents.get(agent).pipe(Effect.orElseSucceed(() => undefined)))?.permission ?? []
      const base = given === undefined || startsWith(given, loaded) ? loaded : []
      return yield* effective({ sessionID, agent, base, permission })
    })

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorPermissionHook.handlers.rules = (input) =>
          rules(input.sessionID, input.permission, input.given).pipe(Effect.orElseSucceed(() => []))
        OperatorPermissionEffective.handlers.effective = (input) =>
          effective(input).pipe(Effect.orElseSucceed(() => [...input.base, ...(input.session ?? [])]))
      }),
      () =>
        Effect.sync(() => {
          OperatorPermissionHook.handlers.rules = undefined
          OperatorPermissionEffective.handlers.effective = undefined
        }),
    )

    return Service.of({
      written: (input) => Effect.sync(() => written.set(keyOf(input.directory, input.agent), [...input.rules])),
      rules: (sessionID, permission) => rules(sessionID, permission).pipe(Effect.orElseSucceed(() => [])),
      pending: (directory, agent) => written.get(keyOf(directory, agent)) ?? [],
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, Agent.node] })
