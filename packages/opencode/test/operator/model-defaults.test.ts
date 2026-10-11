import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { parse } from "jsonc-parser"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// The default and small model by level (default_models_spec.md §11): a namespace's own chain, writing
// Settings', a namespace's or a project's model, and where a model is the default.

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const request = async <T>(method: string, route: string, body?: unknown) => {
  const response = await app().request(route, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}
// OpenCode adds `$schema` to the config files it loads: left out of comparisons.
const readJsonc = (file: string) =>
  fs.readFile(file, "utf8").then((text) => {
    const { $schema: _, ...value } = parse(text) as Record<string, unknown>
    return value
  })
const writeJson = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value))
}

type Link = { level: string; set: boolean; model?: string; path: string }
type Effective = { model: string; from: string; unavailable?: boolean }
type Chain = { levels: Link[]; effective: Effective; inherited: Effective }
type Namespace = { namespace?: string; settings: boolean; path: string; chain: { model: Chain; small: Chain } }

const keep = { projects: "", roots: process.env.OPENCODE_WORKSPACE_ROOTS, global: "" }
let root: Awaited<ReturnType<typeof tmpdir>>
let work: string
let app_: string
const globalFile = () => path.join(Global.Path.config, "opencode.jsonc")

beforeEach(async () => {
  root = await tmpdir()
  work = path.join(root.path, "ws")
  app_ = path.join(work, "acme", "app")
  await fs.mkdir(app_, { recursive: true })
  keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  keep.global = await fs.readFile(globalFile(), "utf8").catch(() => "")
  process.env.OPENCODE_WORKSPACE_ROOTS = root.path
  await writeJson(path.join(store(), "settings.json"), { workingDir: work })
  const now = Date.now()
  await writeJson(path.join(store(), "acme", "namespace.json"), {
    id: "acme",
    name: "Acme",
    purpose: "",
    createdAt: now,
    updatedAt: now,
  })
  // A folder outside git registered as Acme's project.
  await writeJson(path.join(store(), "projects.json"), { [app_]: { namespace: "acme" } })
})

afterEach(async () => {
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  if (keep.global) await fs.writeFile(globalFile(), keep.global)
  else await fs.rm(globalFile(), { force: true })
  await fs.rm(path.join(store(), "settings.json"), { force: true })
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
  await fs.rm(path.join(store(), "global"), { recursive: true, force: true })
  if (keep.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
  else process.env.OPENCODE_WORKSPACE_ROOTS = keep.roots
  await disposeAllInstances()
  await resetDatabase()
  await root[Symbol.asyncDispose]()
})

const put = (body: Record<string, unknown>) => request<Record<string, unknown>>("PUT", "/operator/model/default", body)

describe("model defaults by level", () => {
  test("Settings, a namespace, and a project: each writes its own file, and null removes the key", async () => {
    // Settings alone: nothing set, OpenCode decides.
    let settings = await request<Namespace>("GET", "/operator/model/namespace")
    expect(settings.status).toBe(200)
    expect(settings.body.settings).toBe(true)
    expect(settings.body.chain.model.levels.map((link) => link.level)).toEqual(["settings"])
    expect(settings.body.chain.model.effective.from).toBe("opencode")

    expect((await put({ level: "settings", key: "model", model: "test/a" })).status).toBe(200)
    expect((await readJsonc(globalFile())).model).toBe("test/a")
    settings = await request<Namespace>("GET", "/operator/model/namespace")
    expect(settings.body.chain.model.effective).toMatchObject({ model: "test/a", from: "settings" })

    // Acme inherits it, then sets its own.
    let acme = await request<Namespace>("GET", "/operator/model/namespace?namespace=acme")
    expect(acme.body.settings).toBe(false)
    expect(acme.body.chain.model.levels.map((link) => link.level)).toEqual(["settings", "namespace"])
    expect(acme.body.chain.model.effective.from).toBe("settings")
    const acmeFile = path.join(work, "acme", ".opencode", "opencode.jsonc")
    expect(acme.body.path).toBe(acmeFile)
    expect((await put({ level: "namespace", namespace: "acme", key: "model", model: "test/b" })).status).toBe(200)
    expect((await readJsonc(acmeFile)).model).toBe("test/b")
    expect((await readJsonc(globalFile())).model).toBe("test/a")
    acme = await request<Namespace>("GET", "/operator/model/namespace?namespace=acme")
    expect(acme.body.chain.model.effective).toMatchObject({ model: "test/b", from: "namespace" })
    // The namespace row's Inherit: Settings'.
    expect(acme.body.chain.model.inherited).toMatchObject({ model: "test/a", from: "settings" })

    // Global's config is Settings: its namespace level is refused.
    const global = await request<Namespace>("GET", "/operator/model/namespace?namespace=global")
    expect(global.body.settings).toBe(true)
    expect(global.body.chain.model.levels.map((link) => link.level)).toEqual(["settings"])
    expect((await put({ level: "namespace", namespace: "global", key: "model", model: "test/c" })).status).toBe(400)

    // The project: its first write needs the copy question; the copy leaves Acme's model out.
    const refused = await put({ level: "project", directory: app_, key: "small_model", model: "test/c" })
    expect(refused.status).toBe(409)
    const done = await put({
      level: "project",
      directory: app_,
      key: "small_model",
      model: "test/c",
      confirmCopy: true,
    })
    expect(done.status).toBe(200)
    const projectFile = path.join(app_, ".opencode", "opencode.jsonc")
    expect(await readJsonc(projectFile)).toEqual({ small_model: "test/c" })
    expect((await readJsonc(acmeFile)).model).toBe("test/b")
    const project = await request<{ chain: { model: Chain; small: Chain } }>(
      "GET",
      `/operator/model?directory=${encodeURIComponent(app_)}`,
    )
    expect(project.body.chain.model.levels.map((link) => link.level)).toEqual(["settings", "namespace", "project"])
    expect(project.body.chain.model.effective).toMatchObject({ model: "test/b", from: "namespace" })
    expect(project.body.chain.small.effective).toMatchObject({ model: "test/c", from: "project" })

    // Inherit removes the key.
    expect((await put({ level: "project", directory: app_, key: "small_model", model: null })).status).toBe(200)
    expect(await readJsonc(projectFile)).toEqual({})
    expect((await put({ level: "settings", key: "model", model: null })).status).toBe(200)
    expect("model" in (await readJsonc(globalFile()))).toBe(false)
  })

  test("Default for lists Settings, the namespaces and the projects that set the model", async () => {
    await writeJson(globalFile(), { model: "test/a", small_model: "test/b" })
    await writeJson(path.join(work, "acme", ".opencode", "opencode.jsonc"), { small_model: "test/a" })
    await writeJson(path.join(app_, ".opencode", "opencode.jsonc"), { model: "test/a" })
    const found = await request<{
      settings?: { model: boolean; small: boolean }
      namespaces: Array<{ id: string; model: boolean; small: boolean }>
      projects: Array<{ key: string; model: boolean; small: boolean }>
    }>("GET", "/operator/model/default-for?model=test%2Fa")
    expect(found.status).toBe(200)
    expect(found.body.settings).toMatchObject({ model: true, small: false })
    expect(found.body.namespaces).toEqual([expect.objectContaining({ id: "acme", model: false, small: true })])
    expect(found.body.projects).toEqual([expect.objectContaining({ key: app_, model: true, small: false })])
    const other = await request<{ settings?: unknown; namespaces: unknown[]; projects: unknown[] }>(
      "GET",
      "/operator/model/default-for?model=test%2Fb",
    )
    expect(other.body.settings).toMatchObject({ model: false, small: true })
    expect(other.body.namespaces).toEqual([])
    expect(other.body.projects).toEqual([])
  })
})
