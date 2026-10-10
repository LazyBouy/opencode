export * as OperatorMemoryService from "./memory-service"

import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorMemoryDefaults } from "./memory-defaults"
import { OperatorMemoryFolders } from "./memory-folders"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorProfile } from "./profile"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
import { OperatorRegistry } from "./registry"
import { OperatorResolverBuiltins as B } from "./resolver-builtins"

// Short-term memory for the memory tool (memory-tool.ts) and the requests that offer it
// (specs/docs/feedbacks/memory/memory_spec.md §4.3, §5, §6):
// - a call's context: the session's three `.memory` folders, whether it runs incognito (a subagent
//   session: Stage 6 adds retentive subagents), and each level's READ decision from the session's rules;
// - the tool is offered (permission-effective.ts `offered`) in every namespace but OpenCode's; there it is
//   opt-in (its tool list stays upstream's): offered when the agent's profile holds a memory layer, or a
//   `memory` allow is set below Global;
// - the `memory` permission's defaults, written once at start (memory-defaults.ts).

export interface Interface {
  readonly context: (input: {
    sessionID: string
    agent: string
  }) => Effect.Effect<Awaited<ReturnType<NonNullable<typeof OperatorRegistry.memory.context>>>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorMemoryService") {}

export const VERBS = ["READ", "WRITE", "FORGET"] as const
OperatorPermissionEffective.declareVerbs("memory", VERBS)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const config = yield* Config.Service

    yield* Effect.promise(() => OperatorMemoryDefaults.ensure().catch(() => false))

    const rulesOf = (sessionID: string | undefined, agent: string) => {
      const handler = OperatorPermissionEffective.handlers.effective
      if (!handler) return Effect.succeed([] as PermissionV1.Ruleset)
      return handler({ ...(sessionID ? { sessionID } : {}), agent }).pipe(
        Effect.map((found) => found.rules as PermissionV1.Ruleset),
        Effect.orElseSucceed(() => [] as PermissionV1.Ruleset),
      )
    }

    const context = Effect.fn("OperatorMemoryService.context")(function* (input: { sessionID: string; agent: string }) {
      const ctx = yield* InstanceState.context
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const session = yield* sessions.get(SessionID.make(input.sessionID)).pipe(Effect.option)
      const incognito = Option.isSome(session) && !!session.value.parentID
      const home = (yield* config.get()).agent?.[input.agent]?.home
      const folders = yield* Effect.promise(() =>
        OperatorMemoryFolders.of({ project, agent: { name: input.agent, ...(home ? { home } : {}) } }),
      )
      const rules = yield* rulesOf(input.sessionID, input.agent)
      const read = (level: OperatorMemoryFolders.Level) =>
        incognito && level === "agent"
          ? ("deny" as const)
          : Permission.evaluate("memory", `READ(${level}/*)`, [...rules]).action
      return {
        project,
        namespace: folders.namespace.id,
        folders: {
          namespace: folders.namespace.folder,
          project: folders.project,
          ...(folders.agent && !incognito ? { agent: folders.agent } : {}),
        },
        incognito,
        read: { namespace: read("namespace"), project: read("project"), agent: read("agent") },
      }
    })

    // The OpenCode namespace offers the tool only on opt-in. Read for every request: the project's prompt
    // settings are kept for a second (as the prompt plugin keeps them).
    const recent = new Map<string, { at: number; revision: number; opted: boolean }>()
    const optedIn = (project: string, agent: string) =>
      Effect.promise(async () => {
        const key = `${project}\n${agent}`
        const revision = OperatorProfileStore.storeRevision()
        const found = recent.get(key)
        if (found && found.revision === revision && Date.now() - found.at < 1000) return { opted: found.opted }
        const loaded = await OperatorProfileStore.forProject(project)
        if (loaded.catalog.namespace.id !== OperatorProfile.OPENCODE) return { opted: true }
        const slots = OperatorProfile.slotsFor(loaded.catalog, {
          agent,
          setting: loaded.agents[agent],
          project: loaded.project,
        })
        const opted = Object.values(slots)
          .flat()
          .some((id) => {
            const layer = OperatorProfile.findLayer(loaded.catalog, id)
            return !!layer && B.MEMORY_LAYERS.includes(layer.replaces ?? layer.id)
          })
        if (recent.size > 500) recent.clear()
        recent.set(key, { at: Date.now(), revision, opted })
        return { opted }
      })
    const offered: NonNullable<typeof OperatorPermissionEffective.handlers.offered> = (input) =>
      Effect.gen(function* () {
        // An explicit allow below Global (the namespace, project, agent or session) opts in.
        const explicit = input.lines.some(
          (line) =>
            line.permission === "memory" &&
            line.action === "allow" &&
            line.level >= OperatorPermissionRules.LEVELS.indexOf("namespace"),
        )
        if (explicit) return ["memory"]
        const ctx = yield* InstanceState.context
        const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
        const { opted } = yield* optedIn(project, input.agent)
        return opted ? ["memory"] : []
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))

    const register: NonNullable<typeof OperatorRegistry.memory.context> = (input) =>
      Effect.runPromise(context(input).pipe(Effect.provideService(InstanceRef, input.instance as InstanceContext)))
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorRegistry.memory.context = register
        OperatorPermissionEffective.handlers.offered = offered
      }),
      () =>
        Effect.sync(() => {
          if (OperatorRegistry.memory.context === register) OperatorRegistry.memory.context = undefined
          if (OperatorPermissionEffective.handlers.offered === offered)
            OperatorPermissionEffective.handlers.offered = undefined
        }),
    )

    return Service.of({ context })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, Config.node] })
