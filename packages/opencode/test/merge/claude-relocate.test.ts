import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ClaudeSessions } from "../../src/merge/adapter/claude/sessions"
import { testEffect } from "../lib/effect"

// A moved folder takes Claude Code's records of its sessions along (operator/layout-move.ts): the
// `projects/<folder name>` folders of sessions that ran in it or below it are renamed, and their
// transcripts' `cwd` rewritten, so `claude --resume` finds them in the new place.

const it = testEffect(LayerNode.compile(FSUtil.node))

const FROM = "/work/old/site"
const TO = "/work/acme/site"
const ID = "1b2c3d4e-0000-4000-8000-000000000001"
const SUB = "1b2c3d4e-0000-4000-8000-000000000002"

const line = (value: Record<string, unknown>) => JSON.stringify(value)
const transcript = (cwd: string) =>
  [
    line({ type: "user", cwd, sessionId: ID, message: { content: `look at ${cwd}/README.md` } }),
    line({ type: "assistant", cwd, message: { content: [{ type: "tool_use", input: { cwd } }] } }),
    "",
  ].join("\n")

// Every file under a folder, with its text.
async function tree(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else found[path.relative(root, file)] = await fs.readFile(file, "utf8")
    }
  }
  await walk(root)
  return found
}

describe("Claude Code's folder names", () => {
  test("short folders are their slug; long ones are cut and suffixed with Claude's hash", () => {
    expect(ClaudeSessions.folderName("/tmp/a.b/c_d")).toBe("-tmp-a-b-c-d")
    const long = "/work/acme/" + "deep-folder/".repeat(20) + "site"
    expect(ClaudeSessions.folderName(long)).toBe("-work-acme" + "-deep-folder".repeat(15) + "-deep-fold-scta0d")
  })
})

describe("relocating Claude Code's sessions", () => {
  it.live("the folder's and its subfolders' sessions follow; a sibling sharing the name's start stays", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const config = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "claude-cfg-")))
      const projects = path.join(config, "projects")
      const env = { CLAUDE_CONFIG_DIR: config }
      const at = (cwd: string) => path.join(projects, ClaudeSessions.folderName(cwd))
      yield* files.writeWithDirs(path.join(at(FROM), `${ID}.jsonl`), transcript(FROM))
      yield* files.writeWithDirs(
        path.join(at(FROM), ID, "subagents", "agent-1.jsonl"),
        line({ type: "user", cwd: FROM, isSidechain: true }) + "\n",
      )
      yield* files.writeWithDirs(path.join(at(FROM), "memory", "MEMORY.md"), "- [a](a.md)\n")
      yield* files.writeWithDirs(
        path.join(at(`${FROM}/packages/app`), `${SUB}.jsonl`),
        transcript(`${FROM}/packages/app`),
      )
      // `/work/old/site-b` has a name that starts like `/work/old/site`'s: it isn't inside it.
      yield* files.writeWithDirs(path.join(at(`${FROM}-b`), `${ID}.jsonl`), transcript(`${FROM}-b`))
      const before = yield* Effect.promise(() => tree(projects))

      const relocator = ClaudeSessions.relocator(files)
      expect(yield* relocator.check(FROM, env)).toEqual({ root: projects, folders: 2 })
      const done = yield* relocator.move(FROM, TO, env)
      expect(done.renames).toEqual([
        { from: at(FROM), to: at(TO) },
        { from: at(`${FROM}/packages/app`), to: at(`${TO}/packages/app`) },
      ])
      expect(yield* ClaudeSessions.exists(files, TO, ID, env)).toBe(true)
      expect(yield* ClaudeSessions.exists(files, `${TO}/packages/app`, SUB, env)).toBe(true)
      expect(yield* ClaudeSessions.exists(files, FROM, ID, env)).toBe(false)
      expect(yield* ClaudeSessions.exists(files, `${FROM}-b`, ID, env)).toBe(true)

      // Each line's own `cwd` follows; what the messages say is history and stays.
      const lines = (yield* files.readFileString(path.join(at(TO), `${ID}.jsonl`)))
        .split("\n")
        .filter(Boolean)
        .map((text) => JSON.parse(text) as { cwd: string; message: { content: unknown } })
      expect(lines.map((item) => item.cwd)).toEqual([TO, TO])
      expect(lines[0]!.message.content).toBe(`look at ${FROM}/README.md`)
      expect(lines[1]!.message.content).toEqual([{ type: "tool_use", input: { cwd: FROM } }])
      const subagent = JSON.parse(yield* files.readFileString(path.join(at(TO), ID, "subagents", "agent-1.jsonl")))
      expect(subagent.cwd).toBe(TO)
      expect(yield* files.readFileString(path.join(at(TO), "memory", "MEMORY.md"))).toBe("- [a](a.md)\n")

      // Put back: everything as it was, byte for byte.
      yield* relocator.restore(done, FROM, TO)
      expect(yield* Effect.promise(() => tree(projects))).toEqual(before)
    }),
  )

  it.live("an entry already in the new place: what isn't there joins it; long names keep Claude's hash", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const config = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "claude-cfg-")))
      const projects = path.join(config, "projects")
      const env = { CLAUDE_CONFIG_DIR: config }
      const from = "/work/old/" + "deep-folder/".repeat(20) + "site"
      const to = "/work/acme/" + "deep-folder/".repeat(20) + "site"
      const at = (cwd: string) => path.join(projects, ClaudeSessions.folderName(cwd))
      yield* files.writeWithDirs(path.join(at(from), `${ID}.jsonl`), transcript(from))
      yield* files.writeWithDirs(path.join(at(from), "memory", "MEMORY.md"), "old\n")
      yield* files.writeWithDirs(path.join(at(to), `${SUB}.jsonl`), transcript(to))
      yield* files.writeWithDirs(path.join(at(to), "memory", "MEMORY.md"), "new\n")
      const before = yield* Effect.promise(() => tree(projects))

      const relocator = ClaudeSessions.relocator(files)
      const done = yield* relocator.move(from, to, env)
      expect(done.renames).toEqual([{ from: path.join(at(from), `${ID}.jsonl`), to: path.join(at(to), `${ID}.jsonl`) }])
      expect(yield* ClaudeSessions.exists(files, to, ID, env)).toBe(true)
      expect(yield* ClaudeSessions.exists(files, to, SUB, env)).toBe(true)
      // The new place's own memory is kept; the old one stays where it was.
      expect(yield* files.readFileString(path.join(at(to), "memory", "MEMORY.md"))).toBe("new\n")
      expect(yield* files.readFileString(path.join(at(from), "memory", "MEMORY.md"))).toBe("old\n")

      yield* relocator.restore(done, from, to)
      expect(yield* Effect.promise(() => tree(projects))).toEqual(before)
    }),
  )

  it.live("nothing recorded for the folder: nothing to move, and no Claude folder needed", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const config = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "claude-cfg-")))
      const relocator = ClaudeSessions.relocator(files)
      const env = { CLAUDE_CONFIG_DIR: config }
      expect(yield* relocator.check(FROM, env)).toEqual({ root: path.join(config, "projects"), folders: 0 })
      expect(yield* relocator.move(FROM, TO, env)).toEqual({ adapter: "claude", renames: [], rewritten: [] })
    }),
  )
})
