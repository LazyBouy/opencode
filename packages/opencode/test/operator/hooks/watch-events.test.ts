import path from "path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { GlobalBus } from "@/bus/global"
import { OperatorHooks } from "@/operator/hooks/hooks"
import { OperatorHookRuns } from "@/operator/hooks/runs"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { agentBodies, ask, MODEL, runsOf, setup, toolParts, unix } from "./harness"

// SPEC-0022 §5, §7.5, §8 for the watch events (session.created, step.after, turn.after, session.error,
// file.edited, session.deleted), which run alongside the session and change nothing; and for compaction: what
// compaction.before adds goes to what the compaction is given, and compaction.after's `continue: false` stops the
// automatic "continue" turn. Watch runs queue one at a time per hook and session, at most 20 waiting.

// A watch hook's runs, once there are `count` of them (they run in the background).
const runsWhen = (directory: string, name: string, count: number) =>
  runsOf(directory, name).pipe(
    Effect.flatMap((runs) => (runs.length >= count ? Effect.succeed(runs) : Effect.fail("not yet" as const))),
    Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
    Effect.orDie,
  )

unix("session.created, step.after and turn.after run once each, with their fields, and change nothing", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      created: { event: "session.created", answer: { allow: false } },
      stepped: { event: "step.after", answer: {} },
      done: { event: "turn.after", answer: {} },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    const result = yield* ask(session.id, "Find the docs")
    // A watch hook's deny is ignored: the session went on.
    expect(result.parts.some((part) => part.type === "text" && part.text === "Done.")).toBe(true)

    const [created] = yield* runsWhen(directory, "created", 1)
    expect(created?.input).toMatchObject({ event: "session.created", session: { id: session.id } })
    const stepped = yield* runsWhen(directory, "stepped", 2)
    expect(
      stepped.map((run) => [run.input.turn, run.input.step, run.input.finish, run.input.tools]).toSorted(),
    ).toEqual([
      [1, 1, "tool-calls", ["glob"]],
      [1, 2, "stop", []],
    ])
    // (OpenCode counts the 3 reasoning tokens apart from the output.)
    expect(stepped[0]?.input.usage).toEqual({ input: 100, output: 4, cached: 0 })
    const [done] = yield* runsWhen(directory, "done", 1)
    expect(done?.input).toMatchObject({ event: "turn.after", turn: 1, steps: 2, finish: "stop" })
    expect(done?.input.usage.input).toBe(200)
    // session.idle and session.status idle both come: turn.after runs once.
    yield* Effect.sleep("600 millis")
    expect(yield* runsOf(directory, "done")).toHaveLength(1)
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id, event: "step.after" }))
    const assistants = (yield* sessions.messages({ sessionID: session.id }))
      .filter((message) => message.info.role === "assistant")
      .map((message) => message.info.id)
    expect(log.runs.map((run) => run.messageID).toSorted()).toEqual(assistants.toSorted())
  }),
)

unix("session.error gives the error; file.edited the file and the call that wrote it", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      failed: { event: "session.error", answer: {} },
      edited: { event: "file.edited", answer: {} },
    })
    const session = yield* sessions.create({})
    const file = path.join(directory, "notes.txt")
    fake.reply({ tool: "write", input: { filePath: file, content: "hello\n" } }, { text: "Written." })
    yield* ask(session.id, "Write the notes")
    const [edited] = yield* runsWhen(directory, "edited", 1)
    const [part] = yield* toolParts(sessions, session.id)
    expect(edited?.input).toMatchObject({ event: "file.edited", file, tool: "write", callID: part?.callID })

    GlobalBus.emit("event", {
      directory,
      payload: {
        type: "session.error",
        properties: { sessionID: session.id, error: { name: "APIError", data: { message: "rate limited" } } },
      },
    })
    const [failed] = yield* runsWhen(directory, "failed", 1)
    expect(failed?.input).toMatchObject({
      event: "session.error",
      error: { name: "APIError", message: "rate limited" },
    })
  }),
)

unix("session.deleted runs go to the deleted sessions' log; the session's own log goes with it", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      gone: { event: "session.deleted", answer: {} },
      stepped: { event: "step.after", answer: {} },
    })
    const session = yield* sessions.create({ title: "Short-lived" })
    fake.reply({ text: "Hi." })
    yield* ask(session.id, "Hello")
    yield* runsWhen(directory, "stepped", 1)
    yield* sessions.remove(session.id)
    const [gone] = yield* runsWhen(directory, "gone", 1)
    expect(gone?.input).toMatchObject({ event: "session.deleted", session: { id: session.id, title: "Short-lived" } })
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ event: "session.deleted" })).pipe(
      Effect.flatMap((found) =>
        found.runs.some((run) => run.sessionID === session.id) ? Effect.succeed(found.runs) : Effect.fail("not yet"),
      ),
      Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
      Effect.orDie,
    )
    expect(log.find((run) => run.sessionID === session.id)?.id).toStartWith(`hr.${OperatorHookRuns.DELETED}.`)
    expect((yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))).total).toBe(0)
  }),
)

unix("compaction.before adds to what the compaction is given; compaction.after stops the automatic continue", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      notes: { event: "compaction.before", answer: { context: "Keep the TODO list." } },
      halt: { event: "compaction.after", answer: { continue: false } },
      steps: { event: "step.before", answer: {} },
    })
    const session = yield* sessions.create({})
    fake.reply({ text: "Hi." }, { text: "Summary of the work." }, { text: "Continuing." })
    yield* ask(session.id, "Hello")
    yield* (yield* SessionCompaction.Service).create({
      sessionID: session.id,
      agent: "build",
      model: MODEL,
      auto: true,
    })
    yield* (yield* SessionPrompt.Service).loop({ sessionID: session.id })

    const bodies = agentBodies(fake)
    expect(bodies.some((body) => body.includes("From hook notes:\\nKeep the TODO list."))).toBe(true)
    // No automatic "continue" message, and no model call after the summary.
    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(JSON.stringify(messages)).not.toContain("compaction_continue")
    expect(bodies).toHaveLength(2)
    // step.before ran for the turn's own call only, not for compaction's.
    expect(yield* runsOf(directory, "steps")).toHaveLength(1)

    const [before] = yield* runsOf(directory, "notes")
    expect(before?.input).toMatchObject({ event: "compaction.before", reason: "overflow" })
    const [after] = yield* runsOf(directory, "halt")
    expect(after?.input).toMatchObject({ event: "compaction.after", autoContinue: true })
    const request = messages.find(
      (message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
    )
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id, event: "compaction.after" }))
    expect(log.runs.map((run) => [run.outcome, run.messageID])).toEqual([["denied", request?.info.id]])
  }),
)

unix("watch runs queue one at a time per hook and session; past 20 waiting they're dropped and counted", () =>
  Effect.gen(function* () {
    const { directory } = yield* setup({ slow: { event: "step.after", answer: {}, sleep: 0.05 } })
    const hooks = yield* OperatorHooks.Service
    const found = yield* hooks.forEvent({ event: "step.after" })
    expect(found.map((hook) => hook.name)).toEqual(["slow"])
    const target = { sessionID: "ses_queue", cwd: directory }
    for (let index = 0; index < 25; index++)
      hooks.watch(found, { event: "step.after", time: new Date().toISOString(), cwd: directory, step: index }, target)
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: "ses_queue" })).pipe(
      Effect.flatMap((found) =>
        found.runs.some((run) => run.outcome === "dropped") ? Effect.succeed(found.runs) : Effect.fail("not yet"),
      ),
      Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
      Effect.orDie,
    )
    // One running, 20 waiting: 21 ran, in order and one at a time; 4 dropped.
    const ran = log.filter((run) => run.outcome === "ok").toReversed()
    expect(ran).toHaveLength(21)
    expect(log.find((run) => run.outcome === "dropped")).toMatchObject({ dropped: 4, hook: "slow" })
    const steps = (yield* runsOf(directory, "slow")).map((run) => run.input.step)
    expect(steps).toEqual(Array.from({ length: 21 }, (_, index) => index))
    for (let index = 1; index < ran.length; index++)
      expect(ran[index]!.time).toBeGreaterThanOrEqual(ran[index - 1]!.time + (ran[index - 1]!.durationMs ?? 0))
    yield* Effect.promise(() => OperatorHookRuns.removeSession("ses_queue"))
  }),
)
