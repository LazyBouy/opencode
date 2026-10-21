import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

// SPEC-0022 §6, §10.5, §11 through the API: hooks declared at Global, a namespace, a project and an agent, in
// run order with their levels and states; a namespace that leaves out Global's capabilities gets none of its
// hooks; a project's copy of its namespace's config leaves the locked hooks in the namespace's file, still
// running; Settings → Hooks.

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const globalFile = () => path.join(Global.Path.config, "opencode.jsonc")
const write = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2))
}
const keep = { projects: "", global: undefined as string | undefined }

afterEach(async () => {
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
  await fs.rm(path.join(store(), "hook-settings.json"), { force: true })
  if (keep.global === undefined) await fs.rm(globalFile(), { force: true })
  else await fs.writeFile(globalFile(), keep.global)
  await disposeAllInstances()
  await resetDatabase()
})

const acme = async (folder: string, projects: string[], record: Record<string, unknown> = {}) => {
  keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  await write(path.join(store(), "acme", "namespace.json"), {
    id: "acme",
    name: "Acme",
    purpose: "",
    folder,
    createdAt: 1,
    updatedAt: 1,
    ...record,
  })
  await fs.mkdir(path.join(folder, ".opencode"), { recursive: true })
  const current = keep.projects ? (JSON.parse(keep.projects) as Record<string, unknown>) : {}
  await write(path.join(store(), "projects.json"), {
    ...current,
    ...Object.fromEntries(projects.map((key) => [key, { namespace: "acme" }])),
  })
}
const globalHooks = async (hooks: Record<string, unknown>) => {
  keep.global = await fs.readFile(globalFile(), "utf8").catch(() => undefined)
  await write(globalFile(), { hooks })
}

const request = async (method: string, route: string, directory: string, body?: unknown) => {
  const join = route.includes("?") ? "&" : "?"
  const response = await app().request(`${route}${join}directory=${encodeURIComponent(directory)}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  })
  return { status: response.status, body: (await response.json()) as any }
}
type Hook = { name: string; level: string; state: string; locked: boolean; command: string; problems: string[] }
const list = async (directory: string, agent?: string) =>
  ((await request("GET", `/operator/hook${agent ? `?agent=${agent}` : ""}`, directory)).body as { hooks: Hook[] }).hooks
const summary = (hooks: Hook[]) => hooks.map((hook) => `${hook.level}:${hook.name}:${hook.state}`)
const hook = (event: string, extra: Record<string, unknown> = {}) => ({ event, command: "hooks/x.sh", ...extra })

describe("hooks in force", () => {
  test("Global, namespace, project and agent, in that order; offs and overrides; the script beside its file", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await using plain = await tmpdir({ git: true })
    await acme(folder.path, [project.path, plain.path])
    await globalHooks({ audit: hook("turn.after"), notify: hook("turn.after") })
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), {
      hooks: { guard: hook("tool.before", { locked: true, match: ["bash"] }), lint: hook("tool.after") },
    })
    await write(path.join(project.path, ".opencode", "opencode.jsonc"), {
      hooks: { notify: hook("turn.after", { command: "/bin/true" }), ci: hook("turn.before") },
      capabilities: { disabled: { hooks: ["audit"] } },
      agent: { reviewer: { hooks: { mine: hook("step.after") }, hooksDisabled: ["lint", "guard"] } },
    })

    // A project that uses its namespace's config gets all of the namespace's hooks.
    expect(summary(await list(plain.path))).toEqual([
      "global:audit:on",
      "global:notify:on",
      "namespace:guard:on",
      "namespace:lint:on",
    ])
    // A project with a config of its own (ADR-0008) gets only its namespace's locked hooks.
    expect(summary(await list(project.path))).toEqual([
      "global:audit:off",
      "namespace:guard:on",
      "project:notify:on",
      "project:ci:on",
    ])
    const hooks = await list(project.path, "reviewer")
    expect(summary(hooks)).toEqual([
      "global:audit:off",
      "namespace:guard:on",
      "project:notify:on",
      "project:ci:on",
      "agent:mine:on",
    ])
    // A relative script resolves against the folder of the file that declares it.
    expect(hooks.find((item) => item.name === "ci")!.command).toBe(
      path.join(project.path, ".opencode", "hooks", "x.sh"),
    )
    // The agent can't turn off the locked guard: it keeps running, and the conflict is listed.
    expect(hooks.find((item) => item.name === "guard")!.problems).toEqual([
      expect.stringContaining("locked at namespace: agent can't turn it off"),
    ])
    // A hand edit shows at once.
    await write(path.join(project.path, ".opencode", "opencode.jsonc"), { hooks: { ci: hook("turn.before") } })
    expect(summary(await list(project.path))).toEqual([
      "global:audit:on",
      "global:notify:on",
      "namespace:guard:on",
      "project:ci:on",
    ])
  })

  test("a namespace that leaves out Global's capabilities gets none of Global's hooks", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path], { inheritGlobal: false })
    await globalHooks({ audit: hook("turn.after") })
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), { hooks: { guard: hook("tool.before") } })
    expect(summary(await list(project.path))).toEqual(["namespace:guard:on"])
  })

  test("a project's copy of its namespace's config keeps the unlocked hooks; locked ones run from the namespace", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), {
      hooks: { guard: hook("tool.before", { locked: true }), lint: hook("tool.after") },
    })
    // Saving a project permission line gives the project its own config: a copy of its namespace's.
    const saved = await request("PUT", "/operator/permission/level/project?confirmCopy=true", project.path, {
      lines: [{ permission: "read", pattern: "*.md", action: "allow" }],
      deleted: [],
      locks: [],
    })
    expect(saved.status).toBe(200)
    const copy = JSON.parse(await fs.readFile(saved.body.file as string, "utf8")) as { hooks?: Record<string, unknown> }
    expect(Object.keys(copy.hooks ?? {})).toEqual(["lint"])
    expect(summary(await list(project.path))).toEqual(["namespace:guard:on", "project:lint:on"])
  })
})

describe("the run log", () => {
  test("a session's runs are listed by session, and go when the session is deleted", async () => {
    await using project = await tmpdir({ git: true })
    const created = await request("POST", "/session", project.path, { title: "Hooked" })
    const id = created.body.id as string
    const file = path.join(Global.Path.data, "operator", "hook-runs", `${id}.jsonl`)
    const run = {
      id: `hr.${id}.a1`,
      time: Date.now(),
      event: "tool.before",
      hook: "guard",
      level: "project",
      file: "/x",
      sessionID: id,
      outcome: "ok",
    }
    await write(file, JSON.stringify(run) + "\n")
    expect((await request("GET", `/operator/hook/runs?session=${id}`, project.path)).body).toMatchObject({ total: 1 })
    expect((await request("GET", `/operator/hook/runs/hr.${id}.a1`, project.path)).body).toMatchObject({
      hook: "guard",
    })
    expect((await request("DELETE", `/session/${id}`, project.path)).status).toBe(200)
    for (let tries = 0; tries < 40 && (await Bun.file(file).exists()); tries++) await Bun.sleep(50)
    expect(await Bun.file(file).exists()).toBe(false)
  })
})

describe("Settings → Hooks and the events", () => {
  test("the default timeout and Pause all; a timeout out of range is refused", async () => {
    await using project = await tmpdir({ git: true })
    expect((await request("GET", "/operator/hook/settings", project.path)).body).toEqual({ timeout: 5, paused: false })
    expect((await request("PUT", "/operator/hook/settings", project.path, { timeout: 2.5 })).body).toEqual({
      timeout: 2.5,
      paused: false,
    })
    expect((await request("PUT", "/operator/hook/settings", project.path, { paused: true })).body).toEqual({
      timeout: 2.5,
      paused: true,
    })
    const refused = await request("PUT", "/operator/hook/settings", project.path, { timeout: 0 })
    expect(refused.status).toBe(400)
    expect(((await request("GET", "/operator/hook", project.path)).body as { paused: boolean }).paused).toBe(true)
  })

  test("the sixteen events, with what each answer may do", async () => {
    await using project = await tmpdir({ git: true })
    const events = (await request("GET", "/operator/hook/events", project.path)).body as Array<{
      name: string
      kind: string
      fields: string[]
    }>
    expect(events).toHaveLength(16)
    expect(events.find((item) => item.name === "tool.before")).toMatchObject({
      kind: "blocking",
      fields: ["allow", "reason", "input", "context"],
      subject: "tool",
    })
    expect(events.find((item) => item.name === "turn.after")).toMatchObject({ kind: "watch", fields: [] })
    expect((await request("GET", "/operator/hook/runs?session=ses_none", project.path)).body).toEqual({
      runs: [],
      total: 0,
    })
    expect((await request("GET", "/operator/hook/runs/hr.tests.nope", project.path)).status).toBe(404)
  })
})
