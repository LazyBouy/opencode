import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Every delete in the operator pages goes to Trash, from where it can be restored or deleted for good.
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const app = () => Server.Default().app
const json = { "content-type": "application/json" }
const call = (method: string, url: string, body?: object) =>
  app().request(url, { method, headers: json, ...(body ? { body: JSON.stringify(body) } : {}) })
const read = async <T>(response: Response) => (await response.json()) as T
type Entry = { id: string; kind: string; name: string; files: { path: string }[] }
const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

describe("Trash", () => {
  test("a project goes to Trash with its folder, settings and sessions; it can be restored, then deleted for good", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "notes")
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, "todo.md"), "Ship it.\n")
    expect((await call("POST", "/operator/project-settings/register", { directory: folder })).status).toBe(200)
    const session = await read<{ id: string }>(
      await app().request(`/session?directory=${encodeURIComponent(folder)}`, {
        method: "POST",
        headers: json,
        body: "{}",
      }),
    )

    const trashed = await call("POST", "/operator/trash/project", { key: folder })
    expect(trashed.status).toBe(200)
    const entry = await read<Entry>(trashed)
    expect(entry).toMatchObject({ kind: "project", name: "notes" })
    expect(await exists(folder)).toBe(false)
    const listed = await read<Entry[]>(await call("GET", "/operator/trash"))
    expect(listed.map((item) => item.id)).toContain(entry.id)
    const projects = await read<{ key: string }[]>(await call("GET", "/operator/project-settings"))
    expect(projects.map((item) => item.key)).not.toContain(folder)
    const archived = await read<{ time: { archived?: number } }>(await app().request(`/session/${session.id}`))
    expect(archived.time.archived).toBeNumber()

    expect((await call("POST", `/operator/trash/${entry.id}/restore`)).status).toBe(200)
    expect(await fs.readFile(path.join(folder, "todo.md"), "utf8")).toBe("Ship it.\n")
    expect(
      (await read<{ key: string }[]>(await call("GET", "/operator/project-settings"))).map((item) => item.key),
    ).toContain(folder)
    expect(
      (await read<{ time: { archived?: number } }>(await app().request(`/session/${session.id}`))).time.archived,
    ).toBeUndefined()

    const again = await read<Entry>(await call("POST", "/operator/trash/project", { key: folder }))
    expect((await call("DELETE", `/operator/trash/${again.id}`)).status).toBe(200)
    expect((await app().request(`/session/${session.id}`)).status).toBe(404)
    expect((await read<Entry[]>(await call("GET", "/operator/trash"))).map((item) => item.id)).not.toContain(again.id)
  })

  test("the folder OpenCode runs from cannot go to Trash", async () => {
    const response = await call("POST", "/operator/trash/project", { key: process.cwd() })
    expect(response.status).toBe(400)
    expect((await read<{ data: { message: string } }>(response)).data.message).toContain("OpenCode runs from")
  })

  test("a layer goes to Trash and comes back", async () => {
    const created = await read<{ id: string }>(
      await call("POST", "/operator/namespaces/opencode/layers", {
        name: "Reviewer",
        type: "role",
        section: "role",
        text: "You review.",
      }),
    )
    expect((await call("DELETE", `/operator/namespaces/opencode/layers/${created.id}`)).status).toBe(200)
    const entry = (await read<Entry[]>(await call("GET", "/operator/trash"))).find((item) => item.kind === "layer")
    expect(entry).toMatchObject({ kind: "layer", name: "Reviewer" })
    const layers = async () =>
      (await read<{ layers: { id: string }[] }>(await call("GET", "/operator/namespaces/opencode/catalog"))).layers
    expect((await layers()).map((item) => item.id)).not.toContain(created.id)
    await call("POST", `/operator/trash/${entry!.id}/restore`)
    expect((await layers()).map((item) => item.id)).toContain(created.id)
  })

  test("a project's memory file and MCP server go to Trash, and come back", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "AGENTS.md"), "Use Bun.\n")
    await fs.writeFile(
      path.join(tmp.path, "opencode.json"),
      JSON.stringify({ mcp: { docs: { type: "remote", url: "https://example.com/mcp", enabled: false } } }),
    )
    const item = (kind: string, name: string) =>
      call("POST", `/operator/trash/item?directory=${encodeURIComponent(tmp.path)}`, { kind, name })

    const memory = await item("memory", path.join(tmp.path, "AGENTS.md"))
    expect(memory.status).toBe(200)
    expect(await exists(path.join(tmp.path, "AGENTS.md"))).toBe(false)
    await call("POST", `/operator/trash/${(await read<Entry>(memory)).id}/restore`)
    expect(await fs.readFile(path.join(tmp.path, "AGENTS.md"), "utf8")).toBe("Use Bun.\n")

    const mcp = await item("mcp", "docs")
    expect(mcp.status).toBe(200)
    const config = async () =>
      (await Bun.file(path.join(tmp.path, ".opencode", "opencode.jsonc"))
        .text()
        .catch(() => "")) + (await fs.readFile(path.join(tmp.path, "opencode.json"), "utf8"))
    expect(JSON.parse(await fs.readFile(path.join(tmp.path, "opencode.json"), "utf8")).mcp?.docs).toBeUndefined()
    await call("POST", `/operator/trash/${(await read<Entry>(mcp)).id}/restore`)
    expect(await config()).toContain("https://example.com/mcp")

    expect((await item("skill", "nothing-here")).status).toBe(400)
  })

  test("a session goes to Trash with its subagents' sessions as one entry, and comes back with them", async () => {
    await using tmp = await tmpdir({ git: true })
    const where = `?directory=${encodeURIComponent(tmp.path)}`
    const create = async (body: object) => read<{ id: string }>(await call("POST", `/session${where}`, body))
    const parent = await create({ title: "Parent" })
    const child = await create({ title: "Subagent", parentID: parent.id })
    const grandchild = await create({ title: "Its subagent", parentID: child.id })
    const archived = async (id: string) =>
      (await read<{ time: { archived?: number } }>(await app().request(`/session/${id}${where}`))).time.archived

    const moved = await call("POST", `/operator/trash/session${where}`, { sessionID: parent.id })
    expect(moved.status).toBe(200)
    const entry = await read<Entry & { sessions: string[] }>(moved)
    expect(entry.kind).toBe("session")
    expect(entry.sessions.toSorted()).toEqual([parent.id, child.id, grandchild.id].toSorted())
    for (const id of [parent.id, child.id, grandchild.id]) expect(await archived(id)).toBeNumber()
    expect((await read<Entry[]>(await app().request("/operator/trash"))).map((item) => item.id)).toContain(entry.id)

    expect((await call("POST", `/operator/trash/${entry.id}/restore`)).status).toBe(200)
    for (const id of [parent.id, child.id, grandchild.id]) expect(await archived(id)).toBeUndefined()
  })

  test("a session that doesn't exist is refused with the reason", async () => {
    const moved = await call("POST", "/operator/trash/session", { sessionID: "ses_missing" })
    expect(moved.status).toBe(400)
    expect(JSON.stringify(await moved.json())).toContain("No session ses_missing")
  })
})
