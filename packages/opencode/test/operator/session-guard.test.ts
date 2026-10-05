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
const create = (directory: string, body: object = {}) =>
  app().request(`/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  })
const register = (body: { directory: string; git?: boolean; namespace?: string; from?: string; sessions?: boolean }) =>
  app().request("/operator/project-settings/register", { method: "POST", headers: json, body: JSON.stringify(body) })
const post = (url: string, body: object) =>
  app().request(url, { method: "POST", headers: json, body: JSON.stringify(body) })
const session = async (id: string) =>
  (await (await app().request(`/session/${id}`)).json()) as {
    id: string
    title: string
    directory: string
    time: { archived?: number }
  }
const listed = async (directory: string) =>
  (await (await app().request(`/session?directory=${encodeURIComponent(directory)}`)).json()) as {
    id: string
    title: string
  }[]
// Sessions made before the guard, in folders that are not projects.
const unguarded = async (directory: string, body: object = {}) => {
  process.env.OPENCODE_PROJECT_GUARD = "off"
  const made = (await (await create(directory, body)).json()) as { id: string }
  process.env.OPENCODE_PROJECT_GUARD = "on"
  return made
}

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
    expect(await registered.json()).toMatchObject({
      project: { key: tmp.path, namespace: "opencode", registered: true },
    })
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
    const session = await unguarded(tmp.path)
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

describe("copying a project", () => {
  test("copies its agents, tools and prompt settings; its sessions only when asked; the source stays as it was", async () => {
    await using source = await tmpdir()
    await using plain = await tmpdir()
    await using withSessions = await tmpdir()
    await fs.mkdir(path.join(source.path, ".opencode", "agents"), { recursive: true })
    await fs.writeFile(path.join(source.path, ".opencode", "agents", "docs.md"), "---\nmode: subagent\n---\nDocs.\n")
    expect((await register({ directory: source.path })).status).toBe(200)
    const original = (await (await create(source.path, { title: "Plan the docs" })).json()) as { id: string }

    const first = await register({ directory: plain.path, from: source.path })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      project: { key: plain.path, namespace: "opencode", registered: true },
      copied: { files: expect.arrayContaining([path.join(".opencode", "agents", "docs.md")]), items: [], sessions: 0 },
    })
    expect(await fs.readFile(path.join(plain.path, ".opencode", "agents", "docs.md"), "utf8")).toContain("Docs.")
    expect(await listed(plain.path)).toEqual([])

    const second = await register({ directory: withSessions.path, from: source.path, sessions: true })
    expect(((await second.json()) as { copied: { sessions: number } }).copied.sessions).toBe(1)
    const copies = await listed(withSessions.path)
    expect(copies.map((item) => item.title)).toEqual(["Plan the docs"])
    expect(copies[0]!.id).not.toBe(original.id)
    expect((await session(original.id)).directory).toBe(source.path)
    expect((await listed(source.path)).map((item) => item.id)).toEqual([original.id])
  })

  test("refuses a source that is not a project, and a folder that is part of one", async () => {
    await using source = await tmpdir()
    await using target = await tmpdir()
    await using repository = await tmpdir({ git: true })
    expect((await register({ directory: target.path, from: source.path })).status).toBe(400)
    expect((await register({ directory: path.join(repository.path, "docs") })).status).toBe(400)
    expect((await register({ directory: target.path })).status).toBe(200)
    expect((await register({ directory: path.join(target.path, "sub") })).status).toBe(400)
  })
})

describe("sessions of a folder that is not a project", () => {
  test("move into a project, with their subagent sessions", async () => {
    await using folder = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const parent = await unguarded(folder.path, { title: "Old work" })
    const child = await unguarded(folder.path, { parentID: parent.id, title: "Helper" })

    expect(
      (await post("/operator/project-settings/folder/move", { directory: folder.path, project: folder.path })).status,
    ).toBe(400)
    const moved = await post("/operator/project-settings/folder/move", {
      directory: folder.path,
      project: repository.path,
    })
    expect(await moved.json()).toEqual({ moved: 2, archived: 0 })
    expect((await session(parent.id)).directory).toBe(repository.path)
    expect((await session(child.id)).directory).toBe(repository.path)
    expect((await listed(repository.path)).map((item) => item.title)).toContain("Old work")
  })

  test("or are archived", async () => {
    await using folder = await tmpdir()
    const old = await unguarded(folder.path)
    const archived = await post("/operator/project-settings/folder/archive", { directory: folder.path })
    expect(await archived.json()).toEqual({ archived: 1 })
    expect((await session(old.id)).time.archived).toBeNumber()
    expect((await post("/operator/project-settings/folder/archive", { directory: folder.path })).status).toBe(200)
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
