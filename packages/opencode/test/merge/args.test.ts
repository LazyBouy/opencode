import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { ClaudeArgs } from "../../src/merge/adapter/claude/args"
import { MergeCommand } from "../../src/merge/command"

const validate = (args: string[], parent: "plan" | "build") => Effect.runSyncExit(ClaudeArgs.validate(args, parent))

describe("ClaudeArgs.validate", () => {
  test.each([
    "-p",
    "--print",
    "--output-format",
    "--input-format",
    "--include-partial-messages",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "-r",
    "--resume",
    "-c",
    "--continue",
    "--session-id",
    "--fork-session",
    "--no-session-persistence",
    "--settings",
    "--setting-sources",
    "--sdk-url",
    "--remote",
    "--teleport",
    "--ide",
    "--json-schema",
  ])("rejects %s for every parent", (flag) => {
    expect(Exit.isFailure(validate([flag, "x"], "build"))).toBe(true)
    expect(Exit.isFailure(validate([`${flag}=x`], "plan"))).toBe(true)
  })

  test("rejects bypassPermissions in any position", () => {
    expect(Exit.isFailure(validate(["--permission-mode", "bypassPermissions"], "build"))).toBe(true)
    expect(
      Exit.isFailure(validate(["--model", "haiku", "--append-system-prompt", "use bypassPermissions"], "build")),
    ).toBe(true)
  })

  test("rejects a leading positional so prompts cannot be smuggled in", () => {
    expect(Exit.isFailure(validate(["hello", "--model", "haiku"], "build"))).toBe(true)
  })

  test("passes ordinary Claude flags through", () => {
    expect(
      Exit.isSuccess(validate(["--model", "haiku", "--add-dir", "a", "b", "--max-budget-usd", "0.5"], "plan")),
    ).toBe(true)
  })

  test.each(["default", "acceptEdits", "auto", "dontAsk", "plan"])(
    "build parent may choose --permission-mode %s",
    (mode) => {
      expect(Exit.isSuccess(validate(["--permission-mode", mode], "build"))).toBe(true)
      expect(Exit.isSuccess(validate([`--permission-mode=${mode}`], "build"))).toBe(true)
    },
  )

  test("plan parent may only choose plan, and never --allowedTools", () => {
    expect(Exit.isSuccess(validate(["--permission-mode", "plan"], "plan"))).toBe(true)
    expect(Exit.isFailure(validate(["--permission-mode", "auto"], "plan"))).toBe(true)
    expect(Exit.isFailure(validate(["--permission-mode", "acceptEdits"], "plan"))).toBe(true)
    expect(Exit.isFailure(validate(["--allowedTools", "Bash"], "plan"))).toBe(true)
    expect(Exit.isSuccess(validate(["--allowedTools", "Bash"], "build"))).toBe(true)
  })

  test("rejects unknown permission modes", () => {
    expect(Exit.isFailure(validate(["--permission-mode", "yolo"], "build"))).toBe(true)
    expect(Exit.isFailure(validate(["--permission-mode"], "build"))).toBe(true)
  })
})

describe("ClaudeArgs.resolveMode", () => {
  test("plan parent always runs the child in plan mode", () => {
    expect(ClaudeArgs.resolveMode(["--permission-mode", "auto"], "plan")).toBe("plan")
    expect(ClaudeArgs.resolveMode([], "plan")).toBe("plan")
  })

  test("build parent uses the last passthrough mode or default", () => {
    expect(ClaudeArgs.resolveMode([], "build")).toBe("default")
    expect(ClaudeArgs.resolveMode(["--permission-mode", "acceptEdits"], "build")).toBe("acceptEdits")
    expect(ClaudeArgs.resolveMode(["--permission-mode=auto", "--permission-mode", "dontAsk"], "build")).toBe("dontAsk")
  })
})

describe("ClaudeArgs.forSpawn", () => {
  test("drops the user's --permission-mode because the adapter sets it", () => {
    expect(ClaudeArgs.forSpawn(["--model", "haiku", "--permission-mode", "auto", "--verbose-x"], "build")).toEqual([
      "--model",
      "haiku",
      "--verbose-x",
    ])
    expect(ClaudeArgs.forSpawn(["--permission-mode=auto", "--model", "haiku"], "build")).toEqual(["--model", "haiku"])
  })

  test("a plan parent also drops every --allowedTools value", () => {
    expect(ClaudeArgs.forSpawn(["--allowedTools", "Bash", "Edit", "--model", "haiku"], "plan")).toEqual([
      "--model",
      "haiku",
    ])
    expect(ClaudeArgs.forSpawn(["--allowedTools", "Bash", "Edit"], "build")).toEqual(["--allowedTools", "Bash", "Edit"])
  })
})

describe("MergeCommand.parse", () => {
  test("status and detach", () => {
    expect(MergeCommand.parse("")).toEqual({ kind: "status" })
    expect(MergeCommand.parse("status")).toEqual({ kind: "status" })
    expect(MergeCommand.parse("detach")).toEqual({ kind: "detach" })
    expect(MergeCommand.parse("detach now").kind).toBe("invalid")
  })

  test("adapter with options and passthrough flags", () => {
    expect(MergeCommand.parse("claude")).toEqual({ kind: "bind", adapter: "claude", list: false, args: [] })
    expect(MergeCommand.parse("claude --dir ../other --resume abc")).toEqual({
      kind: "bind",
      adapter: "claude",
      list: false,
      dir: "../other",
      resume: "abc",
      args: [],
    })
    expect(MergeCommand.parse("claude --dir=/tmp/x --list")).toEqual({
      kind: "bind",
      adapter: "claude",
      list: true,
      dir: "/tmp/x",
      args: [],
    })
    expect(MergeCommand.parse(`claude -- --model haiku --append-system-prompt "be very brief"`)).toEqual({
      kind: "bind",
      adapter: "claude",
      list: false,
      args: ["--model", "haiku", "--append-system-prompt", "be very brief"],
    })
    expect(MergeCommand.parse("claude --")).toEqual({ kind: "bind", adapter: "claude", list: false, args: [] })
  })

  test("rejects unknown options before -- and missing values", () => {
    expect(MergeCommand.parse("claude --model haiku").kind).toBe("invalid")
    expect(MergeCommand.parse("claude junk").kind).toBe("invalid")
    expect(MergeCommand.parse("claude --dir").kind).toBe("invalid")
    expect(MergeCommand.parse("claude --resume --dir x").kind).toBe("invalid")
    expect(MergeCommand.parse("--dir x").kind).toBe("invalid")
  })
})
