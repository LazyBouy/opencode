import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { GlobalBus } from "@/bus/global"
import { OperatorPermissionDecide } from "@/operator/permission-decide"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorProjectConfig } from "@/operator/project-config"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
// Project writes copy the namespace's config only with consent (project-config.ts): these tests give it.
const it = testEffect(
  Layer.merge(
    LayerNode.compile(
      LayerNode.group([
        root,
        OperatorPermissionDecide.node,
        OperatorPermissionDecisions.node,
        OperatorSessionPermissions.node,
      ]),
      [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
    ),
    Layer.succeed(OperatorProjectConfig.Consent, true),
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const ask = (sessionID: Session.Info["id"], id: string, patterns: string[], always: string[] = patterns) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask({
      id: PermissionV1.ID.make(id),
      sessionID,
      permission: "bash",
      patterns,
      metadata: { command: patterns.join(" && ") },
      always,
      // As a running turn has it: the rules it read when it started.
      ruleset: [],
    })
  })

// Waits until the decision records have every request waiting.
const waiting = (ids: string[]) =>
  Effect.gen(function* () {
    const decisions = yield* OperatorPermissionDecisions.Service
    for (let attempt = 0; attempt < 200; attempt++) {
      if (ids.every((id) => decisions.find(id))) return
      yield* Effect.sleep("10 millis")
    }
    throw new Error(`expected ${ids.join(", ")} waiting`)
  })

const decisionsOf = (sessionID: string) =>
  Effect.promise(() => OperatorPermissionDecisions.read({ sessionID })).pipe(
    Effect.map((list) =>
      Object.fromEntries(list.map((item) => [item.requestID, [item.decision, item.via, item.cause]])),
    ),
  )

unix("Allow for session adds a session rule, answers what it covers, and applies at once in a running turn", () =>
  Effect.gen(function* () {
    yield* configure()
    const sessions = yield* Session.Service
    const decide = yield* OperatorPermissionDecide.Service
    const a = yield* sessions.create({ title: "A" })
    const first = yield* ask(a.id, "per_s1", ["git status"], ["git status*"]).pipe(Effect.forkScoped)
    const second = yield* ask(a.id, "per_s2", ["git diff"], ["git diff*"]).pipe(Effect.forkScoped)
    const other = yield* ask(a.id, "per_s3", ["rm -rf build"]).pipe(Effect.forkScoped)
    yield* waiting(["per_s1", "per_s2", "per_s3"])

    // The suggested pattern, edited to cover every git command.
    const result = yield* decide.decide("per_s1", { decision: "allow-session", patterns: ["git *"], via: "inbox" })
    expect(result.covered).toEqual(["per_s2"])
    expect(result.rules).toEqual([{ permission: "bash", pattern: "git *", action: "allow", where: "session" }])
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect((yield* sessions.get(a.id)).permission).toEqual([{ permission: "bash", pattern: "git *", action: "allow" }])
    const recorded = yield* Effect.promise(() => OperatorSessionPermissions.recorded(a.id))
    expect(recorded.at(-1)).toMatchObject({ pattern: "git *", origin: "allow" })

    // A turn that started before the rule still sees it.
    yield* ask(a.id, "per_s4", ["git log"])

    // Deny with a note: the agent gets it back.
    yield* decide.decide("per_s3", { decision: "deny", note: "Use the clean script.", via: "chat" })
    const denied = yield* Fiber.await(other)
    expect(Exit.isFailure(denied)).toBe(true)
    expect(JSON.stringify(denied)).toContain("Use the clean script.")

    expect(yield* decisionsOf(a.id)).toEqual({
      per_s1: ["allow-session", "inbox", undefined],
      per_s2: ["allow-session", "inbox", "covered"],
      per_s3: ["deny", "chat", undefined],
    })

    // Gone: answered already.
    const gone = yield* decide.decide("per_s1", { decision: "allow", via: "inbox" }).pipe(Effect.flip)
    expect(gone._tag).toBe("OperatorPermissionGone")
  }),
)

unix("Allow for agent writes the agent's rule, applies it at once to its sessions, and is refused for built-ins", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure({
      agent: { reviewer: { mode: "primary", description: "Reviews", prompt: "Review." } },
    })
    const sessions = yield* Session.Service
    const decide = yield* OperatorPermissionDecide.Service
    // A session of this project is running: the project reloads later.
    GlobalBus.emit("event", {
      directory,
      payload: { type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } },
    })

    const built = yield* sessions.create({ title: "Build" })
    const asked = yield* ask(built.id, "per_b1", ["npm test"]).pipe(Effect.forkScoped)
    yield* waiting(["per_b1"])
    const refused = yield* decide.decide("per_b1", { decision: "allow-agent", via: "inbox" }).pipe(Effect.flip)
    expect(refused._tag).toBe("OperatorPermissionRefused")
    expect(refused.message).toContain("built-in agent")
    yield* decide.decide("per_b1", { decision: "allow", via: "inbox" })
    yield* Fiber.join(asked)

    const r1 = yield* sessions.create({ title: "Review 1", agent: "reviewer" })
    const r2 = yield* sessions.create({ title: "Review 2", agent: "reviewer" })
    const one = yield* ask(r1.id, "per_r1", ["npm test"], ["npm test*"]).pipe(Effect.forkScoped)
    const two = yield* ask(r2.id, "per_r2", ["npm test -- --watch"]).pipe(Effect.forkScoped)
    yield* waiting(["per_r1", "per_r2"])
    const result = yield* decide.decide("per_r1", { decision: "allow-agent", via: "agent" })
    expect(result.reload).toBe("when-idle")
    expect(result.covered).toEqual(["per_r2"])
    expect(result.rules[0]).toMatchObject({ permission: "bash", pattern: "npm test*", action: "allow" })
    yield* Fiber.join(one)
    yield* Fiber.join(two)
    // Written to the project's config, as the agent's own rule.
    const written = yield* Effect.promise(() => fs.readFile(result.rules[0]!.where, "utf8"))
    expect(result.rules[0]!.where.startsWith(directory)).toBe(true)
    expect(written).toContain("npm test*")
    // Applied at once to another of its sessions, before the project reloads.
    const r3 = yield* sessions.create({ title: "Review 3", agent: "reviewer" })
    yield* ask(r3.id, "per_r3", ["npm test --coverage"])
    expect(path.isAbsolute(result.rules[0]!.where)).toBe(true)
  }),
)
