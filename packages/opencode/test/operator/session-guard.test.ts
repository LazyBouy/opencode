import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OperatorProjects } from "../../src/operator/projects"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// The fork's session guard runs before upstream's routes: a session starts only in a project (a git
// repository, or a registered folder outside git, with their subfolders). Upstream's test suite runs
// with it off, so these tests turn it on.
beforeEach(() => {
  process.env.OPENCODE_PROJECT_GUARD = "on"
})
afterEach(async () => {
  delete process.env.OPENCODE_PROJECT_GUARD
  await disposeAllInstances()
  await resetDatabase()
})

const app = () => Server.Default().app
const json = { "content-type": "application/json" }
const create = (directory: string) =>
  app().request(`/session?directory=${encodeURIComponent(directory)}`, { method: "POST", headers: json, body: "{}" })
const register = (body: { directory: string; git?: boolean; namespace?: string }) =>
  app().request("/operator/project-settings/register", { method: "POST", headers: json, body: JSON.stringify(body) })

describe("session guard", () => {
  test("refuses a session in a folder outside git that is not a project, and says why", async () => {
    await using tmp = await tmpdir()
    const response = await create(tmp.path)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { name: string; data: { directory: string; message: string } }
    expect(body.name).toBe("OperatorNotAProjectError")
    expect(body.data.directory).toBe(tmp.path)
    expect(body.data.message).toContain("is not part of a project")
  })

  test("allows a git repository and its subfolders", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "src"))
    expect((await create(tmp.path)).status).toBe(200)
    expect((await create(path.join(tmp.path, "src"))).status).toBe(200)
  })

  test("a registered folder outside git, and its subfolders, are projects", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "notes"))
    expect((await create(tmp.path)).status).toBe(409)

    const registered = await register({ directory: tmp.path })
    expect(registered.status).toBe(200)
    expect(await registered.json()).toMatchObject({ key: tmp.path, namespace: "opencode", registered: true })
    expect((await create(tmp.path)).status).toBe(200)
    expect((await create(path.join(tmp.path, "notes"))).status).toBe(200)

    const resolved = await app().request(
      `/operator/project-settings/resolve?directory=${encodeURIComponent(path.join(tmp.path, "notes"))}`,
    )
    expect(await resolved.json()).toMatchObject({ project: { key: tmp.path, git: false } })
  })

  test("v2 POST /api/session reads the folder from the body", async () => {
    await using outside = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const start = (directory: string) =>
      app().request("/api/session", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ location: { directory } }),
      })
    expect((await start(outside.path)).status).toBe(409)
    expect((await start(repository.path)).status).toBe(200)
  })

  test("forking a session that ran in a folder that is not a project is refused", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_PROJECT_GUARD = "off"
    const session = (await (await create(tmp.path)).json()) as { id: string }
    process.env.OPENCODE_PROJECT_GUARD = "on"
    const fork = await app().request(`/session/${session.id}/fork`, { method: "POST", headers: json, body: "{}" })
    expect(fork.status).toBe(409)
  })

  test("is off under upstream's test suite unless turned on", () => {
    expect(OperatorProjects.guarded({ OPENCODE_TEST_HOME: "/tmp/test" })).toBe(false)
    expect(OperatorProjects.guarded({ OPENCODE_TEST_HOME: "/tmp/test", OPENCODE_PROJECT_GUARD: "on" })).toBe(true)
    expect(OperatorProjects.guarded({})).toBe(true)
    expect(OperatorProjects.guarded({ OPENCODE_PROJECT_GUARD: "off" })).toBe(false)
  })
})

describe("project of a folder", () => {
  test("the nearest registered folder above a folder outside git", () => {
    expect(OperatorProjects.registeredRoot("/work/docs/sub/deep", ["/work", "/work/docs"])).toBe("/work/docs")
    expect(OperatorProjects.registeredRoot("/work/docs", ["/work/docs"])).toBe("/work/docs")
    expect(OperatorProjects.registeredRoot("/work/docsy", ["/work/docs"])).toBeUndefined()
  })

  test("the project key of an instance outside git is its registered folder", async () => {
    await using tmp = await tmpdir()
    const sub = path.join(tmp.path, "sub")
    expect(await OperatorProjects.keyOf({ directory: sub, worktree: "/" })).toBe(sub)
    expect((await register({ directory: tmp.path })).status).toBe(200)
    expect(await OperatorProjects.keyOf({ directory: sub, worktree: "/" })).toBe(tmp.path)
    expect(await OperatorProjects.keyOf({ directory: sub, worktree: "/repo" })).toBe("/repo")
  })
})
