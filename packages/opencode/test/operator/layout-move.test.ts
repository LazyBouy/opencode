import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ClaudeSessions } from "../../src/merge/adapter/claude/sessions"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Moving folders (global_and_opencode_namespaces_spec.md §11): a plan with its blockers, then the move,
// which re-links the folder's sessions and rewrites what the stores keep.

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const post = async <T>(route: string, body: unknown, directory?: string) => {
  const response = await app().request(directory ? `${route}?directory=${encodeURIComponent(directory)}` : route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}
const git = (cwd: string, ...args: string[]) => Bun.$`git ${args}`.cwd(cwd).quiet()
const repo = async (folder: string) => {
  await fs.mkdir(folder, { recursive: true })
  await git(folder, "init", "-q")
  await git(
    folder,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    `root ${folder}`,
  )
}

type Agents = Array<{ adapter: string; name: string; folders: number }>
type Item = {
  id: string
  from: string
  to: string
  agents?: Agents
  blockers: Array<{ kind: string; message: string }>
}
type Plan = { id: string; items: Item[] }
type Report = {
  status: string
  moved: Array<{ from: string; to: string; sessions: number; agents?: Agents }>
  skipped: Array<{ reason: string }>
}

const keep = { projects: "", roots: process.env.OPENCODE_WORKSPACE_ROOTS, claude: process.env.CLAUDE_CONFIG_DIR }
let root: Awaited<ReturnType<typeof tmpdir>>

beforeEach(async () => {
  root = await tmpdir()
  keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  process.env.OPENCODE_WORKSPACE_ROOTS = root.path
  // Moves relocate Claude Code's sessions: never the real ones.
  process.env.CLAUDE_CONFIG_DIR = path.join(root.path, "claude-config")
})

afterEach(async () => {
  if (keep.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = keep.claude
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
  await fs.rm(path.join(store(), "settings.json"), { force: true })
  if (keep.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
  else process.env.OPENCODE_WORKSPACE_ROOTS = keep.roots
  await disposeAllInstances()
  await resetDatabase()
  await root[Symbol.asyncDispose]()
})

const acme = (folder: string) =>
  write(
    path.join(store(), "acme", "namespace.json"),
    JSON.stringify({ id: "acme", name: "Acme", purpose: "", folder, createdAt: 1, updatedAt: 1 }),
  )

describe("moving a project", () => {
  test("Move to namespace: the folder moves, its sessions follow, and the project is the namespace's", async () => {
    const acmeFolder = path.join(root.path, "acme")
    await fs.mkdir(acmeFolder, { recursive: true })
    await acme(acmeFolder)
    const project = path.join(root.path, "loose", "site")
    await repo(project)
    const session = await post<{ id: string; directory: string }>("/session", {}, project)
    expect(session.status).toBe(200)

    const plan = await post<Plan>("/operator/layout/plan", { kind: "project", project, namespace: "acme" })
    expect(plan.status).toBe(200)
    const item = plan.body.items[0]!
    expect(item).toMatchObject({ from: project, to: path.join(acmeFolder, "site"), blockers: [] })
    // Nothing moves before the move.
    expect(await Bun.file(path.join(project, ".git", "HEAD")).exists()).toBe(true)

    const moved = await post<Report>("/operator/layout/move", { plan: plan.body.id, items: [item.id] })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ status: "done", moved: [{ from: project, to: item.to, sessions: 1 }] })
    expect(await Bun.file(path.join(item.to, ".git", "HEAD")).exists()).toBe(true)
    expect(await Bun.file(path.join(project, ".git", "HEAD")).exists()).toBe(false)
    const info = (await (
      await app().request(`/session/${session.body.id}?directory=${encodeURIComponent(item.to)}`)
    ).json()) as {
      directory: string
    }
    expect(info.directory).toBe(item.to)
    const projects = JSON.parse(await fs.readFile(path.join(store(), "projects.json"), "utf8"))
    expect(projects[item.to]).toMatchObject({ namespace: "acme" })
    // A plan is used once.
    expect((await post("/operator/layout/move", { plan: plan.body.id, items: [item.id] })).status).toBe(400)
  })

  test("Claude Code's sessions of the folder follow it, so a merged session resumes in the new place", async () => {
    const acmeFolder = path.join(root.path, "acme")
    await fs.mkdir(acmeFolder, { recursive: true })
    await acme(acmeFolder)
    const project = path.join(root.path, "loose", "site")
    await repo(project)
    const claude = process.env.CLAUDE_CONFIG_DIR!
    const id = "1b2c3d4e-0000-4000-8000-000000000001"
    const transcript = (cwd: string) => path.join(claude, "projects", ClaudeSessions.folderName(cwd), `${id}.jsonl`)
    await write(transcript(project), JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } }) + "\n")
    const plan = await post<Plan>("/operator/layout/plan", { kind: "project", project, namespace: "acme" })
    const item = plan.body.items[0]!
    expect(item.agents).toEqual([{ adapter: "claude", name: "Claude Code", folders: 1 }])
    expect(item.blockers).toEqual([])
    const moved = await post<Report>("/operator/layout/move", { plan: plan.body.id, items: [item.id] })
    expect(moved.body.moved[0]?.agents).toEqual([{ adapter: "claude", name: "Claude Code", folders: 1 }])
    expect(JSON.parse(await fs.readFile(transcript(item.to), "utf8")).cwd).toBe(item.to)
    expect(await Bun.file(transcript(project)).exists()).toBe(false)
  })

  test("blocked items are skipped with the reason: the target exists, linked git worktrees", async () => {
    const acmeFolder = path.join(root.path, "acme")
    await acme(acmeFolder)
    const project = path.join(root.path, "loose", "site")
    await repo(project)
    await fs.mkdir(path.join(acmeFolder, "site"), { recursive: true })
    const linked = path.join(root.path, "loose", "app")
    await repo(linked)
    await git(linked, "worktree", "add", "-q", path.join(root.path, "loose", "app-feature"))

    const exists = await post<Plan>("/operator/layout/plan", { kind: "project", project, namespace: "acme" })
    expect(exists.body.items[0]!.blockers.map((item) => item.kind)).toContain("target-exists")
    const report = await post<Report>("/operator/layout/move", {
      plan: exists.body.id,
      items: exists.body.items.map((item) => item.id),
    })
    expect(report.body.status).toBe("failed")
    expect(report.body.skipped[0]!.reason).toContain("already exists")
    expect(await Bun.file(path.join(project, ".git", "HEAD")).exists()).toBe(true)

    const worktrees = await post<Plan>("/operator/layout/plan", { kind: "project", project: linked, namespace: "acme" })
    expect(worktrees.body.items[0]!.blockers.map((item) => item.kind)).toContain("worktrees")
  })

  test("protected folders never move", async () => {
    const plan = await post<{ name?: string }>("/operator/layout/plan", {
      kind: "project",
      project: Global.Path.config,
      namespace: "opencode",
    })
    // Global's folder: refused (it is protected, or already where OpenCode's projects go).
    if (plan.status === 200) expect(JSON.stringify(plan.body)).toContain("Global's folder never moves")
    else expect(plan.status).toBe(400)
  })
})

describe("moving a namespace", () => {
  test("Move into place: the namespace's folder goes to <working dir>/<id>, its projects with it", async () => {
    const work = path.join(root.path, "ws")
    await fs.mkdir(work, { recursive: true })
    await write(path.join(store(), "settings.json"), JSON.stringify({ workingDir: work }))
    const old = path.join(root.path, "old-acme")
    await acme(old)
    const project = path.join(old, "site")
    await repo(project)
    const session = await post<{ id: string }>("/session", {}, project)

    const plan = await post<Plan>("/operator/layout/plan", { kind: "namespace", namespace: "acme" })
    expect(plan.status).toBe(200)
    expect(plan.body.items[0]).toMatchObject({ from: old, to: path.join(work, "acme"), blockers: [] })
    const report = await post<Report>("/operator/layout/move", {
      plan: plan.body.id,
      items: [plan.body.items[0]!.id],
    })
    expect(report.body.status).toBe("done")
    const record = JSON.parse(await fs.readFile(path.join(store(), "acme", "namespace.json"), "utf8"))
    expect(record.folder).toBe(path.join(work, "acme"))
    const moved = path.join(work, "acme", "site")
    const info = (await (
      await app().request(`/session/${session.body.id}?directory=${encodeURIComponent(moved)}`)
    ).json()) as {
      directory: string
    }
    expect(info.directory).toBe(moved)
    const layout = (await (await app().request("/operator/layout")).json()) as {
      namespaces: Array<{ id: string; inPlace: boolean }>
    }
    expect(layout.namespaces.find((item) => item.id === "acme")?.inPlace).toBe(true)
  })
})
