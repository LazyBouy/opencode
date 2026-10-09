import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { OperatorPathRewrite } from "@/operator/path-rewrite"
import { OperatorQueueStore } from "@/operator/queue-store"
import { tmpdir } from "../fixture/fixture"

// Every store that keeps a folder is rewritten when the folder moves (global_and_opencode_namespaces_spec.md
// §11.3 step 4): seed each, move, and nothing old is left; roll back, and everything is as it was.

const previous = { config: Global.Path.config, data: Global.Path.data }
let work: Awaited<ReturnType<typeof tmpdir>>
const OLD = "/work/old/site"
const NEW = "/work/acme/site"

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const json = (value: unknown) => JSON.stringify(value, null, 2)

beforeEach(async () => {
  work = await tmpdir()
  ;(Global.Path as { config: string }).config = path.join(work.path, "config")
  ;(Global.Path as { data: string }).data = path.join(work.path, "data")
  OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(work.path, "queue.sqlite")))
})

afterEach(async () => {
  ;(Global.Path as { config: string }).config = previous.config
  ;(Global.Path as { data: string }).data = previous.data
  OperatorQueueStore.use(undefined)
  await work[Symbol.asyncDispose]()
})

// One of each store, each holding the old folder (and something it must keep).
async function seed() {
  const config = path.join(Global.Path.config, "namespaces")
  const data = path.join(Global.Path.data, "operator")
  await write(
    path.join(config, "projects.json"),
    json({ [OLD]: { namespace: "acme" }, "/work/other": { namespace: "opencode" } }),
  )
  await write(path.join(config, "agents.json"), json({ [OLD]: { build: { profile: "spec" } } }))
  await write(
    path.join(config, "acme", "namespace.json"),
    json({ id: "acme", folder: "/work/old", defaultProject: OLD }),
  )
  await write(path.join(config, "project-records.json"), json({ [OLD]: { description: "" } }))
  await write(path.join(config, "project-permissions.json"), json({ [OLD]: { deleted: [], locks: [] } }))
  await write(
    path.join(config, "project-config-copies.json"),
    json({ [OLD]: { namespace: "acme", copiedAt: 1, namespaceHash: "h", file: `${OLD}/.opencode/opencode.jsonc` } }),
  )
  await write(path.join(data, "agent-sessions.json"), json({ [`${OLD}\nbuild`]: { main: "ses_1" } }))
  await write(path.join(data, "agent-permission-locks.json"), json({ [OLD]: { build: { locks: [], inherit: "own" } } }))
  await write(
    path.join(data, "permission-decisions", "ses_1.jsonl"),
    [
      JSON.stringify({
        requestID: "per_1",
        directory: `${OLD}/src`,
        project: OLD,
        rule: { where: `${OLD}/.opencode/agents/a.md` },
      }),
      JSON.stringify({ requestID: "per_2", directory: "/work/other", project: "/work/other" }),
      "",
    ].join("\n"),
  )
  await write(
    path.join(data, "calls", "ses_1", "calls.jsonl"),
    JSON.stringify({ projectKey: OLD, directory: OLD }) + "\n",
  )
  await write(path.join(data, "calls", "latest.json"), json({ [`${OLD}\nbuild`]: "call_1" }))
  await write(
    path.join(data, "trash", "t1", "entry.json"),
    json({ id: "t1", project: OLD, files: [{ path: `${OLD}/.opencode/skills/a`, stored: "files/0-a" }] }),
  )
  OperatorQueueStore.store().enqueue({
    project: OLD,
    agent: "build",
    target: "main",
    text: "hello",
    priority: "normal",
    sender: { kind: "user" },
  } as never)
  const snapshot = path.join(Global.Path.data, "snapshot", "prj_1", Hash.fast(OLD))
  await write(path.join(snapshot, "objects", "info", "alternates"), `${OLD}/.git/objects\n`)
  return { snapshot }
}

// Every store's text, for comparing before and after.
async function texts() {
  const all: Record<string, string> = {}
  for (const { file } of await OperatorPathRewrite.files()) all[file] = await fs.readFile(file, "utf8").catch(() => "")
  return all
}

describe("rewriting stored paths", () => {
  test("every store in the inventory is rewritten; other folders, and folders that only start alike, are kept", async () => {
    const { snapshot } = await seed()
    // A folder whose name only starts with the old one's isn't inside it.
    await write(
      path.join(Global.Path.config, "namespaces", "project-records.json"),
      json({ [OLD]: {}, [`${OLD}-two`]: {} }),
    )
    const before = await texts()
    expect(Object.values(before).some((text) => text.includes(OLD))).toBe(true)

    const undo = await OperatorPathRewrite.rewrite("m1", OLD, NEW, [{ id: "prj_1", worktree: OLD }])
    const after = await texts()
    for (const [file, text] of Object.entries(after)) {
      const kept = text.split(`${OLD}-two`).join("")
      expect({ file, old: kept.includes(OLD) }).toEqual({ file, old: false })
    }
    expect(after[path.join(Global.Path.config, "namespaces", "project-records.json")]).toContain(`${OLD}-two`)
    expect(after[path.join(Global.Path.config, "namespaces", "projects.json")]).toContain("/work/other")
    expect(OperatorQueueStore.store().list({ project: NEW })).toHaveLength(1)
    expect(OperatorQueueStore.store().list({ project: OLD })).toHaveLength(0)
    const moved = path.join(Global.Path.data, "snapshot", "prj_1", Hash.fast(NEW))
    expect(await fs.readFile(path.join(moved, "objects", "info", "alternates"), "utf8")).toBe(`${NEW}/.git/objects\n`)
    expect(await Bun.file(path.join(snapshot, "objects", "info", "alternates")).exists()).toBe(false)
    // Each rewritten file's old text is kept until the move finishes.
    expect(undo.backups.length).toBe(Object.keys(after).filter((file) => after[file] !== before[file]).length)

    await OperatorPathRewrite.rollback(undo, OLD, NEW)
    expect(await texts()).toEqual(before)
    expect(OperatorQueueStore.store().list({ project: OLD })).toHaveLength(1)
    expect(await fs.readFile(path.join(snapshot, "objects", "info", "alternates"), "utf8")).toBe(
      `${OLD}/.git/objects\n`,
    )
  })

  test("finishing drops the backups", async () => {
    await seed()
    const undo = await OperatorPathRewrite.rewrite("m2", OLD, NEW, [])
    expect(undo.backups.length).toBeGreaterThan(0)
    await OperatorPathRewrite.finish(undo)
    for (const { backup } of undo.backups) expect(await Bun.file(backup).exists()).toBe(false)
  })

  test("swap: the folder itself, inside it, and `<project>\\n<agent>` keys", () => {
    expect(OperatorPathRewrite.swap(OLD, OLD, NEW)).toBe(NEW)
    expect(OperatorPathRewrite.swap(`${OLD}/src`, OLD, NEW)).toBe(`${NEW}/src`)
    expect(OperatorPathRewrite.swap(`${OLD}\nbuild`, OLD, NEW)).toBe(`${NEW}\nbuild`)
    expect(OperatorPathRewrite.swap(`${OLD}-two`, OLD, NEW)).toBeUndefined()
  })
})
