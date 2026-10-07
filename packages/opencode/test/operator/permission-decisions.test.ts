import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(OperatorPermissionDecisions.node, [[InstanceStore.bootstrapNode, noopBootstrap]]),
)

const emit = (directory: string, type: string, properties: object) =>
  GlobalBus.emit("event", { directory, payload: { type, properties } })
const ask = (directory: string, id: string, sessionID = "ses_test") =>
  emit(directory, "permission.asked", {
    id,
    sessionID,
    permission: "bash",
    patterns: ["git push"],
    metadata: { command: "git push" },
    always: ["git push*"],
  })
const reply = (directory: string, requestID: string, value: string, sessionID = "ses_test") =>
  emit(directory, "permission.replied", { sessionID, requestID, reply: value })

const decided = (sessionID: string) =>
  Effect.promise(() => OperatorPermissionDecisions.read({ sessionID })).pipe(
    Effect.map((list) =>
      Object.fromEntries(
        list.map((item) => [item.requestID, [item.decision, item.via, item.cause, item.by, item.note]]),
      ),
    ),
  )

it.effect("keeps the requests waiting until they are answered, stopped or their project closes", () =>
  Effect.gen(function* () {
    const decisions = yield* OperatorPermissionDecisions.Service
    ask("/work/a", "per_a1", "ses_a")
    ask("/work/b", "per_b1", "ses_b")
    ask("/work/b", "per_b2", "ses_b")
    ask("/work/c", "per_c1", "ses_c")
    expect(decisions.asked().map((item) => [item.directory, String(item.request.id)])).toEqual([
      ["/work/a", "per_a1"],
      ["/work/b", "per_b1"],
      ["/work/b", "per_b2"],
      ["/work/c", "per_c1"],
    ])
    reply("/work/a", "per_a1", "once", "ses_a")
    expect(decisions.asked().map((item) => String(item.request.id))).toEqual(["per_b1", "per_b2", "per_c1"])
    emit("/work/b", "server.instance.disposed", { directory: "/work/b" })
    emit("/work/c", "session.idle", { sessionID: "ses_c" })
    expect(decisions.asked()).toEqual([])

    expect(yield* decided("ses_a")).toEqual({ per_a1: ["allow", "client", undefined, undefined, undefined] })
    expect(yield* decided("ses_b")).toEqual({
      per_b1: ["cancelled", "client", "reloaded", undefined, undefined],
      per_b2: ["cancelled", "client", "reloaded", undefined, undefined],
    })
    expect(yield* decided("ses_c")).toEqual({ per_c1: ["cancelled", "client", "stopped", undefined, undefined] })
  }),
)

it.effect("records what the fork decided, and the requests a reject cascades to", () =>
  Effect.gen(function* () {
    ask("/work/d", "per_d1", "ses_d")
    ask("/work/d", "per_d2", "ses_d")
    ask("/work/d", "per_d3", "ses_d")
    // The reply card denied d1 with a note; upstream rejects the session's other waiting requests.
    OperatorPermissionDecisions.expect("per_d1", { decision: "deny", via: "inbox", note: "use a branch" })
    reply("/work/d", "per_d1", "reject", "ses_d")
    reply("/work/d", "per_d2", "reject", "ses_d")
    reply("/work/d", "per_d3", "reject", "ses_d")
    expect(yield* decided("ses_d")).toEqual({
      per_d1: ["deny", "inbox", undefined, undefined, "use a branch"],
      per_d2: ["deny", "inbox", "cascade", "per_d1", undefined],
      per_d3: ["deny", "inbox", "cascade", "per_d1", undefined],
    })

    // The TUI's Always: a session rule with OpenCode's suggested patterns.
    ask("/work/e", "per_e1", "ses_e")
    reply("/work/e", "per_e1", "always", "ses_e")
    const [always] = yield* Effect.promise(() => OperatorPermissionDecisions.read({ sessionID: "ses_e" }))
    expect(always).toMatchObject({
      decision: "allow-session",
      via: "client",
      rule: { permission: "bash", pattern: "git push*", action: "allow", where: "session" },
      permission: "bash",
      patterns: ["git push"],
    })
    expect(typeof always!.who).toBe("string")
  }),
)
