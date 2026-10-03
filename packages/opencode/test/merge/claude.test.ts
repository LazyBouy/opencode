import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { MergeAdapter } from "../../src/merge/adapter/adapter"
import { ClaudeEvents } from "../../src/merge/adapter/claude/events"
import { ClaudeProtocol } from "../../src/merge/adapter/claude/protocol"
import { ClaudeSessions } from "../../src/merge/adapter/claude/sessions"
import { ClaudeTools } from "../../src/merge/adapter/claude/tools"
import { MergeSummary } from "../../src/merge/summary"
import { testEffect } from "../lib/effect"

// Fixtures are scrubbed captures of Claude Code 2.1.123 (see script/merge-claude-spike.ts).
const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "merge", "claude")

const replay = async (name: string) => {
  const lines = (await fs.readFile(path.join(FIXTURES, `${name}.ndjson`), "utf8")).split("\n").filter(Boolean)
  const mapper = ClaudeEvents.mapper()
  const decoded = lines.map(ClaudeProtocol.decode)
  return { lines, decoded, events: decoded.flatMap((line) => (line ? mapper(line) : [])) }
}

const text = (events: MergeAdapter.Event[], kind: "text-delta" | "reasoning-delta") =>
  events.flatMap((event) => (event.type === kind ? [event.text] : [])).join("")

describe("Claude stream-json protocol", () => {
  test("every protocol line in every capture decodes", async () => {
    for (const file of await fs.readdir(FIXTURES)) {
      const { lines, decoded } = await replay(file.replace(".ndjson", ""))
      const known = lines.filter((line) =>
        /"type":"(system","subtype":"init|stream_event|assistant|user|result|control_request)"/.test(line),
      )
      expect(decoded.filter(Boolean).length).toBeGreaterThanOrEqual(known.length)
    }
  })

  test("a text turn yields the session id, streamed reasoning and text once, then done", async () => {
    const { events } = await replay("01-new")
    expect(events[0]).toMatchObject({ type: "session", externalSessionID: "{{session_id}}", mode: "default" })
    expect(text(events, "text-delta")).toBe("pineapple")
    expect(text(events, "reasoning-delta").length).toBeGreaterThan(0)
    expect(events.filter((event) => event.type === "text-start")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: "done", isError: false, interrupted: false, result: "pineapple" })
  })

  test("a resumed Bash turn yields the call, the permission request with its tool id, and the result", async () => {
    const { events } = await replay("02-resume-bash-allow")
    const tools = events.filter((event) => event.type === "tool")
    const ask = events.find((event) => event.type === "permission-request")
    expect(tools[0]).toMatchObject({ name: "Bash", status: "running", input: { command: "touch spike-allow.txt" } })
    expect(ask).toMatchObject({ tool: "Bash", toolCallID: tools[0]?.id, input: { command: "touch spike-allow.txt" } })
    expect(tools[1]).toMatchObject({ id: tools[0]?.id, status: "completed", output: "(Bash completed with no output)" })
    expect(text(events, "text-delta")).toContain("pineapple")
  })

  test("a denied tool is an error result; deny with interrupt ends the turn as interrupted", async () => {
    const denied = await replay("03-bash-deny")
    expect(denied.events.find((event) => event.type === "tool" && event.status !== "running")).toMatchObject({
      status: "error",
      output: "denied by spike",
    })
    expect(denied.events.at(-1)).toMatchObject({ type: "done", interrupted: false, denials: [{ tool: "Bash" }] })

    const interrupted = await replay("03-bash-interrupt")
    expect(interrupted.events.at(-1)).toMatchObject({ type: "done", isError: true, interrupted: true })
  })

  test("acceptEdits runs file tools without permission requests", async () => {
    const { events } = await replay("05-tools-acceptedits")
    const names = events.flatMap((event) => (event.type === "tool" && event.status === "running" ? [event.name] : []))
    expect(names).toEqual(expect.arrayContaining(["Write", "Read", "Edit"]))
    expect(events.some((event) => event.type === "permission-request")).toBe(false)
    expect(events.filter((event) => event.type === "tool" && event.status === "completed").length).toBe(names.length)
  })

  test("plan mode asks to exit plan mode before acting", async () => {
    const { events } = await replay("04-plan")
    expect(events[0]).toMatchObject({ type: "session", mode: "plan" })
    expect(events.flatMap((event) => (event.type === "permission-request" ? [event.tool] : []))).toEqual([
      "ExitPlanMode",
      "Bash",
    ])
  })

  test("an interrupt mid-stream and an unknown resume id both end the turn", async () => {
    expect((await replay("06-interrupt-mid")).events.at(-1)).toMatchObject({ type: "done", interrupted: true })
    expect((await replay("08-resume-unknown")).events.at(-1)).toMatchObject({
      type: "done",
      isError: true,
      errors: [expect.stringContaining("No conversation found")],
    })
  })

  test("protocol writers produce what Claude reads", () => {
    expect(JSON.parse(ClaudeProtocol.userMessage([{ type: "text", text: "hi" }]))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      parent_tool_use_id: null,
    })
    expect(
      JSON.parse(ClaudeProtocol.controlResponse("r1", { behavior: "deny", message: "no", interrupt: true })),
    ).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "r1",
        response: { behavior: "deny", message: "no", interrupt: true },
      },
    })
  })
})

describe("Claude tool mapping", () => {
  const cwd = "/work/repo"

  test("tools map onto OpenCode's renderers with camelCase inputs", () => {
    expect(ClaudeTools.describe("Bash", { command: "ls", description: "list" }, cwd)).toEqual({
      tool: "bash",
      input: { command: "ls", description: "list" },
    })
    expect(ClaudeTools.describe("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, cwd)).toEqual({
      tool: "edit",
      input: { filePath: "/work/repo/src/a.ts", oldString: "a", newString: "b", replaceAll: undefined },
    })
    expect(ClaudeTools.describe("Read", { file_path: "/etc/x" }, cwd)).toEqual({
      tool: "read",
      input: { filePath: "/etc/x" },
    })
    expect(ClaudeTools.describe("mcp__thing__do", { a: 1 }, cwd)).toEqual({ tool: "mcp__thing__do", input: { a: 1 } })
  })

  test("permissions use OpenCode names, relative patterns and Bash arity prefixes", () => {
    expect(ClaudeTools.permission("Bash", { command: "git status --short" }, cwd)).toMatchObject({
      permission: "bash",
      patterns: ["git status --short"],
      always: ["git status *"],
      readOnly: false,
    })
    expect(ClaudeTools.permission("Write", { file_path: "/work/repo/src/a.ts" }, cwd)).toMatchObject({
      permission: "edit",
      patterns: ["src/a.ts"],
      readOnly: false,
    })
    expect(ClaudeTools.permission("Read", { file_path: "src/a.ts" }, cwd)).toMatchObject({
      permission: "read",
      readOnly: true,
    })
    expect(ClaudeTools.permission("ExitPlanMode", { plan: "x" }, cwd)).toMatchObject({
      permission: "plan_exit",
      readOnly: false,
    })
  })
})

describe("merge summary", () => {
  test("lists files and commands, includes the external id, and never includes tool output", () => {
    const summary = MergeSummary.collector()
    summary.observe({ type: "tool", id: "1", name: "Bash", input: { command: "npm test\n--watch" }, status: "running" })
    summary.observe({ type: "tool", id: "1", name: "", output: "SECRET-OUTPUT", status: "completed" })
    summary.observe({ type: "tool", id: "2", name: "Write", input: { file_path: "/w/src/a.ts" }, status: "running" })
    summary.observe({ type: "text-start", id: "t" })
    summary.observe({ type: "text-delta", id: "t", text: "All green." })
    summary.deny("Edit", "plan mode")
    const rendered = summary.render({ adapter: "claude", externalSessionID: "abc-123", cwd: "/w", files: ["src/b.ts"] })
    expect(rendered.text).toBe(
      [
        "[Merged claude session abc-123 · cwd /w]",
        "Files changed: src/a.ts, src/b.ts",
        "Commands run:\n- npm test …",
        "Denied: Edit (plan mode)",
        "Result: All green.",
      ].join("\n"),
    )
    expect(rendered.text).not.toContain("SECRET-OUTPUT")
  })

  test("is capped", () => {
    const summary = MergeSummary.collector()
    summary.observe({ type: "text-start", id: "t" })
    summary.observe({ type: "text-delta", id: "t", text: "x".repeat(10_000) })
    expect(
      summary.render({ adapter: "claude", externalSessionID: "id", cwd: "/w", files: [] }).text.length,
    ).toBeLessThanOrEqual(4000)
  })
})

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Claude session listing", () => {
  test("slug matches Claude's project directory naming", () => {
    expect(ClaudeSessions.slug("/tmp/a.b/c_d")).toBe("-tmp-a-b-c-d")
  })

  it.live("lists transcripts newest first and ignores everything else", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const config = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "claude-cfg-")))
      const cwd = "/work/very.long-" + "x".repeat(220)
      const dir = path.join(config, "projects", ClaudeSessions.slug(cwd).slice(0, 200) + "-abc123")
      const older = "1b2c3d4e-0000-4000-8000-000000000001"
      const newer = "1b2c3d4e-0000-4000-8000-000000000002"
      yield* files.writeWithDirs(
        path.join(dir, `${older}.jsonl`),
        JSON.stringify({ type: "user", message: { content: "old" } }) + "\n",
      )
      yield* Effect.promise(() => Bun.sleep(15))
      yield* files.writeWithDirs(
        path.join(dir, `${newer}.jsonl`),
        [
          JSON.stringify({ type: "ai-title", aiTitle: "New work" }),
          JSON.stringify({ type: "user", gitBranch: "dev", message: { content: [{ type: "text", text: "new" }] } }),
        ].join("\n"),
      )
      yield* files.writeWithDirs(path.join(dir, "notes.txt"), "ignore me")
      yield* files.writeWithDirs(path.join(config, ".credentials.json"), "{}")
      const env = { CLAUDE_CONFIG_DIR: config }

      const listed = yield* ClaudeSessions.list(files, cwd, env)
      expect(listed.map((item) => [item.id, item.title, item.preview, item.branch])).toEqual([
        [newer, "New work", "new", "dev"],
        [older, undefined, "old", undefined],
      ])
      expect(yield* ClaudeSessions.exists(files, cwd, newer, env)).toBe(true)
      expect(yield* ClaudeSessions.exists(files, cwd, "1b2c3d4e-0000-4000-8000-0000000000ff", env)).toBe(false)
      expect(yield* ClaudeSessions.exists(files, cwd, "../../.credentials", env)).toBe(false)
    }),
  )
})
