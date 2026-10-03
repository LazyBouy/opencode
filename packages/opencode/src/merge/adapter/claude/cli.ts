import { Cause, Effect, Queue, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { MergeAdapter } from "../adapter"
import { ClaudeArgs } from "./args"
import { ClaudeEvents } from "./events"
import { ClaudeProtocol } from "./protocol"
import { ClaudeSessions } from "./sessions"
import { ClaudeTools } from "./tools"

// The stdio permission channel (`--permission-prompt-tool stdio`) is not listed in `claude --help`;
// it is the mechanism the Claude Agent SDK uses. Verified against Claude Code 2.1.123.
export const MIN_VERSION = "2.1.0"

const STDERR_TAIL = 16 * 1024

// Variables that must not leak into the child: OpenCode's own server credentials, and Claude
// Code's nested-session marker, which makes `claude` refuse to start inside another session.
const STRIPPED_ENV = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "CLAUDECODE"]

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FSUtil.Service

  const childEnv = (env: MergeAdapter.Env) =>
    Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !STRIPPED_ENV.includes(key)))

  const probe = Effect.fn("ClaudeCli.probe")(function* (env: MergeAdapter.Env) {
    const binary = which("claude", env)
    if (!binary)
      return yield* new MergeAdapter.Unavailable({
        adapter: "claude",
        message: "Claude Code (`claude`) was not found on PATH. Install it from https://claude.com/claude-code",
      })
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(binary, ["--version"], {
            env: childEnv(env),
            extendEnv: false,
            stdin: "ignore",
            forceKillAfter: "1 second",
          }),
        )
        return yield* Stream.mkString(Stream.decodeText(handle.stdout))
      }),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.mapError(
        () => new MergeAdapter.Unavailable({ adapter: "claude", message: `\`${binary} --version\` did not succeed` }),
      ),
    )
    const version = output.match(/\d+\.\d+\.\d+/)?.[0]
    if (!version || compareVersions(version, MIN_VERSION) < 0)
      return yield* new MergeAdapter.Unavailable({
        adapter: "claude",
        message: `Claude Code ${MIN_VERSION} or newer is required (found ${version ?? "unknown version"})`,
      })
    return { binary, version }
  })

  const start = Effect.fn("ClaudeCli.start")(function* (input: MergeAdapter.StartInput) {
    const binary = which("claude", input.env)
    if (!binary) return yield* new MergeAdapter.StartFailed({ message: "Claude Code (`claude`) was not found on PATH" })
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const encoder = new TextEncoder()
    const write = (text: string) => Queue.offer(stdin, encoder.encode(text)).pipe(Effect.asVoid)
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      input.mode,
      input.session.mode === "new" ? "--session-id" : "--resume",
      input.session.id,
      ...ClaudeArgs.forSpawn(input.args, input.mode === "plan" ? "plan" : "build"),
    ]
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(binary, args, {
          cwd: input.cwd,
          env: childEnv(input.env),
          extendEnv: false,
          stdin: Stream.fromQueue(stdin),
          detached: true,
          forceKillAfter: "3 seconds",
        }),
      )
      .pipe(Effect.mapError((error) => new MergeAdapter.StartFailed({ message: error.message })))

    let finished = false
    let interrupts = 0
    let stderr = ""
    yield* Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
      Effect.sync(() => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL)
      }),
    ).pipe(Effect.ignore, Effect.forkScoped)

    // Ask Claude to stop cleanly before the spawner signals the process group, so its transcript
    // is flushed and the session stays resumable.
    yield* Effect.addFinalizer(() =>
      finished
        ? Effect.void
        : write(ClaudeProtocol.interruptRequest("opencode-close")).pipe(
            Effect.andThen(handle.exitCode.pipe(Effect.timeout("1 second"))),
            Effect.ignore,
          ),
    )

    yield* write(ClaudeProtocol.userMessage(input.prompt.map((item) => ({ type: "text" as const, text: item.text }))))

    const mapper = ClaudeEvents.mapper()
    const events = Stream.decodeText(handle.stdout).pipe(
      Stream.splitLines,
      Stream.map((line): MergeAdapter.Event[] => {
        const decoded = ClaudeProtocol.decode(line)
        return decoded ? mapper(decoded) : []
      }),
      Stream.flattenIterable,
      Stream.tap((event) =>
        event.type === "done"
          ? Effect.sync(() => {
              finished = true
            }).pipe(Effect.andThen(Queue.end(stdin)))
          : Effect.void,
      ),
      Stream.concat(
        Stream.unwrap(
          Effect.gen(function* () {
            const code = yield* handle.exitCode.pipe(Effect.orElseSucceed(() => -1))
            if (finished) return Stream.empty
            finished = true
            const event: MergeAdapter.Event = {
              type: "error",
              message: `claude exited with code ${code} before finishing the turn: ${stderr.trim() || "no output"}`,
            }
            return Stream.make(event)
          }),
        ),
      ),
      Stream.mapError((error) => new MergeAdapter.StartFailed({ message: error.message })),
    )

    return {
      pid: handle.pid,
      events,
      respond: (requestID, decision) =>
        write(
          ClaudeProtocol.controlResponse(
            requestID,
            decision.behavior === "allow"
              ? { behavior: "allow", updatedInput: decision.input }
              : { behavior: "deny", message: decision.message, interrupt: decision.interrupt },
          ),
        ),
      interrupt: Effect.suspend(() => write(ClaudeProtocol.interruptRequest(`opencode-interrupt-${++interrupts}`))),
    } satisfies MergeAdapter.Harness
  })

  return {
    id: "claude",
    transports: ["cli"],
    probe,
    start,
    validateArgs: ClaudeArgs.validate,
    resolveMode: ClaudeArgs.resolveMode,
    hasSession: (cwd, id, env) => ClaudeSessions.exists(fs, cwd, id, env),
    listSessions: (cwd, env) => ClaudeSessions.list(fs, cwd, env),
    describeTool: ClaudeTools.describe,
    permissionFor: ClaudeTools.permission,
  } satisfies MergeAdapter.Adapter
})

function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  return left.map((value, index) => value - (right[index] ?? 0)).find((value) => value !== 0) ?? 0
}

export * as ClaudeCli from "./cli"
