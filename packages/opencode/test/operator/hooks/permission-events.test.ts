import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { Permission } from "@/permission"
import { agentBodies, ask, runsOf, setup, toolParts, unix } from "./harness"

// SPEC-0022 §8.4: permission.asked runs only for a check that ended in "ask" (after every level, lock and approval),
// before the user is asked. An allow lets the request through once and a deny rejects it with the reason for the
// model, and either way the user isn't asked; no answer, or a failed run, leaves it to the user. The decision record
// names the hook.

const bash = { tool: "bash", input: { command: "echo hi", description: "Say hi" } }

// Answers the first request that asks the user, as they would (once), and says whether one did.
const replyIfAsked = Effect.gen(function* () {
  const permission = yield* Permission.Service
  for (let attempt = 0; attempt < 300; attempt++) {
    const [pending] = yield* permission.list()
    if (pending) {
      yield* permission.reply({ requestID: pending.id, reply: "once" })
      return true
    }
    yield* Effect.sleep("10 millis")
  }
  return false
})

unix("an allow lets the request through once and the user isn't asked; the record names the hook", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup(
      { gate: { event: "permission.asked", match: ["bash"], answer: { allow: true } } },
      { permission: { bash: "ask" } },
    )
    const session = yield* sessions.create({})
    fake.reply(bash, { text: "Done." })
    const running = yield* ask(session.id, "Say hi").pipe(Effect.forkScoped)
    let asked = false
    // Nothing is ever waiting for the user.
    while (!running.pollUnsafe()) {
      if ((yield* (yield* Permission.Service).list()).length) asked = true
      yield* Effect.sleep("10 millis")
    }
    yield* Fiber.join(running)
    expect(asked).toBe(false)
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("completed")
    const [run] = yield* runsOf(directory, "gate")
    expect(run?.input).toMatchObject({
      event: "permission.asked",
      permission: "bash",
      patterns: ["echo hi"],
      tool: "bash",
    })
    expect(run?.input.callID).toBe(part?.callID)
    const records = yield* Effect.promise(() => OperatorPermissionDecisions.read({ sessionID: session.id }))
    expect(records.map((record) => [record.decision, record.via, record.who, record.permission])).toEqual([
      ["allow", "hook", "hook gate", "bash"],
    ])
  }),
)

unix("a deny rejects the request with the hook's reason for the model, and the user isn't asked", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup(
      { gate: { event: "permission.asked", answer: { allow: false, reason: "not on the CI box" } } },
      { permission: { bash: "ask" } },
    )
    const session = yield* sessions.create({})
    fake.reply(bash, { text: "Understood." })
    yield* ask(session.id, "Say hi")
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("error")
    if (part?.state.status === "error") expect(part.state.error).toContain("Denied by hook gate: not on the CI box")
    expect(agentBodies(fake)[1]).toContain("Denied by hook gate: not on the CI box")
    const records = yield* Effect.promise(() => OperatorPermissionDecisions.read({ sessionID: session.id }))
    expect(records).toMatchObject([
      { decision: "deny", via: "hook", who: "hook gate", note: "Denied by hook gate: not on the CI box" },
    ])
  }),
)

for (const [name, hook] of [
  ["no answer", { answer: {} }],
  ["a failed run (whatever onFailure says)", { body: ["exit 3"], onFailure: "deny" }],
] as const)
  unix(`${name} leaves the request to the user`, () =>
    Effect.gen(function* () {
      const { directory, fake, sessions } = yield* setup(
        { gate: { event: "permission.asked", ...hook } },
        { permission: { bash: "ask" } },
      )
      const session = yield* sessions.create({})
      fake.reply(bash, { text: "Done." })
      const running = yield* ask(session.id, "Say hi").pipe(Effect.forkScoped)
      expect(yield* replyIfAsked).toBe(true)
      yield* Fiber.join(running)
      const [part] = yield* toolParts(sessions, session.id)
      expect(part?.state.status).toBe("completed")
      expect(yield* runsOf(directory, "gate")).toHaveLength(1)
    }),
  )

unix("a hook never sees a request a rule already decided", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup(
      { gate: { event: "permission.asked", answer: { allow: true } } },
      { permission: { bash: { "*": "allow", "rm *": "deny" } } },
    )
    const session = yield* sessions.create({})
    fake.reply(bash, { tool: "bash", input: { command: "rm -rf build", description: "Clean" } }, { text: "Done." })
    yield* ask(session.id, "Say hi, then clean")
    const parts = yield* toolParts(sessions, session.id)
    expect(parts.map((part) => part.state.status)).toEqual(["completed", "error"])
    expect(yield* runsOf(directory, "gate")).toEqual([])
  }),
)
