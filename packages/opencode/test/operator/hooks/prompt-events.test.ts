import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { OperatorHookRuns } from "@/operator/hooks/runs"
import { OperatorHookSeams } from "@/operator/hooks/seams"
import { SessionPrompt } from "@/session/prompt"
import { agentBodies, ask, MODEL, runsOf, setup, unix } from "./harness"

// SPEC-0022 §5, §8 for a message and the model calls of its turn, in sessions with a fake provider:
// prompt.submitted refuses a message (it isn't saved; the app is told), changes its text (the original is kept)
// or adds context to it; turn.before runs once a turn, before its first model call, and stops it or adds context
// saved with the user message; step.before runs before every model call and its context goes at the end of that
// one request only.

// A hook answering with its event's step (from stdin), to tell one request's context from the next one's.
const stepContext = [
  `step=$(printf '%s' "$input" | sed -n 's/.*"step":\\([0-9]*\\).*/\\1/p')`,
  `printf '{"context":"build is green at step %s"}' "$step"`,
]

unix("prompt.submitted refuses a message: it isn't saved, nothing is asked of the model, and the app is told", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup({
      policy: { event: "prompt.submitted", answer: { allow: false, reason: "no secrets in prompts" } },
    })
    const session = yield* sessions.create({})
    const refused: GlobalEvent[] = []
    const listen = (event: GlobalEvent) => {
      if (event.payload?.type === OperatorHookSeams.REFUSED) refused.push(event)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listen)),
      () => Effect.sync(() => GlobalBus.off("event", listen)),
    )
    const exit = yield* ask(session.id, "My password is hunter2").pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("Refused by hook policy: no secrets in prompts")
    expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
    expect(agentBodies(fake)).toEqual([])
    expect(refused.map((event) => event.payload.properties)).toMatchObject([
      {
        sessionID: session.id,
        hook: "policy",
        reason: "no secrets in prompts",
        message: "Refused by hook policy: no secrets in prompts",
      },
    ])
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))
    expect(log.runs.map((run) => [run.event, run.outcome])).toEqual([["prompt.submitted", "denied"]])
  }),
)

unix("prompt.submitted changes the text (the original kept on the part) and adds context, both sent", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      tidy: {
        event: "prompt.submitted",
        answer: { prompt: "Say hello in French.", context: "The user prefers short answers." },
      },
    })
    const session = yield* sessions.create({})
    fake.reply({ text: "Bonjour." })
    yield* ask(session.id, "say hello in french pls")

    const [user] = yield* sessions.messages({ sessionID: session.id })
    const texts = user!.parts.filter((part) => part.type === "text")
    expect(texts).toMatchObject([
      {
        text: "Say hello in French.",
        metadata: {
          hook: { prompt: { by: [{ hook: "tidy", level: "project" }], original: "say hello in french pls" } },
        },
      },
      {
        synthetic: true,
        text: "From hook tidy:\nThe user prefers short answers.",
        metadata: { hook: { context: [{ hook: "tidy", event: "prompt.submitted" }] } },
      },
    ])
    const [body] = agentBodies(fake)
    expect(body).toContain("Say hello in French.")
    expect(body).not.toContain("say hello in french pls")
    expect(body).toContain("From hook tidy:\\nThe user prefers short answers.")

    const [run] = yield* runsOf(directory, "tidy")
    expect(run?.input).toMatchObject({ event: "prompt.submitted", prompt: "say hello in french pls", files: [] })
    expect(run?.input.command).toBeUndefined()
  }),
)

unix("prompt.submitted names the slash command a message came from, with its template expanded", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup(
      { seen: { event: "prompt.submitted", answer: {} } },
      { command: { greet: { template: "Say hello to $ARGUMENTS." } } },
    )
    const session = yield* sessions.create({})
    fake.reply({ text: "Hello, Bob." })
    yield* (yield* SessionPrompt.Service).command({
      sessionID: session.id,
      command: "greet",
      arguments: "Bob",
      agent: "build",
      model: `${MODEL.providerID}/${MODEL.modelID}`,
    })
    const [run] = yield* runsOf(directory, "seen")
    expect(run?.input).toMatchObject({ prompt: "Say hello to Bob.", command: { name: "greet", arguments: "Bob" } })
  }),
)

unix("turn.before stops a turn before any model call; its message ends with the hook's reason", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup({
      gate: {
        event: "turn.before",
        body: [`case "$input" in *Deploy*) echo '{"allow":false,"reason":"outside working hours"}' ;; esac`],
      },
    })
    const session = yield* sessions.create({})
    // Without the clean stop (§12.3, item 1) the turn ends as an error: the hook's reason.
    const stopped = yield* ask(session.id, "Deploy it").pipe(Effect.exit)
    expect(Exit.isFailure(stopped) && String(stopped.cause)).toContain("Stopped by hook gate: outside working hours")
    expect(agentBodies(fake)).toEqual([])
    const messages = yield* sessions.messages({ sessionID: session.id })
    const assistant = messages.find((message) => message.info.role === "assistant")
    expect(assistant?.info).toMatchObject({
      error: { name: "UnknownError", data: { message: "Stopped by hook gate: outside working hours" } },
    })
    expect(assistant?.info.role === "assistant" && assistant.info.time.completed).toBeTruthy()
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))
    expect(log.runs.map((run) => [run.event, run.outcome])).toEqual([["turn.before", "denied"]])

    // The session goes on with the next message.
    fake.reply({ text: "Sure." })
    const next = yield* ask(session.id, "Explain it instead")
    expect(next.parts.some((part) => part.type === "text" && part.text === "Sure.")).toBe(true)
  }),
)

unix("turn.before runs once a turn and its context is saved with the user message; step.before runs every step", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      date: { event: "turn.before", answer: { context: "Today is 2026-10-21." } },
      step: { event: "step.before", answer: {} },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." }, { text: "Again." })
    yield* ask(session.id, "Find the docs")
    yield* ask(session.id, "Once more")

    const turns = yield* runsOf(directory, "date")
    expect(turns.map((run) => [run.input.turn, run.input.prompt])).toEqual([
      [1, "Find the docs"],
      [2, "Once more"],
    ])
    const steps = yield* runsOf(directory, "step")
    expect(steps.map((run) => [run.input.turn, run.input.step])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ])
    expect(steps.every((run) => typeof run.input.tokensEstimate === "number" && run.input.messages > 0)).toBe(true)

    // Saved with each user message: every request of the turn has it, and later turns keep it.
    const users = (yield* sessions.messages({ sessionID: session.id })).filter(
      (message) => message.info.role === "user",
    )
    for (const user of users)
      expect(user.parts.filter((part) => part.type === "text" && part.synthetic)).toMatchObject([
        {
          text: "From hook date:\nToday is 2026-10-21.",
          metadata: { hook: { context: [{ hook: "date", event: "turn.before" }] } },
        },
      ])
    const bodies = agentBodies(fake)
    expect(bodies).toHaveLength(3)
    for (const body of bodies) expect(body).toContain("From hook date:\\nToday is 2026-10-21.")
  }),
)

unix("step.before context goes at the end of that one request, isn't saved, and is kept with its step's run", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup({ ci: { event: "step.before", body: stepContext } })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find the docs")

    const [first, second] = agentBodies(fake)
    expect(first).toContain("build is green at step 1")
    expect(first).not.toContain("build is green at step 2")
    expect(second).toContain("build is green at step 2")
    expect(second).not.toContain("build is green at step 1")
    // The second request's context comes after the tool's result.
    expect(second!.indexOf("build is green at step 2")).toBeGreaterThan(second!.indexOf("a.md"))

    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(JSON.stringify(messages)).not.toContain("build is green")
    const assistants = messages.filter((message) => message.info.role === "assistant").map((message) => message.info.id)
    const log = (yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))).runs.toReversed()
    expect(log.map((run) => [run.event, run.outcome, run.context, run.messageID])).toEqual([
      ["step.before", "context", "build is green at step 1", assistants[0]],
      ["step.before", "context", "build is green at step 2", assistants[1]],
    ])
  }),
)
