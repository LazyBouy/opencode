export * as OperatorPermissionDecide from "./permission-decide"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorAgentPermissions } from "./agent-permissions"
import { OperatorAgents } from "./agents"
import { OperatorPermissionDecisions } from "./permission-decisions"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorReloadWhenIdle } from "./reload-when-idle"
import { OperatorSessionPermissions } from "./session-permissions"

// The reply card's four choices (fixes_spec.md §3.2), for a request waiting in any project:
// - allow: this request only;
// - allow-session: a session rule allowing the patterns (OpenCode's suggested ones unless edited),
//   which also answers the session's other waiting requests it covers;
// - allow-agent: the agent's own rule (upserted into its file or config entry), applied at once to
//   the agent's sessions (permission-live.ts) while the project reloads only when none of its sessions
//   is running; it also answers the waiting requests of the agent's sessions it covers. Not for
//   OpenCode's built-in agents;
// - deny: rejected, with an optional note sent back to the agent.
// Each decision is recorded (permission-decisions.ts) with where it was made.

export const Input = Schema.Struct({
  decision: Schema.Literals(["allow", "allow-session", "allow-agent", "deny"]),
  patterns: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "allow-session / allow-agent: the rule's patterns (default: the request's suggested ones)",
  }),
  note: Schema.optional(Schema.String).annotate({ description: "deny: a note sent back to the agent" }),
  via: OperatorPermissionDecisions.Via,
}).annotate({ identifier: "OperatorPermissionDecideInput" })
export type Input = typeof Input.Type

export const Result = Schema.Struct({
  rules: Schema.Array(OperatorPermissionDecisions.Written).annotate({ description: "The rules written" }),
  covered: Schema.Array(Schema.String).annotate({ description: "Other waiting requests the rules answered" }),
  reload: Schema.optional(Schema.Literals(["now", "when-idle"])).annotate({
    description: "allow-agent: when the project reloads to read the agent's new rule",
  }),
}).annotate({ identifier: "OperatorPermissionDecideResult" })
export type Result = typeof Result.Type

export class GoneError extends Schema.TaggedErrorClass<GoneError>()("OperatorPermissionGone", {
  message: Schema.String,
}) {}
export class RefusedError extends Schema.TaggedErrorClass<RefusedError>()("OperatorPermissionRefused", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly decide: (requestID: string, input: Input) => Effect.Effect<Result, GoneError | RefusedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionDecide") {}

type Rule = PermissionV1.Rule

// A rule list with these rules in: an existing rule for the same permission and pattern changes, a new
// one goes last.
export function upsert(rules: ReadonlyArray<Rule>, added: ReadonlyArray<Rule>) {
  const out = [...rules]
  for (const rule of added) {
    const at = out.findIndex((item) => item.permission === rule.permission && item.pattern === rule.pattern)
    if (at >= 0) out[at] = rule
    else out.push(rule)
  }
  return out
}

// Whether the rules allow every pattern of a request.
const covers = (rules: ReadonlyArray<Rule>, request: PermissionV1.Request) =>
  request.patterns.every((pattern) => Permission.evaluate(request.permission, pattern, rules).action === "allow")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decisions = yield* OperatorPermissionDecisions.Service
    const instances = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    const live = yield* OperatorPermissionLive.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const permission = yield* Permission.Service
    const agents = yield* OperatorAgents.Service
    const editor = yield* OperatorAgentPermissions.Service
    const agentService = yield* Agent.Service
    // A session's agent; a session started without one has the agent new sessions start with.
    const agentOf = (sessionID: string) =>
      sessions.get(SessionID.make(sessionID)).pipe(
        Effect.flatMap((info) => (info.agent ? Effect.succeed(info.agent) : agentService.defaultAgent())),
        Effect.orElseSucceed(() => undefined),
      )

    const decide = Effect.fn("OperatorPermissionDecide.decide")(function* (requestID: string, input: Input) {
      const entry = decisions.find(requestID)
      if (!entry) return yield* new GoneError({ message: "This request is no longer waiting for a reply" })
      const request = entry.request
      const id = PermissionV1.ID.make(requestID)
      const patterns = (input.patterns ?? (request.always.length ? request.always : request.patterns))
        .map((pattern) => pattern.trim())
        .filter(Boolean)
      const rules: Rule[] = patterns.map((pattern) => ({ permission: request.permission, pattern, action: "allow" }))
      const written = (where: string) =>
        rules.map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: rule.action, where }))

      return yield* instances.provide(
        { directory: entry.directory },
        Effect.gen(function* () {
          const reply = (requestID: PermissionV1.ID, value: "once" | "reject", message?: string) =>
            permission
              .reply({ requestID, reply: value, ...(message ? { message } : {}) })
              .pipe(Effect.mapError(() => new GoneError({ message: "This request is no longer waiting for a reply" })))
          // Other waiting requests the new rules answer: the session's, or (agent rules) the agent's sessions'.
          const answer = (draft: OperatorPermissionDecisions.Draft, belongs: (item: PermissionV1.Request) => boolean) =>
            Effect.gen(function* () {
              const covered: string[] = []
              for (const item of yield* permission.list()) {
                if (item.id === requestID || !belongs(item) || !covers(rules, item)) continue
                decisions.expect(item.id, { ...draft, cause: "covered", by: requestID })
                yield* reply(item.id, "once").pipe(Effect.ignore)
                covered.push(item.id)
              }
              return covered
            })

          switch (input.decision) {
            case "allow": {
              decisions.expect(requestID, { decision: "allow", via: input.via })
              yield* reply(id, "once")
              return { rules: [], covered: [] }
            }
            case "deny": {
              const note = input.note?.trim()
              decisions.expect(requestID, { decision: "deny", via: input.via, ...(note ? { note } : {}) })
              yield* reply(id, "reject", note)
              return { rules: [], covered: [] }
            }
            case "allow-session": {
              if (!rules.length) return yield* new RefusedError({ message: "Give the rule a pattern" })
              // A locked line binds it: a session rule would not change anything.
              const lock = (yield* Effect.forEach(request.patterns, (pattern) =>
                live.decide(request.sessionID, request.permission, pattern),
              )).find((decision) => decision.lock)?.lock
              if (lock)
                return yield* new RefusedError({
                  message: `The ${OperatorPermissionLive.levelName(lock.lockedAt!)} locks the rule ${lock.permission} ${lock.pattern} ${lock.action}: sessions may not override it.`,
                })
              yield* sessionPermissions
                .add(request.sessionID, rules, "allow")
                .pipe(Effect.mapError((error) => new RefusedError({ message: error.message })))
              const draft = { decision: "allow-session" as const, via: input.via }
              decisions.expect(requestID, {
                ...draft,
                rule: { ...written("session")[0]!, pattern: patterns.join(", ") },
              })
              yield* reply(id, "once")
              const covered = yield* answer(draft, (item) => item.sessionID === request.sessionID)
              return { rules: written("session"), covered }
            }
            case "allow-agent": {
              if (!rules.length) return yield* new RefusedError({ message: "Give the rule a pattern" })
              const agent = entry.agent ?? (yield* agentOf(request.sessionID))
              if (!agent) return yield* new RefusedError({ message: "The session's agent is not known" })
              const found = (yield* agents.list()).find((item) => item.name === agent)
              if (!found || found.source.kind === "builtin")
                return yield* new RefusedError({
                  message: "OpenCode's built-in agent: allow it for the session, or edit the agent's permissions.",
                })
              const current = yield* editor
                .get(agent)
                .pipe(Effect.mapError((error) => new RefusedError({ message: error.message })))
              const next = upsert(current.written, rules)
              const saved = yield* editor
                .save({ agent, scope: "project", rules: next, confirmOrder: true })
                .pipe(Effect.mapError((error) => new RefusedError({ message: error.message })))
              yield* live.written({ directory: entry.directory, agent, rules: next })
              const reload = yield* reloads.wantFile(saved.path, entry.directory)
              const draft = { decision: "allow-agent" as const, via: input.via }
              decisions.expect(requestID, {
                ...draft,
                rule: { ...written(saved.path)[0]!, pattern: patterns.join(", ") },
              })
              yield* reply(id, "once")
              const sessionAgents = new Map<string, string | undefined>()
              for (const item of yield* permission.list())
                if (!sessionAgents.has(item.sessionID))
                  sessionAgents.set(item.sessionID, yield* agentOf(item.sessionID))
              const covered = yield* answer(draft, (item) => sessionAgents.get(item.sessionID) === agent)
              return { rules: written(saved.path), covered, reload }
            }
          }
        }),
      )
    })

    return Service.of({ decide })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    OperatorPermissionDecisions.node,
    InstanceStore.node,
    Session.node,
    OperatorSessionPermissions.node,
    OperatorPermissionLive.node,
    OperatorReloadWhenIdle.node,
    Permission.node,
    OperatorAgents.node,
    OperatorAgentPermissions.node,
    Agent.node,
  ],
})
