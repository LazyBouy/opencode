import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { MergeBinding } from "../../src/merge/binding"
import { ClaudeSessions } from "../../src/merge/adapter/claude/sessions"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { FakeClaude } from "../lib/fake-claude"
import { configure, merge, send, session, unix } from "./harness"

// `/merge` fails with NamedError.Unknown, whose human message lives in `data.message`.
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return ""
  const error = Cause.squash(exit.cause)
  return error instanceof NamedError.Unknown ? error.data.message : Cause.pretty(exit.cause)
}

const transcript = (config: string, cwd: string, id: string) =>
  Effect.promise(async () => {
    const file = path.join(config, "projects", ClaudeSessions.slug(cwd), `${id}.jsonl`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "Earlier work", sessionId: id }),
        JSON.stringify({ type: "user", message: { role: "user", content: "fix the parser" }, gitBranch: "main", cwd }),
      ].join("\n") + "\n",
    )
  })

unix("acceptance 1: /merge claude without the binary fails before any change", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure()
    yield* FakeClaude.uninstall()
    const chat = yield* session()
    const sessions = yield* Session.Service
    const before = yield* sessions.messages({ sessionID: chat.id })

    const exit = yield* merge(chat.id, "claude").pipe(Effect.exit)

    expect(failure(exit)).toContain("was not found on PATH")
    expect(yield* (yield* MergeBinding.Service).latest(chat.id)).toBeUndefined()
    expect((yield* sessions.messages({ sessionID: chat.id })).length).toBe(before.length)
    expect((yield* sessions.get(chat.id)).model).toEqual(chat.model)
    expect(yield* llm.calls).toBe(0)
  }),
)

unix("/merge claude binds a new session with a pre-assigned id in the session directory", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "ok" }]])
    const chat = yield* session()

    const result = yield* merge(chat.id, "claude")
    const binding = (yield* (yield* MergeBinding.Service).active(chat.id))?.binding

    expect(binding?.status).toBe("starting")
    expect(ClaudeSessions.isID(binding?.externalSessionID ?? "")).toBe(true)
    expect(binding?.cwd).toBe(directory)
    expect(result.parts[0]?.origin?.role).toBe("notice")
    yield* send(chat.id, "hi")
    const start = FakeClaude.starts(yield* fake.log)[0]
    expect(start.cwd).toBe(directory)
    expect(FakeClaude.flag(start.argv, "--session-id")).toBe(binding?.externalSessionID)
    expect(FakeClaude.flag(start.argv, "--permission-mode")).toBe("default")
  }),
)

unix("--dir runs the child in that directory and a missing directory is rejected", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "ok" }]])
    const chat = yield* session()
    const other = path.join(directory, "nested", "pkg")
    yield* Effect.promise(() => fs.mkdir(other, { recursive: true }))

    expect(failure(yield* merge(chat.id, "claude --dir ./missing").pipe(Effect.exit))).toContain("is not a directory")
    yield* merge(chat.id, "claude --dir nested/pkg")
    yield* send(chat.id, "hi")

    expect((yield* (yield* MergeBinding.Service).active(chat.id))?.binding.cwd).toBe(other)
    expect(FakeClaude.starts(yield* fake.log)[0].cwd).toBe(other)
  }),
)

unix("--resume attaches an existing Claude session and refuses unknown or already-merged ones", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "resumed" }]])
    const id = "1b2c3d4e-0000-4000-8000-000000000001"
    yield* transcript(fake.config, directory, id)
    const first = yield* session()
    const second = yield* session()

    expect(failure(yield* merge(first.id, "claude --resume not-a-uuid").pipe(Effect.exit))).toContain(
      "No claude session",
    )
    expect(
      failure(yield* merge(first.id, "claude --resume 1b2c3d4e-0000-4000-8000-0000000000ff").pipe(Effect.exit)),
    ).toContain("No claude session")

    yield* merge(first.id, `claude --resume ${id} --dir ${directory}`)
    expect((yield* (yield* MergeBinding.Service).active(first.id))?.binding.status).toBe("live")
    expect(failure(yield* merge(second.id, `claude --resume ${id}`).pipe(Effect.exit))).toContain(
      "already merged into another OpenCode session",
    )

    yield* send(first.id, "continue")
    expect(FakeClaude.flag(FakeClaude.starts(yield* fake.log)[0].argv, "--resume")).toBe(id)
  }),
)

unix("passthrough flags reach the child in order and are reapplied on every turn", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "one" }], [{ text: "two" }]])
    const chat = yield* session()

    yield* merge(chat.id, `claude -- --model haiku --add-dir /tmp --append-system-prompt "be brief"`)
    yield* send(chat.id, "first")
    yield* send(chat.id, "second")

    const runs = FakeClaude.starts(yield* fake.log)
    expect(runs).toHaveLength(2)
    for (const run of runs)
      expect(run.argv.slice(-6)).toEqual([
        "--model",
        "haiku",
        "--add-dir",
        "/tmp",
        "--append-system-prompt",
        "be brief",
      ])
    expect(runs[0].argv).toContain("--session-id")
    expect(runs[1].argv).toContain("--resume")
  }),
)

unix("rejected passthrough flags and bad options fail without binding", () =>
  Effect.gen(function* () {
    yield* configure()
    yield* FakeClaude.install([[{ text: "ok" }]])
    const chat = yield* session()
    const bindings = yield* MergeBinding.Service

    for (const args of [
      "claude -- --dangerously-skip-permissions",
      "claude -- --permission-mode bypassPermissions",
      "claude -- --output-format text",
      "claude -- --resume 1b2c3d4e-0000-4000-8000-000000000001",
      "claude -- prompt-text",
      "claude --model haiku",
      "codex",
    ])
      expect(Exit.isFailure(yield* merge(chat.id, args).pipe(Effect.exit))).toBe(true)

    expect(yield* bindings.latest(chat.id)).toBeUndefined()
  }),
)

unix("--list shows Claude sessions for the directory without binding", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "ok" }]])
    const id = "1b2c3d4e-0000-4000-8000-000000000002"
    yield* transcript(fake.config, directory, id)
    yield* Effect.promise(() => fs.writeFile(path.join(fake.config, ".credentials.json"), "{}"))
    const chat = yield* session()

    const result = yield* merge(chat.id, `claude --list --dir ${directory}`)
    const text = result.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")

    expect(text).toContain(id)
    expect(text).toContain("Earlier work")
    expect(text).toContain("(main)")
    expect(yield* (yield* MergeBinding.Service).latest(chat.id)).toBeUndefined()
  }),
)

unix("a second bind fails until detach; status and detach report the binding", () =>
  Effect.gen(function* () {
    yield* configure()
    yield* FakeClaude.install([[{ text: "ok" }]])
    const chat = yield* session()
    const text = (result: { parts: ReadonlyArray<{ type: string; text?: string }> }) =>
      result.parts.map((part) => part.text ?? "").join("\n")

    expect(text(yield* merge(chat.id, "status"))).toContain("not merged")
    expect(text(yield* merge(chat.id, "detach"))).toContain("nothing to detach")

    yield* merge(chat.id, "claude -- --model haiku")
    expect(failure(yield* merge(chat.id, "claude").pipe(Effect.exit))).toContain("already merged")
    const status = text(yield* merge(chat.id, "status"))
    expect(status).toContain("merged: claude ·")
    expect(status).toContain("transport: cli")
    expect(status).toContain("process: not running")
    expect(status).toContain("args: --model haiku")

    expect(text(yield* merge(chat.id, "detach"))).toContain("Detached from claude session")
    expect((yield* (yield* MergeBinding.Service).latest(chat.id))?.status).toBe("detached")
    yield* merge(chat.id, "claude")
    expect((yield* (yield* MergeBinding.Service).active(chat.id))?.binding.status).toBe("starting")
  }),
)
