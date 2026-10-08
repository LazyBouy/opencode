export * as OperatorInbox from "./inbox"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceStore } from "@/project/instance-store"
import { OperatorAgentPermissions } from "./agent-permissions"
import { OperatorAgents } from "./agents"
import { OperatorPermissionDecisions } from "./permission-decisions"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorSessionPermissions } from "./session-permissions"

export const Pending = Schema.Struct({
  directory: Schema.String,
  time: Schema.Finite.annotate({ description: "When the request was raised" }),
  request: PermissionV1.Request,
  session: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      agent: Schema.optional(Schema.String),
      parentID: Schema.optional(Schema.String),
    }),
  ),
  project: Schema.optional(Schema.Struct({ key: Schema.String, namespace: Schema.String })),
  askedBy: Schema.optional(OperatorPermissionRules.Row).annotate({
    description: "The rule that made it ask (none: no rule matched, and OpenCode asks)",
  }),
  lockedBy: Schema.optional(PermissionV1.Rule).annotate({
    description: "The agent's locked rule that decides it: Allow for session is not offered",
  }),
  agentTarget: Schema.optional(
    Schema.Struct({
      builtin: Schema.Boolean.annotate({ description: "OpenCode's built-in agent: Allow for agent is not offered" }),
      path: Schema.optional(Schema.String).annotate({ description: "Where Allow for agent writes the rule" }),
    }),
  ),
}).annotate({ identifier: "OperatorPendingPermission" })
export type Pending = typeof Pending.Type

export interface Interface {
  /** Permission requests waiting for a reply in any project, oldest first, with where they come from. */
  readonly pending: () => Effect.Effect<ReadonlyArray<Pending>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorInbox") {}

// Permission state lives in each project instance, and the server cannot list its instances; the
// decision records follow every project's asked and replied events on the global bus (and drop
// requests whose session stopped or whose project reloaded), which gives one cross-project view.
// Each request is described in its project: the rule that made it ask (the session's full list, with
// origins) and where Allow for agent would write.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decisions = yield* OperatorPermissionDecisions.Service
    const instances = yield* InstanceStore.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    const agentPermissions = yield* OperatorAgentPermissions.Service
    const agents = yield* OperatorAgents.Service
    const live = yield* OperatorPermissionLive.Service

    const describe = (entry: OperatorPermissionDecisions.Asked) =>
      instances
        .provide(
          { directory: entry.directory },
          Effect.gen(function* () {
            const request = entry.request
            const list = yield* sessionPermissions.get(request.sessionID).pipe(Effect.option)
            const rows = list._tag === "Some" ? list.value.rows : []
            // The line that decides a pattern it asks for (permission-model.ts), and the lock that binds it.
            const decided = yield* Effect.forEach(request.patterns, (pattern) =>
              live.decide(request.sessionID, request.permission, pattern),
            )
            const line = decided.find((decision) => decision.action === "ask")?.line
            const asking = line
              ? (rows.findLast(
                  (row) =>
                    row.permission === line.permission &&
                    row.pattern === line.pattern &&
                    row.action === line.action &&
                    row.part === line.part,
                ) ?? {
                  index: 0,
                  permission: line.permission,
                  pattern: line.pattern,
                  action: line.action,
                  part: line.part,
                  from: line.from,
                })
              : undefined
            const agent = entry.agent ?? (list._tag === "Some" ? list.value.agent : undefined)
            const lock = decided.find((decision) => decision.lock)?.lock
            const lockedBy = lock
              ? { permission: lock.permission, pattern: lock.pattern, action: lock.action }
              : undefined
            const found = agent
              ? (yield* agents.list().pipe(Effect.orElseSucceed(() => []))).find((item) => item.name === agent)
              : undefined
            const target =
              agent && found && found.source.kind !== "builtin"
                ? yield* agentPermissions.get(agent).pipe(
                    Effect.map((info) => info.targets.project.path),
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined
            return {
              directory: entry.directory,
              time: entry.time,
              request,
              ...(entry.sessionTitle !== undefined
                ? {
                    session: {
                      title: entry.sessionTitle,
                      ...(agent ? { agent } : {}),
                      ...(entry.parentID ? { parentID: entry.parentID } : {}),
                    },
                  }
                : {}),
              ...(entry.project ? { project: { key: entry.project, namespace: entry.namespace ?? "opencode" } } : {}),
              ...(asking ? { askedBy: asking } : {}),
              ...(lockedBy ? { lockedBy } : {}),
              ...(found
                ? { agentTarget: { builtin: found.source.kind === "builtin", ...(target ? { path: target } : {}) } }
                : {}),
            } satisfies Pending
          }),
        )
        .pipe(
          Effect.orElseSucceed(
            (): Pending => ({ directory: entry.directory, time: entry.time, request: entry.request }),
          ),
        )

    return Service.of({
      pending: () => Effect.forEach(decisions.asked(), describe, { concurrency: 4 }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    OperatorPermissionDecisions.node,
    InstanceStore.node,
    OperatorSessionPermissions.node,
    OperatorAgentPermissions.node,
    OperatorAgents.node,
    OperatorPermissionLive.node,
  ],
})
