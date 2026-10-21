import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { OperatorHookRuns } from "@/operator/hooks/runs"
import { OperatorHookSettings } from "@/operator/hooks/settings"
import { SessionPrompt } from "@/session/prompt"
import { agentBodies, ask, MODEL, runsOf, setup, toolParts, unix } from "./harness"

// SPEC-0022 §5, §7.5, §8 for tool and subagent calls, in sessions with a fake provider: a deny keeps the tool
// from running and the model gets the reason; a changed input is what the tool and its permission check see
// (checked against the tool's schema); a changed output and context reach the model after the result and
// are marked on the part; hooks run in order and changes chain; parallel calls run their hooks in parallel; a
// failed tool's tool.after is a watch run; Pause all runs nothing.

unix("tool.before deny: the tool doesn't run, the model gets the reason, and the run is recorded", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      guard: { event: "tool.before", match: ["glob"], answer: { allow: false, reason: "no globbing here" } },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Understood." })
    yield* ask(session.id, "Find the docs")

    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("error")
    if (part?.state.status === "error") expect(part.state.error).toBe("Denied by hook guard: no globbing here")
    const bodies = agentBodies(fake)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toContain("Denied by hook guard: no globbing here")

    // What the hook was given (§7.6), in the session's folder, with its id in the environment.
    const [run] = yield* runsOf(directory, "guard")
    expect(run?.session).toBe(session.id)
    expect(run?.cwd).toBe(yield* Effect.promise(() => fs.realpath(directory)))
    expect(run?.input).toMatchObject({
      event: "tool.before",
      hook: "guard",
      level: "project",
      session: { id: session.id, parentID: null },
      agent: { name: "build", type: "usual" },
      cwd: directory,
      model: { provider: "fakechat", id: "chat-model" },
      tool: "glob",
      input: { pattern: "*.md" },
    })
    expect(run?.input.callID).toMatch(/^call_/)

    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))
    expect(log.runs.map((item) => [item.event, item.hook, item.outcome, item.reason])).toEqual([
      ["tool.before", "guard", "denied", "no globbing here"],
    ])
    expect(log.runs[0]?.callID).toBe(run?.input.callID)
  }),
)

unix("tool.before change: the tool runs with the new input, the original is kept on the part", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup({
      rewrite: { event: "tool.before", match: ["glob"], answer: { input: { pattern: "*.ts" } } },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")

    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("completed")
    if (part?.state.status !== "completed") return
    expect(part.state.output).toContain("b.ts")
    expect(part.state.output).not.toContain("a.md")
    expect(part.state.metadata.hook).toMatchObject({
      input: { by: [{ hook: "rewrite", level: "project" }], original: { pattern: "*.md" } },
    })
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))
    expect(log.runs[0]).toMatchObject({ outcome: "changed", before: expect.stringContaining('"*.md"') })
    expect(log.runs[0]?.after).toContain('"*.ts"')
  }),
)

unix("tool.before change: the permission check sees the new input", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup(
      { rewrite: { event: "tool.before", match: ["glob"], answer: { input: { pattern: "*.ts" } } } },
      { permission: { glob: { "*": "allow", "*.ts": "deny" } } },
    )
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("error")
  }),
)

unix("a changed input that doesn't fit the tool's schema fails the run, which denies by default", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup({
      bad: { event: "tool.before", match: ["glob"], answer: { input: { pattern: 5 } } },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("error")
    if (part?.state.status === "error")
      expect(part.state.error).toBe("Denied by hook bad: Hook bad failed: its input doesn't fit the glob tool's schema")
    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))
    expect(log.runs[0]?.outcome).toBe("failed")
  }),
)

unix("onFailure allow: a failed run is ignored and the tool runs as the model asked", () =>
  Effect.gen(function* () {
    const { fake, sessions } = yield* setup({
      bad: { event: "tool.before", match: ["glob"], answer: "not an object", onFailure: "allow" },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("completed")
    if (part?.state.status === "completed") {
      expect(part.state.output).toContain("a.md")
      expect(part.state.metadata.hook).toBeUndefined()
    }
  }),
)

unix("tool.after: a changed output and context reach the model after the result, marked on the part", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      lint: { event: "tool.after", match: ["glob"], answer: { output: "files: hidden", context: "lint: 0 problems" } },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")

    const [part] = yield* toolParts(sessions, session.id)
    if (part?.state.status !== "completed") throw new Error("not completed")
    expect(part.state.output).toBe("files: hidden\n\nFrom hook lint:\nlint: 0 problems")
    expect(part.state.metadata.hook.output).toMatchObject({ by: [{ hook: "lint" }] })
    expect(part.state.metadata.hook.output.original).toContain("a.md")
    expect(part.state.metadata.hook.context).toMatchObject([
      { hook: "lint", level: "project", event: "tool.after", text: "lint: 0 problems" },
    ])
    expect(agentBodies(fake)[1]).toContain("From hook lint:\\nlint: 0 problems")

    const [run] = yield* runsOf(directory, "lint")
    expect(run?.input).toMatchObject({ event: "tool.after", tool: "glob", input: { pattern: "*.md" } })
    expect(run?.input.output).toContain("a.md")
    expect(typeof run?.input.durationMs).toBe("number")
  }),
)

unix("hooks run in order: a change is what the next hook sees, and contexts follow the result in order", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      one: { event: "tool.before", match: ["glob"], answer: { input: { pattern: "*.ts" }, context: "from one" } },
      two: { event: "tool.before", match: ["glob"], answer: { context: "from two" } },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")

    const [second] = yield* runsOf(directory, "two")
    expect(second?.input.input).toEqual({ pattern: "*.ts" })
    const [part] = yield* toolParts(sessions, session.id)
    if (part?.state.status !== "completed") throw new Error("not completed")
    expect(part.state.output).toMatch(/b\.ts[\s\S]*From hook one:\nfrom one\n\nFrom hook two:\nfrom two$/)
  }),
)

unix("the first deny stops the rest", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      stop: { event: "tool.before", answer: { allow: false } },
      never: { event: "tool.before", answer: {} },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")
    const [part] = yield* toolParts(sessions, session.id)
    if (part?.state.status === "error") expect(part.state.error).toBe("Denied by hook stop.")
    else throw new Error("not denied")
    expect(yield* runsOf(directory, "never")).toEqual([])
  }),
)

unix("two parallel tool calls each run their hooks, at the same time", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      slow: { event: "tool.before", match: ["glob"], answer: {}, sleep: 0.6 },
    })
    const session = yield* sessions.create({})
    fake.reply(
      {
        tools: [
          { tool: "glob", input: { pattern: "*.md" } },
          { tool: "glob", input: { pattern: "*.ts" } },
        ],
      },
      { text: "Done." },
    )
    yield* ask(session.id, "Find files")
    const runs = yield* runsOf(directory, "slow")
    expect(runs.map((run) => run.input.input.pattern).toSorted()).toEqual(["*.md", "*.ts"])
    expect(new Set(runs.map((run) => run.input.callID)).size).toBe(2)
    const log = (yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))).runs
    const [a, b] = log.map((run) => ({ start: run.time, end: run.time + (run.durationMs ?? 0) }))
    expect(a!.start < b!.end && b!.start < a!.end).toBe(true)
    const parts = yield* toolParts(sessions, session.id)
    expect(parts.map((part) => part.state.status)).toEqual(["completed", "completed"])
  }),
)

unix("subagent.before changes the subagent's prompt; subagent.after sees its output; tool.* don't fire for task", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      brief: { event: "subagent.before", match: ["general"], answer: { prompt: "Count to three." } },
      after: { event: "subagent.after", answer: { context: "checked" } },
      tools: { event: "tool.before", answer: {} },
    })
    const session = yield* sessions.create({})
    fake.reply(
      { tool: "task", input: { description: "Count", prompt: "Count to ten.", subagent_type: "general" } },
      { text: "One, two, three." },
      { text: "Done." },
    )
    yield* ask(session.id, "Delegate the counting")

    const [child] = yield* sessions.children(session.id)
    expect(child).toBeDefined()
    const childMessages = yield* sessions.messages({ sessionID: child!.id })
    const firstUser = childMessages.find((message) => message.info.role === "user")
    expect(firstUser?.parts.find((part) => part.type === "text")).toMatchObject({ text: "Count to three." })

    const [part] = yield* toolParts(sessions, session.id)
    if (part?.state.status !== "completed") throw new Error("not completed")
    expect(part.state.metadata.hook.prompt).toMatchObject({ by: [{ hook: "brief" }], original: "Count to ten." })
    expect(part.state.output).toMatch(/From hook after:\nchecked$/)

    const [before] = yield* runsOf(directory, "brief")
    expect(before?.input).toMatchObject({
      event: "subagent.before",
      subagent: "general",
      prompt: "Count to ten.",
      description: "Count",
    })
    const [after] = yield* runsOf(directory, "after")
    expect(after?.input).toMatchObject({ event: "subagent.after", subagent: "general", childSessionID: child!.id })
    expect(after?.input.output).toContain("One, two, three.")
    // The child's own tool calls would be tool.*; the parent's task call isn't.
    expect((yield* runsOf(directory, "tools")).filter((run) => run.input.tool === "task")).toEqual([])
  }),
)

unix("an @agent subtask a hook denies ends as an error with the hook's reason", () =>
  Effect.gen(function* () {
    const { sessions } = yield* setup({
      guard: { event: "subagent.before", answer: { allow: false, reason: "no subagents" } },
    })
    const session = yield* sessions.create({})
    const prompt = yield* SessionPrompt.Service
    yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        model: MODEL,
        parts: [{ type: "subtask", prompt: "Look around", description: "Look", agent: "general" }],
      })
      .pipe(Effect.exit)
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("error")
    if (part?.state.status === "error") expect(part.state.error).toBe("Denied by hook guard: no subagents")
    expect(yield* sessions.children(session.id)).toEqual([])
  }),
)

unix("a failed tool's tool.after is a watch run, and the session goes on", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      seen: { event: "tool.after", match: ["read"], answer: { output: "ignored" } },
    })
    const session = yield* sessions.create({})
    fake.reply({ tool: "read", input: { filePath: path.join(directory, "missing.txt") } }, { text: "Done." })
    const result = yield* ask(session.id, "Read it")
    expect(result.parts.some((part) => part.type === "text" && part.text === "Done.")).toBe(true)

    const log = yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id })).pipe(
      Effect.flatMap((found) => (found.runs.length ? Effect.succeed(found.runs) : Effect.fail("not yet" as const))),
      Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
      Effect.orDie,
    )
    // A watch run: its answer changes nothing ("output" is ignored for a failed call).
    expect(log.map((run) => [run.event, run.hook, run.tool])).toEqual([["tool.after", "seen", "read"]])
    const [run] = yield* runsOf(directory, "seen")
    expect(run?.input).toMatchObject({ event: "tool.after", tool: "read" })
    expect(run?.input.error).toBeTruthy()
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("error")
  }),
)

unix("Pause all: nothing runs and nothing is recorded", () =>
  Effect.gen(function* () {
    const { directory, fake, sessions } = yield* setup({
      guard: { event: "tool.before", answer: { allow: false } },
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => OperatorHookSettings.write({ paused: true })),
      () => Effect.promise(() => OperatorHookSettings.write({ paused: false })),
    )
    const session = yield* sessions.create({})
    fake.reply({ tool: "glob", input: { pattern: "*.md" } }, { text: "Done." })
    yield* ask(session.id, "Find files")
    const [part] = yield* toolParts(sessions, session.id)
    expect(part?.state.status).toBe("completed")
    expect(yield* runsOf(directory, "guard")).toEqual([])
    expect((yield* Effect.promise(() => OperatorHookRuns.list({ sessionID: session.id }))).total).toBe(0)
  }),
)
