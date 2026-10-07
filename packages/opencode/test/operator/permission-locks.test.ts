import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { OperatorPermissionDecide } from "@/operator/permission-decide"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorPermissionDecide.node,
      OperatorPermissionDecisions.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const agents = {
  reviewer: {
    mode: "primary",
    description: "Reviews",
    prompt: "Review.",
    permission: { bash: { "*": "allow", "git push*": "ask" } },
  },
  helper: { mode: "subagent", description: "Helps", prompt: "Help.", permission: { bash: { "*": "allow" } } },
}

// Asks as a running turn does (with the rules it read when it started), and says whether it was
// allowed without a reply.
const allowed = (sessionID: Session.Info["id"], id: string, pattern: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const asked = yield* permission
      .ask({
        id: PermissionV1.ID.make(id),
        sessionID,
        permission: "bash",
        patterns: [pattern],
        metadata: {},
        always: [pattern],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      .pipe(Effect.forkScoped)
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((yield* permission.list()).some((item) => item.id === id)) {
        yield* permission.reply({ requestID: PermissionV1.ID.make(id), reply: "once" })
        yield* Fiber.join(asked)
        return false
      }
      if (asked.pollUnsafe()) break
      yield* Effect.sleep("10 millis")
    }
    yield* Fiber.join(asked)
    return true
  })

unix("a locked agent rule decides whatever the session's rules say, and sessions may not change it", () =>
  Effect.gen(function* () {
    yield* configure({ agent: agents })
    const sessions = yield* Session.Service
    const locks = yield* OperatorPermissionLocks.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    const s = yield* sessions.create({ title: "Review", agent: "reviewer" })

    // Unlocked: the session's broader allow wins.
    yield* sessionPermissions.save(s.id, [{ permission: "bash", pattern: "*", action: "allow" }])
    expect(yield* allowed(s.id, "per_l1", "git push origin main")).toBe(true)

    // Locked: the agent's ask decides, even after the session's `bash *` allow.
    yield* locks.save("reviewer", { locks: [{ permission: "bash", pattern: "git push*" }], inherit: "own" })
    expect(yield* allowed(s.id, "per_l2", "git push origin main")).toBe(false)
    expect(yield* allowed(s.id, "per_l3", "ls")).toBe(true)

    // The session editor: the lock is listed, and a rule that changes it is refused.
    const info = yield* sessionPermissions.get(s.id)
    expect(info.locked).toEqual([{ permission: "bash", pattern: "git push*", action: "ask" }])
    expect(info.allLocked).toBe(false)
    const refused = yield* sessionPermissions
      .save(s.id, [{ permission: "bash", pattern: "git push*", action: "allow" }])
      .pipe(Effect.flip)
    expect(refused._tag).toBe("OperatorSessionPermissionsLocked")
  }),
)

unix("Allow for session is refused for a request a lock decides", () =>
  Effect.gen(function* () {
    yield* configure({ agent: agents })
    const sessions = yield* Session.Service
    const locks = yield* OperatorPermissionLocks.Service
    const decide = yield* OperatorPermissionDecide.Service
    const decisions = yield* OperatorPermissionDecisions.Service
    const permission = yield* Permission.Service
    yield* locks.save("reviewer", { locks: [{ permission: "bash", pattern: "git push*" }], inherit: "own" })
    const s = yield* sessions.create({ title: "Review", agent: "reviewer" })
    const asked = yield* permission
      .ask({
        id: PermissionV1.ID.make("per_d1"),
        sessionID: s.id,
        permission: "bash",
        patterns: ["git push origin main"],
        metadata: {},
        always: ["git push*"],
        ruleset: [],
      })
      .pipe(Effect.forkScoped)
    for (let attempt = 0; attempt < 100 && !decisions.find("per_d1"); attempt++) yield* Effect.sleep("10 millis")
    const refused = yield* decide.decide("per_d1", { decision: "allow-session", via: "inbox" }).pipe(Effect.flip)
    expect(refused._tag).toBe("OperatorPermissionRefused")
    expect(refused.message).toContain("locks")
    yield* decide.decide("per_d1", { decision: "allow", via: "inbox" })
    yield* Fiber.join(asked)
  }),
)

unix("a subagent checks its parent's locks only when it inherits them", () =>
  Effect.gen(function* () {
    yield* configure({ agent: agents })
    const sessions = yield* Session.Service
    const locks = yield* OperatorPermissionLocks.Service
    yield* locks.save("reviewer", { locks: [{ permission: "bash", pattern: "git push*" }], inherit: "own" })
    const parent = yield* sessions.create({ title: "Review", agent: "reviewer" })
    const child = yield* sessions.create({ title: "Help", agent: "helper", parentID: parent.id })

    // Own locks (the default): the helper allows everything.
    expect(yield* allowed(child.id, "per_c1", "git push origin main")).toBe(true)
    // Own + parent's: the reviewer's lock asks.
    yield* locks.save("helper", { locks: [], inherit: "parent" })
    expect(yield* allowed(child.id, "per_c2", "git push origin main")).toBe(false)
  }),
)
