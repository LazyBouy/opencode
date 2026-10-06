import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

// Sessions are made through the instance store; its bootstrap does nothing here.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorAgentSessions.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

unix("an agent's active session is its most recently used; its main session is kept until changed", () =>
  Effect.gen(function* () {
    yield* configure()
    const service = yield* OperatorAgentSessions.Service
    const sessions = yield* Session.Service

    expect(yield* service.state("build")).toEqual({ agent: "build" })

    const first = yield* sessions.create({ agent: "build", title: "First" })
    yield* Effect.sleep("5 millis")
    const second = yield* sessions.create({ agent: "build", title: "Second" })
    yield* sessions.create({ agent: "plan", title: "Plan" })
    yield* sessions.create({ agent: "build", title: "Child", parentID: first.id })
    let state = yield* service.state("build")
    expect(state.active?.id).toBe(second.id)
    expect(state.main).toBeUndefined()

    // Using the first session again makes it the active one.
    yield* Effect.sleep("5 millis")
    yield* sessions.touch(first.id)
    expect((yield* service.state("build")).active?.id).toBe(first.id)

    // Main: set, kept, cleared.
    state = yield* service.setMain("build", second.id)
    expect(state.main?.id).toBe(second.id)
    expect((yield* service.state("plan")).main).toBeUndefined()
    state = yield* service.setMain("build", undefined)
    expect(state.main).toBeUndefined()

    // Archived sessions are neither main nor active.
    yield* service.setMain("build", second.id)
    yield* sessions.setArchived({ sessionID: second.id, time: Date.now() })
    state = yield* service.state("build")
    expect(state.main).toBeUndefined()
    expect(state.active?.id).toBe(first.id)
  }),
)

unix("an agent without a main session gets one made and kept; a deleted session stops being main", () =>
  Effect.gen(function* () {
    yield* configure()
    const service = yield* OperatorAgentSessions.Service
    const sessions = yield* Session.Service

    const made = yield* service.ensureMain("build")
    expect(made.created).toBe(true)
    const again = yield* service.ensureMain("build")
    expect(again).toEqual({ session: made.session, created: false })
    const stored = yield* sessions.get(made.session.id as never)
    expect(stored.agent).toBe("build")
    expect(stored.title).toBe("build · main session")

    yield* sessions.remove(made.session.id as never)
    // The delete event is handled in the background.
    for (let attempt = 0; attempt < 50 && (yield* service.state("build")).main; attempt++)
      yield* Effect.sleep("10 millis")
    expect((yield* service.state("build")).main).toBeUndefined()
    expect(yield* service.defaultAgent()).toBe("build")
  }),
)
