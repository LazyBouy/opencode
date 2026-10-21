export * as OperatorHookRunner from "./runner"

import { spawn } from "node:child_process"
import { constants } from "node:fs"
import fs from "fs/promises"
import path from "path"

// Starting a hook's script (SPEC-0022 §7.2, §7.4). By its extension: `.sh` with sh, `.py` with python3,
// `.js`/`.mjs`/`.ts` with the server's own bun; anything else directly when it's executable, else with sh.
// No shell parses the command. Each run is its own process group, so the deadline kills everything it
// started: at the deadline, and when the script exits (what it left running goes too). On a graceful stop
// every running hook is killed and none starts. A process that leaves the group (`setsid`) escapes both, as
// does every hook when the server is killed outright (FORK.md).

/** What a run keeps of stdout to read the answer from; more is a failure. */
export const STDOUT_LIMIT = 1024 * 1024
/** What it keeps of stderr (the run log keeps less). */
export const STDERR_LIMIT = 64 * 1024

export type Input = {
  command: string
  args: ReadonlyArray<string>
  cwd: string
  /** Added to the environment (§7.2). */
  env: Record<string, string>
  stdin: string
  timeoutMs: number
}

export type Result = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  /** Killed at its deadline. */
  timedOut: boolean
  /** Killed (or never started) because the server is stopping. */
  stopped: boolean
  /** It couldn't start, or wrote more than the server keeps. */
  error?: string
}

const BUN = process.execPath

/** The program and arguments a script starts with. */
export async function argv(command: string, args: ReadonlyArray<string>): Promise<string[]> {
  const ext = path.extname(command).toLowerCase()
  if (ext === ".sh") return ["sh", command, ...args]
  if (ext === ".py") return ["python3", command, ...args]
  if (ext === ".js" || ext === ".mjs" || ext === ".ts") return [BUN, command, ...args]
  const executable = await fs.access(command, constants.X_OK).then(
    () => true,
    () => false,
  )
  return executable ? [command, ...args] : ["sh", command, ...args]
}

/** The server's environment without its credentials (as `/merge` strips them), plus the hook's variables. */
export function environment(extra: Record<string, string>) {
  const env = { ...process.env }
  delete env.OPENCODE_SERVER_PASSWORD
  delete env.OPENCODE_SERVER_USERNAME
  return { ...env, ...extra }
}

const running = new Map<number, () => void>()
let stopping = false

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // already gone
  }
}

/** The graceful stop: kills every running hook (recorded "stopped by the server") and starts none after. */
export function stopAll() {
  stopping = true
  for (const stop of running.values()) stop()
}

/** Tests only: start hooks again after `stopAll`. */
export function resume() {
  stopping = false
}

export const runningCount = () => running.size

export async function run(input: Input): Promise<Result> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  if (stopping)
    return { exitCode: null, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, stopped: true }
  const [program, ...rest] = await argv(input.command, input.args)
  return new Promise<Result>((resolve) => {
    let stdout = ""
    let stderr = ""
    let error: string | undefined
    let timedOut = false
    let stopped = false
    let done = false
    let exited: { code: number | null; signal: string | null } | undefined
    const child = spawn(program!, rest, {
      cwd: input.cwd,
      env: environment(input.env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const pid = child.pid
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (pid) running.delete(pid)
      resolve({
        exitCode: exited?.code ?? null,
        signal: exited?.signal ?? null,
        stdout,
        stderr,
        durationMs: elapsed(),
        timedOut,
        stopped,
        ...(error ? { error } : {}),
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (pid) killGroup(pid)
    }, input.timeoutMs)
    if (pid)
      running.set(pid, () => {
        stopped = true
        killGroup(pid)
      })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > STDOUT_LIMIT) {
        error ??= `it wrote more than ${STDOUT_LIMIT / 1024 / 1024} MB to stdout`
        if (pid) killGroup(pid)
        return
      }
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length)
    })
    child.on("error", (cause) => {
      error ??= `it couldn't start: ${cause.message}`
      exited ??= { code: null, signal: null }
      finish()
    })
    child.on("exit", (code, signal) => {
      exited = { code, signal }
      // What the script left running in its group goes with it, so its pipes close.
      if (pid) killGroup(pid)
    })
    child.on("close", finish)
    child.stdin.on("error", () => undefined)
    child.stdin.end(input.stdin)
  })
}
