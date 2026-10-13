import os from "os"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { OperatorPathRewrite } from "../../src/operator/path-rewrite"
import { OperatorProjectIds } from "../../src/operator/project-ids"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// A project's short id (specs/docs/issues/002): made once when the console records the project, unique on the
// server, and kept when the project moves to another namespace or its folder moves.

process.env.OPENCODE_WORKSPACE_ROOTS ??= os.tmpdir()

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const app = () => Server.Default().app
const json = { "content-type": "application/json" }
const call = (method: string, url: string, body?: object) =>
  app().request(url, { method, headers: json, ...(body ? { body: JSON.stringify(body) } : {}) })
type Project = { key: string; id: string; namespace: string }
const listed = async () => (await (await call("GET", "/operator/project-settings")).json()) as Project[]
const idOf = async (key: string) => (await listed()).find((item) => item.key === key)?.id

describe("project ids", () => {
  test("are 5 base-32 characters, never one already taken", () => {
    const taken = new Set(["aaaaa"])
    let calls = 0
    // The first draw is taken: another is drawn.
    const id = OperatorProjectIds.make(taken, () => (calls++ < OperatorProjectIds.LENGTH ? 10 / 32 : 0))
    expect(id).toBe("00000")
    expect(OperatorProjectIds.valid(id)).toBe(true)
    expect(OperatorProjectIds.valid("ABCDE")).toBe(false)
    expect(OperatorProjectIds.valid("abcd")).toBe(false)
  })

  test("are made once and unique, and survive a namespace move and a folder move", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir({ git: true })
    expect((await call("POST", "/operator/project-settings/register", { directory: a.path })).status).toBe(200)
    expect((await call("POST", "/operator/project-settings/register", { directory: b.path })).status).toBe(200)
    const first = await idOf(a.path)
    const second = await idOf(b.path)
    expect(OperatorProjectIds.valid(first)).toBe(true)
    expect(OperatorProjectIds.valid(second)).toBe(true)
    expect(first).not.toBe(second)
    // Read again: the same ids.
    expect(await idOf(a.path)).toBe(first)

    // Its settings saved again (as moving it to another namespace does): the id stays.
    expect((await call("PUT", "/operator/project-settings", { key: a.path, namespace: "opencode" })).status).toBe(200)
    expect(await idOf(a.path)).toBe(first)

    // Its folder moves (the stored paths are rewritten, layout-move.ts): the id goes with it.
    const moved = `${a.path}-moved`
    await fs.rename(a.path, moved)
    const undo = await OperatorPathRewrite.rewrite("m1", a.path, moved, [])
    await OperatorPathRewrite.finish(undo)
    expect(await idOf(moved)).toBe(first)
    await fs.rename(moved, a.path)
  })
})
