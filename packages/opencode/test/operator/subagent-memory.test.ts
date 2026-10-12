import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorMemoryService } from "@/operator/memory-service"
import { OperatorPermissionEffective } from "@/operator/permission-effective"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorProfileStore } from "@/operator/profile-store"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

// A subagent's Flavor (agent_types_spec.md §3): an incognito subagent's session (the default) has no agent memory
// and locked memory denies no agent rule lifts; a retentive one is like a usual agent; an agent chatted with
// directly (no parent session) never runs incognito.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorProfileStore.node,
      OperatorPermissionLive.node,
      OperatorPermissionLocks.node,
      OperatorMemoryService.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

unix("an incognito subagent's session gets locked memory denies; a retentive one and a direct chat don't", () =>
  Effect.gen(function* () {
    yield* configure({
      agent: {
        // Its own rule allows writing its memory: the incognito lines still win.
        scout: { mode: "subagent", permission: { memory: { "WRITE(agent/*)": "allow", "READ(*)": "allow" } } },
        keeper: {
          mode: "subagent",
          subagentMemory: "retentive",
          permission: { memory: { "WRITE(agent/*)": "allow" } },
        },
      },
    })
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "parent" })
    const scout = yield* sessions.create({ parentID: parent.id, title: "scout", agent: "scout" })
    const keeper = yield* sessions.create({ parentID: parent.id, title: "keeper", agent: "keeper" })

    const memory = yield* OperatorMemoryService.Service
    const scoutContext = yield* memory.context({ sessionID: scout.id, agent: "scout" })
    expect(scoutContext.incognito).toBe(true)
    expect(scoutContext.folders.agent).toBeUndefined()
    expect((yield* memory.context({ sessionID: keeper.id, agent: "keeper" })).incognito).toBe(false)
    // Chatted with directly: no parent session, so not incognito.
    expect((yield* memory.context({ sessionID: parent.id, agent: "scout" })).incognito).toBe(false)

    const effective = OperatorPermissionEffective.handlers.effective!
    const scoutRules = yield* effective({ sessionID: scout.id, agent: "scout" })
    const decide = (rules: ReadonlyArray<PermissionV1.Rule>, pattern: string) =>
      Permission.evaluate("memory", pattern, [...rules]).action
    expect(decide(scoutRules.rules, "WRITE(agent/notes.md)")).toBe("deny")
    expect(decide(scoutRules.rules, "READ(agent/notes.md)")).toBe("deny")
    expect(decide(scoutRules.rules, "FORGET(project/notes.md)")).toBe("deny")
    expect(decide(scoutRules.rules, "READ(project/notes.md)")).toBe("allow")
    expect(
      scoutRules.lines?.some((line) => (line as { from?: { kind: string } }).from?.kind === "session-incognito"),
    ).toBe(true)

    const keeperRules = yield* effective({ sessionID: keeper.id, agent: "keeper" })
    expect(decide(keeperRules.rules, "WRITE(agent/notes.md)")).toBe("allow")
    expect(
      keeperRules.lines?.some((line) => (line as { from?: { kind: string } }).from?.kind === "session-incognito"),
    ).toBe(false)
  }),
)
