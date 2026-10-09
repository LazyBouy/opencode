import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorProfileStore } from "@/operator/profile-store"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Strict creation (global_and_opencode_namespaces_spec.md §10): a namespace at <working directory>/<id>, a
// project at <namespace folder>/<name>; the upgrade's moves (§12) and a working-directory change (§9).

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const request = async <T>(method: string, route: string, body?: unknown) => {
  const response = await app().request(route, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}
const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

const keep = { projects: "", roots: process.env.OPENCODE_WORKSPACE_ROOTS }
let root: Awaited<ReturnType<typeof tmpdir>>
let work: string
const created: string[] = []

beforeEach(async () => {
  root = await tmpdir()
  work = path.join(root.path, "ws")
  await fs.mkdir(work, { recursive: true })
  keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  process.env.OPENCODE_WORKSPACE_ROOTS = root.path
  await fs.mkdir(store(), { recursive: true })
  await fs.writeFile(path.join(store(), "settings.json"), JSON.stringify({ workingDir: work }))
  // As setting the working directory does: Global gets its record.
  await OperatorProfileStore.settleLayout()
})

afterEach(async () => {
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  for (const id of created.splice(0)) await fs.rm(path.join(store(), id), { recursive: true, force: true })
  await fs.rm(path.join(store(), "settings.json"), { force: true })
  if (keep.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
  else process.env.OPENCODE_WORKSPACE_ROOTS = keep.roots
  await disposeAllInstances()
  await resetDatabase()
  await root[Symbol.asyncDispose]()
})

describe("a new namespace", () => {
  test("lives at <working directory>/<id>; its record names no folder", async () => {
    const preview = await request<{ id: string; folder: string; exists: boolean }>(
      "GET",
      "/operator/namespace-folder?name=Acme%20Tools",
    )
    expect(preview.body).toMatchObject({ id: "acme-tools", folder: path.join(work, "acme-tools"), exists: false })
    const made = await request<{ id: string; folder?: string }>("POST", "/operator/namespaces", { name: "Acme Tools" })
    expect(made.status).toBe(200)
    created.push(made.body.id)
    expect(made.body.folder).toBeUndefined()
    expect(await exists(path.join(work, "acme-tools"))).toBe(true)
    const layout = await request<{ namespaces: Array<{ id: string; folder: string; inPlace: boolean }> }>(
      "GET",
      "/operator/layout",
    )
    expect(layout.body.namespaces.find((item) => item.id === "acme-tools")).toMatchObject({
      folder: path.join(work, "acme-tools"),
      inPlace: true,
    })
  })

  test("an existing folder that isn't empty is used only when asked", async () => {
    await fs.mkdir(path.join(work, "acme", ".opencode"), { recursive: true })
    await fs.writeFile(path.join(work, "acme", ".opencode", "opencode.jsonc"), "{}")
    const refused = await request<{ data: { message: string } }>("POST", "/operator/namespaces", { name: "Acme" })
    expect(refused.status).toBe(400)
    expect(refused.body.data.message).toContain("already exists")
    const adopted = await request<{ id: string }>("POST", "/operator/namespaces", { name: "Acme", adopt: true })
    expect(adopted.status).toBe(200)
    created.push(adopted.body.id)
    expect(await fs.readFile(path.join(work, "acme", ".opencode", "opencode.jsonc"), "utf8")).toBe("{}")
  })

  test("without a working directory there is nowhere to put it", async () => {
    await fs.rm(path.join(store(), "settings.json"), { force: true })
    const refused = await request<{ data: { message: string } }>("POST", "/operator/namespaces", { name: "Acme" })
    expect(refused.status).toBe(400)
    expect(refused.body.data.message).toContain("Set a working directory first")
  })
})

describe("a new project", () => {
  test("is made at <namespace folder>/<name>, a git repository when asked", async () => {
    const made = await request<{ project: { key: string; namespace: string } }>(
      "POST",
      "/operator/project-settings/register",
      { namespace: "opencode", name: "site", git: true },
    )
    expect(made.status).toBe(200)
    expect(made.body.project).toMatchObject({ key: path.join(work, "opencode", "site"), namespace: "opencode" })
    expect(await exists(path.join(work, "opencode", "site", ".git"))).toBe(true)
    // The same name again: the folder exists.
    expect(
      (await request("POST", "/operator/project-settings/register", { namespace: "opencode", name: "site" })).status,
    ).toBe(400)
  })

  test("in Global: names OpenCode reads there are refused, and it is always a git repository", async () => {
    const reserved = await request<{ data: { message: string } }>("POST", "/operator/project-settings/register", {
      namespace: "global",
      name: "agents",
    })
    expect(reserved.status).toBe(400)
    expect(reserved.body.data.message).toContain("OpenCode reads")
    const name = `notes-${Date.now()}`
    const made = await request<{ project: { key: string } }>("POST", "/operator/project-settings/register", {
      namespace: "global",
      name,
      git: false,
    })
    expect(made.status).toBe(200)
    const folder = path.join(Global.Path.config, name)
    expect(made.body.project.key).toBe(folder)
    expect(await exists(path.join(folder, ".git"))).toBe(true)
    await fs.rm(folder, { recursive: true, force: true })
  })
})

describe("the upgrade and the working directory", () => {
  test("a namespace not in place makes the upgrade wait; Not now puts it off until the next start", async () => {
    const old = path.join(root.path, "old-acme")
    await fs.mkdir(old, { recursive: true })
    await fs.mkdir(path.join(store(), "acme"), { recursive: true })
    await fs.writeFile(
      path.join(store(), "acme", "namespace.json"),
      JSON.stringify({ id: "acme", name: "Acme", purpose: "", folder: old, createdAt: 1, updatedAt: 1 }),
    )
    created.push("acme")
    const before = await request<{ upgrade: { waiting: boolean; namespaces: number } }>("GET", "/operator/layout")
    expect(before.body.upgrade).toMatchObject({ waiting: true, namespaces: 1 })
    const plan = await request<{ id: string; items: Array<{ id: string; from: string; to: string }> }>(
      "POST",
      "/operator/layout/plan",
      { kind: "upgrade" },
    )
    expect(plan.body.items).toEqual([expect.objectContaining({ from: old, to: path.join(work, "acme") })])
    // Nothing moved by planning.
    expect(await exists(old)).toBe(true)
    const moved = await request<{ status: string }>("POST", "/operator/layout/move", {
      plan: plan.body.id,
      items: plan.body.items.map((item) => item.id),
    })
    expect(moved.body.status).toBe("done")
    const after = await request<{ upgrade: { waiting: boolean } }>("GET", "/operator/layout")
    expect(after.body.upgrade.waiting).toBe(false)
    const settings = JSON.parse(await fs.readFile(path.join(store(), "settings.json"), "utf8"))
    expect(settings.upgradeDone).toBe(true)
  })

  test("changing the working directory moves every namespace folder but Global's", async () => {
    await fs.mkdir(path.join(work, "opencode"), { recursive: true })
    await fs.writeFile(path.join(work, "opencode", "marker"), "here")
    const next = path.join(root.path, "ws2")
    const plan = await request<{ id: string; items: Array<{ id: string; name: string; to: string }> }>(
      "POST",
      "/operator/layout/plan",
      { kind: "working-dir", workingDir: next },
    )
    expect(plan.status).toBe(200)
    expect(plan.body.items.find((item) => item.name === "opencode")?.to).toBe(path.join(next, "opencode"))
    const moved = await request<{ status: string }>("POST", "/operator/layout/move", {
      plan: plan.body.id,
      items: plan.body.items.map((item) => item.id),
    })
    expect(moved.body.status).toBe("done")
    expect(await fs.readFile(path.join(next, "opencode", "marker"), "utf8")).toBe("here")
    const settings = JSON.parse(await fs.readFile(path.join(store(), "settings.json"), "utf8"))
    expect(settings.workingDir).toBe(next)
  })
})
