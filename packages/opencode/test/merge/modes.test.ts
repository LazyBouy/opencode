import { expect } from "bun:test"
import { Effect, Exit, Fiber, Schedule } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { MergeBinding } from "../../src/merge/binding"
import { Permission } from "../../src/permission"
import { FakeClaude, type Step } from "../lib/fake-claude"
import { configure, merge, send, session, unix } from "./harness"

const bash = (command: string): Step => ({
  tool: "Bash",
  input: { command, description: command },
  output: "ok",
  ask: true,
})

// Stands in for a client: answers every pending permission request with `reply`, the way the web
// app's auto-accept toggle (or a person clicking) would, and records what was asked.
const responder = (reply: PermissionV1.Reply) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const asked: PermissionV1.Request[] = []
    const fiber = yield* Effect.gen(function* () {
      for (const request of yield* permission.list()) {
        asked.push(request)
        yield* permission.reply({ requestID: request.id, reply }).pipe(Effect.ignore)
      }
    }).pipe(Effect.repeat(Schedule.spaced("20 millis")), Effect.forkChild)
    return { asked, stop: Fiber.interrupt(fiber) }
  })

unix("acceptance 7: a plan parent runs the child in plan mode and can never approve a shell action", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([[bash("touch nope"), { text: "planned" }]])
    const chat = yield* session()
    yield* merge(chat.id, "claude", "plan")
    const auto = yield* responder("always")

    yield* send(chat.id, "run it", "plan")
    yield* auto.stop

    const log = yield* fake.log
    expect(FakeClaude.flag(FakeClaude.starts(log)[0].argv, "--permission-mode")).toBe("plan")
    expect(FakeClaude.decisions(log).map((entry) => entry.decision.behavior)).toEqual(["deny"])
    expect(auto.asked).toEqual([])
  }),
)

unix("plan parent: ExitPlanMode is denied, read-only asks are still bridged", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([
      [
        { tool: "Read", input: { file_path: "/etc/hostname" }, output: "host", ask: true },
        { tool: "ExitPlanMode", input: { plan: "do it" }, ask: true },
        { text: "ok" },
      ],
    ])
    const chat = yield* session()
    yield* merge(chat.id, "claude", "plan")
    const auto = yield* responder("once")

    yield* send(chat.id, "look", "plan")
    yield* auto.stop

    expect(auto.asked.map((request) => request.permission)).toEqual(["read"])
    expect(FakeClaude.decisions(yield* fake.log).map((entry) => entry.decision.behavior)).toEqual(["allow", "deny"])
  }),
)

unix("plan parent rejects Claude's own permission modes and --allowedTools", () =>
  Effect.gen(function* () {
    yield* configure()
    yield* FakeClaude.install([[{ text: "ok" }]])
    const chat = yield* session()
    for (const args of [
      "claude -- --permission-mode auto",
      "claude -- --permission-mode acceptEdits",
      "claude -- --permission-mode=dontAsk",
      "claude -- --allowedTools Bash",
    ])
      expect(Exit.isFailure(yield* merge(chat.id, args, "plan").pipe(Effect.exit))).toBe(true)
    expect(yield* (yield* MergeBinding.Service).latest(chat.id)).toBeUndefined()
    yield* merge(chat.id, "claude -- --permission-mode plan", "plan")
  }),
)

unix("build parent: Claude's asks go through OpenCode's permission flow; reject interrupts the child", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([
      [bash("git status"), { text: "first" }],
      [bash("rm -rf build"), { text: "never" }],
    ])
    const chat = yield* session()
    yield* merge(chat.id, "claude")

    const once = yield* responder("once")
    yield* send(chat.id, "status please")
    yield* once.stop
    expect(once.asked.map((request) => [request.permission, request.patterns, request.tool?.callID])).toEqual([
      ["bash", ["git status"], expect.stringMatching(/^toolu_fake_/)],
    ])

    const reject = yield* responder("reject")
    yield* send(chat.id, "clean up")
    yield* reject.stop

    const log = yield* fake.log
    expect(FakeClaude.flag(FakeClaude.starts(log)[0].argv, "--permission-mode")).toBe("default")
    expect(FakeClaude.decisions(log).map((entry) => [entry.decision.behavior, entry.decision.interrupt])).toEqual([
      ["allow", undefined],
      ["deny", true],
    ])
  }),
)

for (const mode of ["auto", "acceptEdits", "dontAsk", "plan"])
  unix(`build parent may run the child with --permission-mode ${mode}; remaining asks are bridged`, () =>
    Effect.gen(function* () {
      yield* configure()
      const fake = yield* FakeClaude.install([[bash("ls"), { text: "ok" }]])
      const chat = yield* session()
      yield* merge(chat.id, `claude -- --permission-mode ${mode}`)
      const auto = yield* responder("once")

      yield* send(chat.id, "go")
      yield* auto.stop

      const start = FakeClaude.starts(yield* fake.log)[0]
      expect(FakeClaude.flag(start.argv, "--permission-mode")).toBe(mode)
      expect(start.argv.filter((token) => token === "--permission-mode")).toHaveLength(1)
      expect(auto.asked.map((request) => request.permission)).toEqual(["bash"])
    }),
  )

unix("switching the parent from build to plan forces plan mode on the next child turn", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([[{ text: "built" }], [bash("touch x"), { text: "planned" }]])
    const chat = yield* session()
    yield* merge(chat.id, "claude -- --permission-mode auto --allowedTools Bash")
    yield* send(chat.id, "build it")
    const auto = yield* responder("always")
    yield* send(chat.id, "now plan", "plan")
    yield* auto.stop

    const runs = FakeClaude.starts(yield* fake.log)
    expect(FakeClaude.flag(runs[0].argv, "--permission-mode")).toBe("auto")
    expect(runs[0].argv).toContain("--allowedTools")
    expect(FakeClaude.flag(runs[1].argv, "--permission-mode")).toBe("plan")
    expect(runs[1].argv).not.toContain("--allowedTools")
    expect(auto.asked).toEqual([])
    expect(FakeClaude.decisions(yield* fake.log).map((entry) => entry.decision.behavior)).toEqual(["deny"])
  }),
)

unix("OpenCode auto-accept answers bridged asks and its 'always' rule covers later matching asks", () =>
  Effect.gen(function* () {
    yield* configure()
    const fake = yield* FakeClaude.install([[bash("git status"), bash("git status --short"), { text: "ok" }]])
    const chat = yield* session()
    yield* merge(chat.id, "claude")
    const auto = yield* responder("always")

    yield* send(chat.id, "status twice")
    yield* auto.stop

    expect(auto.asked).toHaveLength(1)
    expect(auto.asked[0].always).toEqual(["git status *"])
    expect(FakeClaude.decisions(yield* fake.log).map((entry) => entry.decision.behavior)).toEqual(["allow", "allow"])
  }),
)
