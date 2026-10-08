import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Namespace and project permission levels (tool_prompt_from_permission.md §3, §9): a namespace's lines
// live in its folder's config file, a project's in its own; deletions and locks in the fork's stores. The
// tool list follows every level.

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const keep = { projects: "" }

afterEach(async () => {
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
  await fs.rm(path.join(store(), "project-permissions.json"), { force: true })
  await disposeAllInstances()
  await resetDatabase()
})

// Acme, with its folder, and the projects in it.
const acme = async (folder: string, projects: string[]) => {
  keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  await write(
    path.join(store(), "acme", "namespace.json"),
    JSON.stringify({ id: "acme", name: "Acme", purpose: "", folder, createdAt: 1, updatedAt: 1 }),
  )
  await fs.mkdir(path.join(folder, ".opencode"), { recursive: true })
  const current = keep.projects ? (JSON.parse(keep.projects) as Record<string, unknown>) : {}
  await write(
    path.join(store(), "projects.json"),
    JSON.stringify({ ...current, ...Object.fromEntries(projects.map((key) => [key, { namespace: "acme" }])) }),
  )
}

type Row = { permission: string; pattern: string; action: string; level?: string; locked?: string }
type View = { rows: Row[]; own: Row[]; marks: { deleted: Row[]; locks: Row[] }; file?: string; deleted: Row[] }
type Prompt = { list: Array<{ name: string }>; notSent: Array<{ name: string; reason: string }> }

const request = async (method: string, route: string, directory: string, body?: unknown) => {
  const join = route.includes("?") ? "&" : "?"
  const response = await app().request(`${route}${join}directory=${encodeURIComponent(directory)}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  })
  return { status: response.status, body: (await response.json()) as unknown }
}
const level = (directory: string, name: "namespace" | "project", body?: unknown) =>
  request(body ? "PUT" : "GET", `/operator/permission/level/${name}`, directory, body)
const tools = async (directory: string, agent = "build") =>
  ((await request("GET", `/operator/agent/${agent}/tool-prompt`, directory)).body as Prompt).list.map(
    (item) => item.name,
  )
const rule = (permission: string, pattern: string, action: string) => ({ permission, pattern, action })
const key = (permission: string, pattern: string) => ({ permission, pattern })

describe("namespace and project levels", () => {
  test("a namespace starting from `* * deny`: a project adds `read * allow`, and only what it allows is listed", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])

    // A blank slate: OpenCode's own lines go (outside the OpenCode namespace they can), then `* * deny`.
    // (`* * deny` alone leaves OpenCode's more specific lines deciding, such as `read * allow`.)
    const opencode = ((await level(project.path, "namespace")).body as View).rows.filter(
      (row) => row.level === "opencode",
    )
    expect(opencode.some((row) => row.permission === "read" && row.pattern === "*")).toBe(true)
    const saved = await level(project.path, "namespace", {
      lines: [rule("*", "*", "deny")],
      deleted: opencode.map((row) => key(row.permission, row.pattern)),
      locks: [],
    })
    expect(saved.status).toBe(200)
    expect((saved.body as View).file).toBe(path.join(folder.path, ".opencode", "opencode.jsonc"))
    expect(JSON.parse(await fs.readFile(path.join(folder.path, ".opencode", "opencode.jsonc"), "utf8"))).toMatchObject({
      permission: { "*": "deny" },
    })
    expect(await tools(project.path)).not.toContain("read")

    await level(project.path, "project", { lines: [rule("read", "*", "allow")], deleted: [], locks: [] })
    const list = await tools(project.path)
    expect(list).toContain("read")
    for (const name of ["bash", "edit", "webfetch", "glob", "grep", "task", "question"])
      expect(list).not.toContain(name)
    const view = (await level(project.path, "project")).body as View
    expect(view.rows.find((row) => row.permission === "*" && row.pattern === "*")).toMatchObject({
      action: "deny",
      level: "namespace",
    })
    expect(view.own).toEqual([rule("read", "*", "allow")])
  })

  test("a project deletes an inherited namespace line, and the next line decides", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await level(project.path, "namespace", { lines: [rule("webfetch", "*", "deny")], deleted: [], locks: [] })
    expect(await tools(project.path)).not.toContain("webfetch")
    const saved = await level(project.path, "project", { lines: [], deleted: [key("webfetch", "*")], locks: [] })
    expect(saved.status).toBe(200)
    expect((saved.body as View).deleted).toEqual([
      expect.objectContaining({ permission: "webfetch", level: "namespace" }),
    ])
    // OpenCode's `* * allow` decides again.
    expect(await tools(project.path)).toContain("webfetch")
  })

  test("a locked namespace line binds the project, the agent and the session", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await level(project.path, "namespace", {
      lines: [rule("webfetch", "*", "deny")],
      deleted: [],
      locks: [key("webfetch", "*")],
    })
    // The project can't change it, delete it, or allow inside it.
    for (const body of [
      { lines: [rule("webfetch", "*", "allow")], deleted: [], locks: [] },
      { lines: [], deleted: [key("webfetch", "*")], locks: [] },
      { lines: [rule("webfetch", "https://example.com/*", "allow")], deleted: [], locks: [] },
    ]) {
      const refused = await level(project.path, "project", body)
      expect(refused.status).toBe(409)
      expect(JSON.stringify(refused.body)).toContain("lock")
    }
    // The agent can't either.
    const agent = await request("PUT", "/operator/agent/build/permissions", project.path, {
      scope: "project",
      rules: [rule("webfetch", "*", "allow")],
    })
    expect(agent.status).toBe(400)
    expect(JSON.stringify(agent.body)).toContain("locked")
    // Every agent loses webfetch.
    expect(await tools(project.path)).not.toContain("webfetch")
    expect(await tools(project.path, "plan")).not.toContain("webfetch")

    // A session: `* * allow` is kept (it applies outside the lock) and webfetch stays out; a line inside
    // the lock, or deleting it, is refused.
    const session = (await request("POST", "/session", project.path)).body as { id: string }
    const route = `/operator/session/${session.id}/permissions`
    expect((await request("PUT", route, project.path, { rules: [rule("*", "*", "allow")] })).status).toBe(200)
    const prompt = (await request("GET", `/operator/agent/build/tool-prompt?session=${session.id}`, project.path))
      .body as Prompt
    expect(prompt.list.map((item) => item.name)).not.toContain("webfetch")
    expect(prompt.list.map((item) => item.name)).toContain("bash")
    expect(
      (await request("PUT", route, project.path, { rules: [rule("webfetch", "https://a.com/*", "allow")] })).status,
    ).toBe(400)
    expect((await request("PUT", route, project.path, { rules: [], deleted: [key("webfetch", "*")] })).status).toBe(400)
  })

  test("OpenCode's own lines can't be deleted in the OpenCode namespace; elsewhere they can", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await using plain = await tmpdir({ git: true })
    const refused = await level(plain.path, "namespace", { lines: [], deleted: [key("*", "*")], locks: [] })
    expect([400, 409]).toContain(refused.status)
    await acme(folder.path, [project.path])
    const saved = await level(project.path, "namespace", {
      lines: [rule("read", "*", "allow")],
      deleted: [key("*", "*")],
      locks: [],
    })
    expect(saved.status).toBe(200)
    // No `* *` line: whatever no line allows is denied.
    const list = await tools(project.path)
    expect(list).toContain("read")
    expect(list).not.toContain("bash")
  })
})
