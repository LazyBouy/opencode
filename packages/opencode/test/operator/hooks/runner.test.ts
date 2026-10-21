import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OperatorHookRunner as Runner } from "../../../src/operator/hooks/runner"
import { tmpdir } from "../../fixture/fixture"

// SPEC-0022 §7.2, §7.4: a script starts by its extension with no shell; the deadline kills its whole process
// group; it runs with the server's environment minus its credentials; a graceful stop kills running hooks
// and starts none.

// Files share one process: an earlier file's server may have stopped hooks on its way down.
beforeEach(() => Runner.resume())
afterEach(() => Runner.resume())

const script = async (dir: string, name: string, text: string, mode = 0o644) => {
  const file = path.join(dir, name)
  await fs.writeFile(file, text, { mode })
  return file
}
const run = (command: string, extra: Partial<Runner.Input> = {}) =>
  Runner.run({ command, args: [], cwd: path.dirname(command), env: {}, stdin: "{}", timeoutMs: 5000, ...extra })

describe("running a hook", () => {
  test("stdin in, stdout and stderr out; the working folder and the environment are the hook's", async () => {
    await using dir = await tmpdir()
    const file = await script(
      dir.path,
      "echo.sh",
      `read -r input; echo "$input"; echo "$PWD|$OPENCODE_HOOK_NAME|\${OPENCODE_SERVER_PASSWORD:-none}" >&2`,
    )
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    const result = await run(file, { stdin: '{"event":"tool.before"}', env: { OPENCODE_HOOK_NAME: "echo" } })
    delete process.env.OPENCODE_SERVER_PASSWORD
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stopped: false, stdout: '{"event":"tool.before"}\n' })
    expect(result.stderr.trim()).toBe(`${await fs.realpath(dir.path)}|echo|none`)
  })

  test("the deadline kills the hook and everything it started", async () => {
    await using dir = await tmpdir()
    const file = await script(dir.path, "hang.sh", "sleep 60 &\nsleep 60\n")
    const started = Date.now()
    const result = await run(file, { stdin: "", timeoutMs: 400 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    // Nothing of its group is left (the background sleep included).
    const ps = Bun.spawnSync(["ps", "-eo", "pgid,args"]).stdout.toString()
    expect(ps.split("\n").filter((line) => line.includes("sleep 60"))).toEqual([])
  })

  test("what the script leaves running goes when it exits", async () => {
    await using dir = await tmpdir()
    const file = await script(dir.path, "leave.sh", "sleep 61 &\necho done\n")
    const result = await run(file)
    expect(result).toMatchObject({ exitCode: 0, stdout: "done\n", timedOut: false })
    await Bun.sleep(100)
    expect(Bun.spawnSync(["ps", "-eo", "args"]).stdout.toString()).not.toContain("sleep 61")
  })

  test("by extension: sh, python3, bun; an executable directly; a non-zero exit is kept", async () => {
    await using dir = await tmpdir()
    const py = await script(dir.path, "a.py", "print('py')")
    const ts = await script(dir.path, "a.ts", "console.log('ts' as string)")
    const bin = await script(dir.path, "a", "#!/bin/sh\necho bin\nexit 3\n", 0o755)
    const plain = await script(dir.path, "b", "echo plain\n")
    expect((await run(py)).stdout).toBe("py\n")
    expect((await run(ts)).stdout).toBe("ts\n")
    expect(await run(bin)).toMatchObject({ stdout: "bin\n", exitCode: 3 })
    expect((await run(plain)).stdout).toBe("plain\n")
    expect(await Runner.argv("/x/y.sh", ["1"])).toEqual(["sh", "/x/y.sh", "1"])
  })

  test("a graceful stop kills running hooks and starts none", async () => {
    await using dir = await tmpdir()
    const file = await script(dir.path, "slow.sh", "sleep 30\n")
    const running = run(file, { timeoutMs: 20000 })
    await Bun.sleep(200)
    Runner.stopAll()
    expect(await running).toMatchObject({ stopped: true })
    expect(await run(file)).toMatchObject({ stopped: true, durationMs: 0 })
  })

  test("a script that can't start says so", async () => {
    const result = await run("/nowhere/at/all.sh")
    expect(result.exitCode).not.toBe(0)
  })
})
