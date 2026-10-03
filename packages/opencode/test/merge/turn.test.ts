import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MergeBinding } from "../../src/merge/binding"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { reloadInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { FakeClaude } from "../lib/fake-claude"
import { configure, merge, send, session, unix } from "./harness"

const assistantParts = (sessionID: Session.Info["id"]) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID })
    return messages.filter((msg) => msg.info.role === "assistant").flatMap((msg) => msg.parts)
  })

const textOf = (parts: ReadonlyArray<SessionV1.Part>, role: string) =>
  parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.origin?.role === role)
    .map((part) => part.text)

unix("acceptance 2: text streams into the session before the child exits", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "part one" }, { gate: true }, { text: "part two" }]])
    const chat = yield* session()
    yield* merge(chat.id, "claude")

    const turn = yield* send(chat.id, "go").pipe(Effect.forkChild)
    const streamed = yield* pollWithTimeout(
      Effect.gen(function* () {
        const parts = yield* assistantParts(chat.id)
        return textOf(parts, "projection").includes("part one") ? parts : undefined
      }),
      "first child text never arrived",
      "10 seconds",
    )
    const bindings = yield* MergeBinding.Service
    expect((yield* bindings.active(chat.id))?.binding.process).toBeDefined()
    expect(FakeClaude.starts(yield* fake.log).length).toBe(1)
    expect(textOf(streamed, "projection")).not.toContain("part two")

    yield* fake.open
    yield* Fiber.join(turn)
    expect(textOf(yield* assistantParts(chat.id), "projection")).toEqual(["part one", "part two"])
    expect((yield* bindings.active(chat.id))?.binding.process).toBeUndefined()
  }),
)

unix("acceptance 3: the stored id is Claude's and survives an OpenCode restart", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "first" }], [{ text: "second" }]])
    const chat = yield* session()
    yield* merge(chat.id, "claude")
    yield* send(chat.id, "remember 42")

    const bindings = yield* MergeBinding.Service
    const id = (yield* bindings.active(chat.id))?.binding.externalSessionID
    const first = FakeClaude.starts(yield* fake.log)[0]
    expect(FakeClaude.flag(first.argv, "--session-id")).toBe(id)

    yield* reloadInstance({ directory })
    yield* fake.apply
    yield* send(chat.id, "what number?")

    const runs = FakeClaude.starts(yield* fake.log)
    expect(runs).toHaveLength(2)
    expect(FakeClaude.flag(runs[1].argv, "--resume")).toBe(id)
    expect(runs[1].argv).not.toContain("--session-id")
    expect((yield* bindings.active(chat.id))?.binding.externalSessionID).toBe(id)
  }),
)

unix("acceptance 4: projected tools are never executed and their raw output never reaches OpenCode's model", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    yield* FakeClaude.install([
      [
        { tool: "Bash", input: { command: "touch SENTINEL", description: "make a file" }, output: "RAW-7c1f" },
        { text: "done" },
      ],
    ])
    const chat = yield* session()
    yield* merge(chat.id, "claude")
    yield* send(chat.id, "make the file")

    const tool = (yield* assistantParts(chat.id)).find((part): part is SessionV1.ToolPart => part.type === "tool")
    expect(tool?.tool).toBe("bash")
    expect(tool?.state.status).toBe("completed")
    expect(tool?.metadata?.providerExecuted).toBe(true)
    expect(tool?.origin?.role).toBe("projection")
    expect(
      yield* Effect.promise(() =>
        fs.stat(path.join(directory, "SENTINEL")).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)

    yield* merge(chat.id, "detach")
    yield* llm.text("ok")
    yield* send(chat.id, "what happened?")

    const request = JSON.stringify((yield* llm.inputs)[0])
    expect(request).not.toContain("RAW-7c1f")
    expect(request).toContain("[Merged claude session")
    expect(request).toContain("touch SENTINEL")
  }),
)

unix("acceptance 5: two OpenCode sessions in one directory never share a claude process", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([[{ gate: true }, { text: "reply" }]])
    const left = yield* session()
    const right = yield* session()
    yield* merge(left.id, "claude")
    yield* merge(right.id, "claude")

    const turns = yield* Effect.all([send(left.id, "left"), send(right.id, "right")], { concurrency: 2 }).pipe(
      Effect.forkChild,
    )
    yield* pollWithTimeout(
      fake.log.pipe(Effect.map((entries) => (FakeClaude.starts(entries).length === 2 ? true : undefined))),
      "both children never started",
      "10 seconds",
    )
    yield* fake.open
    yield* Fiber.join(turns)

    const runs = FakeClaude.starts(yield* fake.log)
    const bindings = yield* MergeBinding.Service
    const ids = [
      (yield* bindings.active(left.id))?.binding.externalSessionID,
      (yield* bindings.active(right.id))?.binding.externalSessionID,
    ]
    expect(new Set(runs.map((run) => run.pid)).size).toBe(2)
    expect(new Set(ids).size).toBe(2)
    const byText = (a = "", b = "") => a.localeCompare(b)
    expect(runs.map((run) => FakeClaude.flag(run.argv, "--session-id")).toSorted(byText)).toEqual(ids.toSorted(byText))
  }),
)

unix("acceptance 6: abort kills the child's process group; detach keeps parts and returns to OpenCode's model", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "working" }, { hang: true }]])
    const chat = yield* session()
    yield* merge(chat.id, "claude")

    const turn = yield* send(chat.id, "long task").pipe(Effect.forkChild)
    const grandchild = yield* pollWithTimeout(
      fake.log.pipe(
        Effect.map((entries) => entries.find((entry) => entry.kind === "grandchild")),
        Effect.map((entry) => (entry?.kind === "grandchild" ? entry : undefined)),
      ),
      "child never spawned its own process",
      "10 seconds",
    )
    const prompt = yield* SessionPrompt.Service
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(turn)

    yield* pollWithTimeout(
      Effect.gen(function* () {
        const dead = !(yield* FakeClaude.alive(grandchild.pid)) && !(yield* FakeClaude.alive(grandchild.child))
        return dead ? true : undefined
      }),
      "child process group survived abort",
      "10 seconds",
    )
    const parts = yield* assistantParts(chat.id)
    expect(textOf(parts, "projection")).toContain("working")
    expect(textOf(parts, "summary")[0]).toContain("interrupted")

    yield* merge(chat.id, "detach")
    expect(textOf(yield* assistantParts(chat.id), "projection")).toContain("working")
    yield* llm.text("back in opencode")
    yield* send(chat.id, "hello again")
    expect(yield* llm.calls).toBe(1)
    expect(FakeClaude.starts(yield* fake.log)).toHaveLength(1)
  }),
)
