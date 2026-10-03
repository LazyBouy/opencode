// Live tests against the installed Claude Code CLI. They spend real (capped) usage with the
// developer's own Claude login and never read credentials. Opt in with:
//
//   OPENCODE_TEST_LIVE_CLAUDE=1 bun run test test/merge/claude-live.test.ts
//
// Each test runs in a temporary project and removes the Claude transcripts it created there.
import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Fiber, Schedule } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ClaudeCli } from "../../src/merge/adapter/claude/cli"
import { ClaudeSessions } from "../../src/merge/adapter/claude/sessions"
import { MergeAdapterRegistry } from "../../src/merge/adapter/registry"
import { MergeBinding } from "../../src/merge/binding"
import { Permission } from "../../src/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Env } from "../../src/env"
import { reloadInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { configure, it, merge, send, session } from "./harness"

const enabled = process.env.OPENCODE_TEST_LIVE_CLAUDE === "1" && Bun.which("claude") !== null
const live = enabled ? it.instance : it.instance.skip
const CAP = "-- --model haiku --max-budget-usd 0.50"
const TIMEOUT = 180_000

// Removes the Claude project directory for this test's temporary cwd when the test ends.
const cleanup = Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const files = yield* FSUtil.Service
  const env = yield* (yield* Env.Service).all()
  yield* Effect.addFinalizer(() =>
    ClaudeSessions.projectDirs(files, directory, env).pipe(
      Effect.flatMap((dirs) =>
        Effect.forEach(dirs, (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))),
      ),
      Effect.ignore,
    ),
  )
  return directory
})

const parts = (sessionID: Session.Info["id"]) =>
  Session.Service.use((sessions) => sessions.messages({ sessionID })).pipe(
    Effect.map((messages) => messages.filter((msg) => msg.info.role === "assistant").flatMap((msg) => msg.parts)),
  )

const projected = (items: ReadonlyArray<SessionV1.Part>) =>
  items
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.origin?.role === "projection")
    .map((part) => part.text)
    .join("\n")

const answer = (reply: PermissionV1.Reply) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const asked: PermissionV1.Request[] = []
    const fiber = yield* Effect.gen(function* () {
      for (const request of yield* permission.list()) {
        asked.push(request)
        yield* permission.reply({ requestID: request.id, reply }).pipe(Effect.ignore)
      }
    }).pipe(Effect.repeat(Schedule.spaced("50 millis")), Effect.forkChild)
    return { asked, stop: Fiber.interrupt(fiber) }
  })

live(
  "1. probe finds the installed CLI at a supported version",
  () =>
    Effect.gen(function* () {
      const env = yield* (yield* Env.Service).all()
      const claude = (yield* MergeAdapterRegistry.Service).get("claude")
      const found = yield* claude!.probe(env)
      expect(found.binary).toBe(Bun.which("claude")!)
      expect(found.version.split(".").map(Number)[0]).toBeGreaterThanOrEqual(
        Number(ClaudeCli.MIN_VERSION.split(".")[0]),
      )
    }),
  TIMEOUT,
)

live(
  "2-3. a new session streams, keeps Claude's id, and resumes after an instance reload",
  () =>
    Effect.gen(function* () {
      const directory = yield* cleanup
      const { llm } = yield* configure()
      const chat = yield* session()
      const fruit = ["kiwi", "mango", "papaya", "lychee", "guava"][Math.floor(Math.random() * 5)]
      yield* merge(chat.id, `claude ${CAP}`)
      yield* send(chat.id, `My favourite fruit is ${fruit}. Reply with exactly: noted`)

      const bindings = yield* MergeBinding.Service
      const id = (yield* bindings.active(chat.id))?.binding.externalSessionID
      expect(id).toBeDefined()
      expect(
        yield* ClaudeSessions.exists(yield* FSUtil.Service, directory, id!, yield* (yield* Env.Service).all()),
      ).toBe(true)
      expect(projected(yield* parts(chat.id)).toLowerCase()).toContain("noted")

      yield* reloadInstance({ directory })
      yield* send(chat.id, "What is my favourite fruit? Reply with only the fruit.")
      expect(projected(yield* parts(chat.id)).toLowerCase()).toContain(fruit)
      expect((yield* bindings.active(chat.id))?.binding.externalSessionID).toBe(id)
      expect(yield* llm.calls).toBe(0)
    }),
  TIMEOUT,
)

live(
  "4. a plan parent cannot run a shell command and is never asked",
  () =>
    Effect.gen(function* () {
      const directory = yield* cleanup
      yield* configure()
      const chat = yield* session()
      yield* merge(chat.id, `claude ${CAP}`, "plan")
      const auto = yield* answer("always")
      yield* send(chat.id, "Use the Bash tool to run exactly: touch live-plan.txt", "plan")
      yield* auto.stop
      expect(auto.asked.map((request) => request.permission)).not.toContain("bash")
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(directory, "live-plan.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  TIMEOUT,
)

live(
  "5. a build parent's approval runs the command; a rejection does not",
  () =>
    Effect.gen(function* () {
      const directory = yield* cleanup
      yield* configure()
      const chat = yield* session()
      yield* merge(chat.id, `claude ${CAP}`)

      const once = yield* answer("once")
      yield* send(chat.id, "Use the Bash tool to run exactly: touch live-allow.txt")
      yield* once.stop
      expect(once.asked.some((request) => request.permission === "bash")).toBe(true)
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(directory, "live-allow.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(true)

      const reject = yield* answer("reject")
      yield* send(chat.id, "Use the Bash tool to run exactly: touch live-reject.txt")
      yield* reject.stop
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(directory, "live-reject.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  TIMEOUT,
)

live(
  "6. --permission-mode acceptEdits writes a file without asking OpenCode",
  () =>
    Effect.gen(function* () {
      const directory = yield* cleanup
      yield* configure()
      const chat = yield* session()
      yield* merge(chat.id, `claude ${CAP} --permission-mode acceptEdits`)
      const auto = yield* answer("reject")
      yield* send(chat.id, "Use the Write tool to create live-edit.txt containing exactly: beta")
      yield* auto.stop
      expect(auto.asked.map((request) => request.permission)).not.toContain("edit")
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "live-edit.txt"), "utf8"))).toContain("beta")
    }),
  TIMEOUT,
)

live(
  "7. --permission-mode auto completes the turn and bridges any asks",
  () =>
    Effect.gen(function* () {
      yield* cleanup
      yield* configure()
      const chat = yield* session()
      yield* merge(chat.id, `claude ${CAP} --permission-mode auto`)
      const auto = yield* answer("once")
      yield* send(chat.id, "Reply with exactly: ready")
      yield* auto.stop
      expect(projected(yield* parts(chat.id)).toLowerCase()).toContain("ready")
    }),
  TIMEOUT,
)

live(
  "8. abort stops the claude process",
  () =>
    Effect.gen(function* () {
      yield* cleanup
      yield* configure()
      const chat = yield* session()
      yield* merge(chat.id, `claude ${CAP}`)
      const turn = yield* send(chat.id, "Count slowly from 1 to 300, one number per line.").pipe(Effect.forkChild)
      const bindings = yield* MergeBinding.Service
      const pid = yield* pollWithTimeout(
        bindings.active(chat.id).pipe(Effect.map((entry) => entry?.binding.process?.pid)),
        "claude never started",
        "60 seconds",
      )
      yield* (yield* SessionPrompt.Service).cancel(chat.id)
      yield* Fiber.await(turn)
      yield* pollWithTimeout(
        Effect.sync(() => {
          const running = Effect.runSync(
            Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(Effect.orElseSucceed(() => false)),
          )
          return running ? undefined : true
        }),
        "claude survived abort",
        "15 seconds",
      )
    }),
  TIMEOUT,
)

live(
  "9-10. --list shows the session, and after detach prompts no longer reach claude",
  () =>
    Effect.gen(function* () {
      const directory = yield* cleanup
      const { llm } = yield* configure()
      const chat = yield* session()
      yield* merge(chat.id, `claude ${CAP}`)
      yield* send(chat.id, "Reply with exactly: listed")
      const id = (yield* (yield* MergeBinding.Service).active(chat.id))?.binding.externalSessionID

      const listing = yield* merge(chat.id, `claude --list --dir ${directory}`)
      expect(listing.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(id!)

      yield* merge(chat.id, "detach")
      yield* llm.text("opencode again")
      yield* send(chat.id, "hello")
      expect(yield* llm.calls).toBe(1)
    }),
  TIMEOUT,
)
