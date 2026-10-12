import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorLayout } from "@/operator/layout"
import { OperatorOnboarding } from "@/operator/onboarding"
import { OperatorProfileStore } from "@/operator/profile-store"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Onboarding (memory_spec.md §10): a new installation sets its working folder and a default OpenCode project
// in OpenCode's folder, once; the repository the server runs from is never added.

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const stateFile = () => path.join(Global.Path.data, "operator", "onboarding.json")
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
const readJson = (file: string) => fs.readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>)

type Status = {
  pending: boolean
  done?: { workingDir: string; project: string }
  suggested: string
  project: string
  roots: string[]
  agents: Array<{ id: string; folder: string; insideHome: boolean }>
}
type Preview = { workingDir: string; opencodeFolder: string; projectFolder: string; problems: string[] }

const keep = { projects: "", roots: process.env.OPENCODE_WORKSPACE_ROOTS }
let root: Awaited<ReturnType<typeof tmpdir>>
let work: string

beforeEach(async () => {
  root = await tmpdir()
  work = path.join(root.path, "home")
  keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  process.env.OPENCODE_WORKSPACE_ROOTS = root.path
  await fs.mkdir(store(), { recursive: true })
  // A new installation: no working folder yet, onboarding waiting.
  await fs.writeFile(path.join(store(), "settings.json"), JSON.stringify({ workingDir: "" }))
  await fs.rm(stateFile(), { force: true })
  await OperatorOnboarding.markPending()
})

afterEach(async () => {
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  await fs.rm(path.join(store(), "settings.json"), { force: true })
  await fs.rm(path.join(store(), "global"), { recursive: true, force: true })
  await fs.rm(stateFile(), { force: true })
  if (keep.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
  else process.env.OPENCODE_WORKSPACE_ROOTS = keep.roots
  await disposeAllInstances()
  await resetDatabase()
  await root[Symbol.asyncDispose]()
})

describe("onboarding", () => {
  test("waits on a new installation and suggests opencode-home when the server's folder can't be used", async () => {
    const status = await request<Status>("GET", "/operator/onboarding/status")
    expect(status.status).toBe(200)
    expect(status.body.pending).toBe(true)
    // The tests' folder and ~/opencode-home are outside the roots, so the first root's is suggested.
    expect(status.body.suggested).toBe(path.join(root.path, "opencode-home"))
    expect(await OperatorOnboarding.suggested([os.homedir()], root.path)).toBe(path.join(os.homedir(), "opencode-home"))
    expect(status.body.project).toBe("opencode")
    expect(status.body.roots).toEqual([root.path])
    const claude = status.body.agents.find((agent) => agent.id === "claude")
    expect(claude?.folder.endsWith(path.join("", "projects"))).toBe(true)
    expect(claude?.insideHome).toBe(OperatorOnboarding.insideHome(claude!.folder))
  })

  test("checks the folders: absolute, inside the roots, outside git, and a folder name", async () => {
    const relative = await request<Preview>("POST", "/operator/onboarding/check", {
      workingDir: "home",
      project: "opencode",
    })
    expect(relative.body.problems.join(" ")).toContain("absolute")
    const outside = await request<Preview>("POST", "/operator/onboarding/check", {
      workingDir: path.join(os.tmpdir(), "elsewhere-onboarding"),
      project: "opencode",
    })
    expect(outside.body.problems.join(" ")).toContain("outside the workspace")
    const name = await request<Preview>("POST", "/operator/onboarding/check", { workingDir: work, project: "../x" })
    expect(name.body.problems.join(" ")).toContain("isn't a folder name")
    const good = await request<Preview>("POST", "/operator/onboarding/check", { workingDir: work, project: "opencode" })
    expect(good.body).toMatchObject({
      workingDir: work,
      opencodeFolder: path.join(work, "opencode"),
      projectFolder: path.join(work, "opencode", "opencode"),
      problems: [],
    })
    // Nothing is made.
    expect(await exists(work)).toBe(false)
  })

  test("sets the working folder, makes the default project a git repository, and runs once", async () => {
    const done = await request<Record<string, unknown>>("POST", "/operator/onboarding/finish", {
      workingDir: work,
      project: "opencode",
    })
    expect(done.status).toBe(200)
    const project = path.join(work, "opencode", "opencode")
    expect(done.body).toEqual({
      workingDir: work,
      opencodeFolder: path.join(work, "opencode"),
      project,
      git: true,
    })
    expect(await exists(path.join(project, ".git"))).toBe(true)
    expect((await readJson(path.join(store(), "settings.json"))).workingDir).toBe(work)
    // Global and OpenCode are separate namespaces now; the project is OpenCode's default.
    expect(await exists(path.join(store(), "global", "namespace.json"))).toBe(true)
    expect((await readJson(path.join(store(), "opencode", "namespace.json"))).defaultProject).toBe(project)
    const listed = await request<Array<{ key: string; namespace: string }>>("GET", "/operator/project-settings")
    expect(listed.body.find((item) => item.key === project)?.namespace).toBe("opencode")
    // The repository the server runs from isn't a project.
    expect(listed.body.some((item) => process.cwd().startsWith(item.key))).toBe(false)

    const status = await request<Status>("GET", "/operator/onboarding/status")
    expect(status.body.pending).toBe(false)
    expect(status.body.done).toMatchObject({ workingDir: work, project })
    const again = await request<{ data: { message: string } }>("POST", "/operator/onboarding/finish", {
      workingDir: work,
      project: "opencode",
    })
    expect(again.status).toBe(400)
    expect(again.body.data.message).toContain("ran already")
  })

  test("registers the folder as it is when it isn't to be a git repository", async () => {
    const done = await request<{ project: string; git: boolean }>("POST", "/operator/onboarding/finish", {
      workingDir: work,
      project: "main",
      git: false,
    })
    expect(done.status).toBe(200)
    expect(done.body.git).toBe(false)
    const project = path.join(work, "opencode", "main")
    expect(await exists(path.join(project, ".git"))).toBe(false)
    expect((await readJson(path.join(store(), "projects.json")))[project]).toMatchObject({ namespace: "opencode" })
    expect((await readJson(path.join(store(), "opencode", "namespace.json"))).defaultProject).toBe(project)
  })

  test("an installation from before onboarding isn't asked", async () => {
    await fs.rm(stateFile(), { force: true })
    expect((await request<Status>("GET", "/operator/onboarding/status")).body.pending).toBe(false)
    const refused = await request<{ data: { message: string } }>("POST", "/operator/onboarding/finish", {
      workingDir: work,
      project: "opencode",
    })
    expect(refused.status).toBe(400)
    expect(refused.body.data.message).toContain("isn't waiting for onboarding")
    // Marking it pending later changes nothing once it is done.
    await OperatorOnboarding.markDone({ workingDir: work, project: path.join(work, "opencode", "opencode") })
    await OperatorOnboarding.markPending()
    expect(await OperatorOnboarding.read()).toMatchObject({ done: true })
  })

  test("a first start is told by settings.json having no working directory yet, even if another writer made it", async () => {
    // The memory defaults wrote the file first (they ran before the namespace store settled).
    await fs.writeFile(path.join(store(), "settings.json"), JSON.stringify({ memoryDefaults: true }))
    await fs.rm(stateFile(), { force: true })
    await OperatorProfileStore.firstStart({})
    expect(await readJson(path.join(store(), "settings.json"))).toEqual({ memoryDefaults: true, workingDir: "" })
    expect(await OperatorOnboarding.read()).toEqual({ pending: true })
    // A blank working directory chosen before is kept through other writes, and isn't a first start again.
    expect((await OperatorLayout.readSettings()).workingDir).toBe("")
    await fs.rm(stateFile(), { force: true })
    await OperatorProfileStore.firstStart({})
    expect(await OperatorOnboarding.read()).toBeUndefined()
    // Given a working directory, it's set at once and nothing waits.
    await fs.writeFile(path.join(store(), "settings.json"), JSON.stringify({ memoryDefaults: true }))
    await OperatorProfileStore.firstStart({ OPENCODE_OPERATOR_WORKING_DIR: work })
    expect((await readJson(path.join(store(), "settings.json"))).workingDir).toBe(work)
    expect(await OperatorOnboarding.read()).toBeUndefined()
  })
})
