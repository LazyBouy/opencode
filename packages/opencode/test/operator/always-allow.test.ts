import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, session } from "../merge/harness"

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorSessionPermissions.node]), replacements))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const rule = (permission: string, pattern: string, action: "allow" | "ask" | "deny") => ({
  permission,
  pattern,
  action,
})

// Waits until `count` permission requests are pending.
const pending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* permission.list()).length >= count) return
      yield* Effect.sleep("10 millis")
    }
    throw new Error(`expected ${count} pending requests`)
  })

unix("Always in session A is kept with A (its origin recorded), covers A's waiting requests, and not B's", () =>
  Effect.gen(function* () {
    yield* configure()
    // Building the service registers the fork's handlers.
    yield* OperatorSessionPermissions.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const a = yield* session()
    const b = yield* session()
    const ask = (sessionID: Session.Info["id"], id: string) =>
      permission.ask({
        id: PermissionV1.ID.make(id),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

    const first = yield* ask(a.id, "per_a1").pipe(Effect.forkScoped)
    const second = yield* ask(a.id, "per_a2").pipe(Effect.forkScoped)
    yield* pending(2)
    yield* permission.reply({ requestID: PermissionV1.ID.make("per_a1"), reply: "always" })
    yield* Fiber.join(first)
    yield* Fiber.join(second)

    // Kept with session A: its rules, and where they came from.
    expect((yield* sessions.get(a.id)).permission).toEqual([rule("bash", "ls", "allow")])
    const recorded = yield* Effect.promise(() => OperatorSessionPermissions.recorded(a.id))
    expect(recorded).toEqual([expect.objectContaining({ ...rule("bash", "ls", "allow"), origin: "always" })])
    const info = yield* (yield* OperatorSessionPermissions.Service).get(a.id)
    expect(info.rows.at(-1)?.from.kind).toBe("session-always")

    // Session B still asks.
    const other = yield* ask(b.id, "per_b1").pipe(Effect.forkScoped)
    yield* pending(1)
    expect((yield* permission.list()).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_b1")])
    yield* permission.reply({ requestID: PermissionV1.ID.make("per_b1"), reply: "once" })
    yield* Fiber.join(other)

    // Removed in the editor: it stops applying at once.
    yield* (yield* OperatorSessionPermissions.Service).save(a.id, [])
    const again = yield* ask(a.id, "per_a3").pipe(Effect.forkScoped)
    yield* pending(1)
    yield* permission.reply({ requestID: PermissionV1.ID.make("per_a3"), reply: "once" })
    yield* Fiber.join(again)
  }),
)

unix("a client's tool switches merge into the session's rules, replacing only earlier switches of the same tools", () =>
  Effect.gen(function* () {
    yield* configure()
    yield* OperatorSessionPermissions.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const current = yield* session()
    yield* sessions.setPermission({
      sessionID: current.id,
      permission: [rule("read", "*.secret", "deny"), rule("webfetch", "*", "allow")],
    })
    yield* prompt.prompt({
      sessionID: current.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      parts: [{ type: "text", text: "no web please" }],
      tools: { webfetch: false },
      noReply: true,
    })
    expect((yield* sessions.get(current.id)).permission).toEqual([
      rule("read", "*.secret", "deny"),
      rule("webfetch", "*", "deny"),
    ])
    const recorded = yield* Effect.promise(() => OperatorSessionPermissions.recorded(current.id))
    expect(recorded).toEqual([expect.objectContaining({ ...rule("webfetch", "*", "deny"), origin: "client" })])
  }),
)
