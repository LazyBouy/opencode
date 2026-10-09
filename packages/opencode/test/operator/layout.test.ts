import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorLayout } from "@/operator/layout"
import { OperatorProfileStore } from "@/operator/profile-store"
import { tmpdir } from "../fixture/fixture"

// Where namespaces and projects live (global_and_opencode_namespaces_spec.md §4, §5, §9): Global is the
// namespace at Global's folder; every other one is at <working directory>/<id>; a blank working directory
// makes Global and OpenCode one namespace. A project is in the namespace whose folder contains it.

const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
let work: Awaited<ReturnType<typeof tmpdir>>
let config: string
const store = () => path.join(Global.Path.config, "namespaces")
const write = async (file: string, data: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data))
}
const record = (id: string, extra: Record<string, unknown> = {}) =>
  write(path.join(store(), id, "namespace.json"), { id, name: id, purpose: "", createdAt: 1, updatedAt: 1, ...extra })

beforeEach(async () => {
  work = await tmpdir()
  config = path.join(work.path, "config")
  ;(Global.Path as { config: string }).config = config
  process.env.OPENCODE_WORKSPACE_ROOTS = work.path
})

afterEach(async () => {
  ;(Global.Path as { config: string }).config = previous.config
  if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
  else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
  await work[Symbol.asyncDispose]()
})

describe("a blank working directory", () => {
  test("Global and OpenCode are one namespace, at Global's folder", async () => {
    const layout = await OperatorLayout.snapshot()
    expect(layout.merged).toBe(true)
    expect(layout.workingDir).toBeUndefined()
    expect(layout.places.map((item) => item.id)).toEqual(["opencode"])
    expect(OperatorLayout.placeOf("global", layout)).toMatchObject({
      id: "opencode",
      folder: config,
      configDir: config,
      global: true,
      inheritGlobal: true,
    })
    expect(OperatorLayout.resolveId("global", layout)).toBe("opencode")
    expect(OperatorLayout.isGlobal("opencode", layout)).toBe(true)
    expect(OperatorLayout.globalId(layout)).toBe("opencode")
    expect(OperatorLayout.builtinsProtected("opencode", layout)).toBe(true)
  })

  test("other namespaces keep the folders their records name", async () => {
    await record("acme", { folder: path.join(work.path, "elsewhere", "acme") })
    const layout = await OperatorLayout.snapshot()
    expect(OperatorLayout.placeOf("acme", layout)).toMatchObject({
      folder: path.join(work.path, "elsewhere", "acme"),
      configDir: path.join(work.path, "elsewhere", "acme", ".opencode"),
      inPlace: true,
      global: false,
    })
    expect(OperatorLayout.builtinsProtected("acme", layout)).toBe(false)
  })
})

describe("a working directory", () => {
  const set = (dir: string) => OperatorLayout.writeSettings({ workingDir: dir })

  test("Global is its own namespace; the others are at <working directory>/<id>", async () => {
    const dir = path.join(work.path, "ws")
    await set(dir)
    await record("acme", { folder: path.join(work.path, "old", "acme"), inheritGlobal: false })
    await record("team")
    const layout = await OperatorLayout.snapshot()
    expect(layout).toMatchObject({ merged: false, workingDir: dir })
    expect(OperatorLayout.placeOf("global", layout)).toMatchObject({ folder: config, global: true, inPlace: true })
    expect(OperatorLayout.placeOf("opencode", layout)).toMatchObject({
      folder: path.join(dir, "opencode"),
      target: path.join(dir, "opencode"),
      configDir: path.join(dir, "opencode", ".opencode"),
      inPlace: true,
      global: false,
    })
    // Acme's record still names its old folder: it uses it, and isn't in place.
    expect(OperatorLayout.placeOf("acme", layout)).toMatchObject({
      folder: path.join(work.path, "old", "acme"),
      target: path.join(dir, "acme"),
      inPlace: false,
      inheritGlobal: false,
    })
    expect(OperatorLayout.placeOf("team", layout)).toMatchObject({ folder: path.join(dir, "team"), inPlace: true })
    expect(OperatorLayout.resolveId("global", layout)).toBe("global")
    expect(OperatorLayout.globalId(layout)).toBe("global")
    expect(OperatorLayout.builtinsProtected("opencode", layout)).toBe(true)
    expect(OperatorLayout.builtinsProtected("global", layout)).toBe(true)
    expect(OperatorLayout.builtinsProtected("team", layout)).toBe(false)
  })

  test("a project is in the namespace whose folder contains it, the deepest winning", async () => {
    const dir = path.join(work.path, "ws")
    await set(dir)
    await record("team")
    await record("inner", { folder: path.join(dir, "team", "inner") })
    await record("acme", { folder: path.join(work.path, "old", "acme") })
    const layout = await OperatorLayout.snapshot()
    const of = (project: string, assigned?: string) => OperatorLayout.membership(project, layout, assigned)
    expect(of(path.join(dir, "opencode", "app"))).toEqual({ namespace: "opencode" })
    expect(of(path.join(dir, "team", "site"))).toEqual({ namespace: "team" })
    expect(of(path.join(dir, "team", "inner", "x"))).toEqual({ namespace: "inner" })
    expect(of(path.join(config, "notes"))).toEqual({ namespace: "global" })
    // Outside every namespace folder: OpenCode's, flagged.
    expect(of(path.join(work.path, "loose"))).toEqual({ namespace: "opencode", flag: "outside-opencode" })
    // A folder that only starts with a namespace's name isn't in it.
    expect(of(path.join(dir, "team-two"))).toEqual({ namespace: "opencode", flag: "outside-opencode" })
    // Assigned to another namespace: stays there until it moves into its folder.
    expect(of(path.join(work.path, "loose"), "team")).toEqual({ namespace: "team", flag: "not-in-place" })
    expect(of(path.join(work.path, "old", "acme", "site"), "acme")).toEqual({ namespace: "acme" })
    // Assigned to OpenCode, or to a namespace that doesn't exist: by location.
    expect(of(path.join(dir, "team", "site"), "opencode")).toEqual({ namespace: "team" })
    expect(of(path.join(dir, "team", "site"), "gone")).toEqual({ namespace: "team" })
  })

  test("setting it creates Global's record, once", async () => {
    await set(path.join(work.path, "ws"))
    await OperatorProfileStore.settleLayout()
    const global = JSON.parse(await fs.readFile(path.join(store(), "global", "namespace.json"), "utf8"))
    expect(global).toMatchObject({ id: "global", name: "Global" })
    expect(await OperatorLayout.readSettings()).toMatchObject({ mcpLoginsCopied: true })
    // A second settle keeps the record as it is.
    await write(path.join(store(), "global", "namespace.json"), { ...global, purpose: "Mine" })
    await OperatorProfileStore.settleLayout()
    expect(JSON.parse(await fs.readFile(path.join(store(), "global", "namespace.json"), "utf8")).purpose).toBe("Mine")
  })
})

describe("choosing the working directory", () => {
  test("from the environment, else beside OpenCode's folder", () => {
    expect(OperatorLayout.derivedWorkingDir({ OPENCODE_OPERATOR_WORKING_DIR: "/work" }, "/elsewhere/opencode")).toBe(
      "/work",
    )
    expect(OperatorLayout.derivedWorkingDir({ OPENCODE_OPERATOR_WORKING_DIR: "relative" }, undefined)).toBeUndefined()
    expect(OperatorLayout.derivedWorkingDir({}, "/projects/opencode")).toBe("/projects")
    expect(OperatorLayout.derivedWorkingDir({}, undefined)).toBeUndefined()
  })

  test("absolute, inside the workspace, outside Global's folder and outside git", async () => {
    const roots = [work.path]
    expect(await OperatorLayout.workingDirProblem("ws", roots)).toContain("absolute")
    expect(await OperatorLayout.workingDirProblem("/nowhere/ws", roots)).toContain("outside the workspace")
    expect(await OperatorLayout.workingDirProblem(path.join(config, "ws"), roots)).toContain("can't be inside")
    await using repo = await tmpdir({ git: true })
    expect(await OperatorLayout.workingDirProblem(path.join(repo.path, "ws"), [repo.path])).toContain("git")
    expect(await OperatorLayout.workingDirProblem(path.join(work.path, "ws"), roots)).toBeUndefined()
  })
})
