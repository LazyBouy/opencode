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

// SPEC-0022 §10.1, §10.2, §10.4 through the API: the console's changes at the Capabilities page's scope.
describe("changing hooks from the console", () => {
  type View = Hook & { lastRun?: { outcome: string }; runsToday?: number }
  const listIn = async (directory: string, namespace?: string) =>
    (await request("GET", `/operator/hook${namespace ? `?namespace=${namespace}` : ""}`, directory)).body as {
      hooks: View[]
      level: string
      file: string
      folder: string
    }

  test("a project's first hook asks for its own config; then it's saved with its script, edited and renamed", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), {
      hooks: { guard: hook("tool.before", { locked: true }), lint: hook("tool.after") },
    })
    const scope = await listIn(project.path)
    expect(scope.level).toBe("project")

    const script = await request("POST", "/operator/hook/script", project.path, {
      name: "ci",
      language: "shell",
      event: "turn.before",
    })
    expect(script.status).toBe(200)
    expect(script.body.path).toBe(path.join(scope.folder, "ci.sh"))
    expect(script.body.command).toBe(path.join("hooks", "ci.sh"))
    expect((await fs.stat(script.body.path)).mode & 0o111).toBeTruthy()
    expect(await fs.readFile(script.body.path, "utf8")).toStartWith("#!/bin/sh\n# turn.before: the session waits")

    const hookBody = { name: "ci", hook: { event: "turn.before", command: script.body.command, timeout: 2 } }
    expect((await request("PUT", "/operator/hook", project.path, hookBody)).status).toBe(409)
    const saved = await request("PUT", "/operator/hook?confirmCopy=true", project.path, hookBody)
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({
      name: "ci",
      level: "project",
      state: "on",
      timeout: 2,
      command: script.body.path,
    })
    // The copy took the namespace's unlocked hook; the locked one runs from the namespace.
    expect(summary((await listIn(project.path)).hooks)).toEqual([
      "namespace:guard:on",
      "project:lint:on",
      "project:ci:on",
    ])

    // A locked hook can't be replaced; an entry with problems isn't saved.
    const locked = await request("PUT", "/operator/hook", project.path, {
      name: "guard",
      hook: { event: "tool.before", command: "hooks/ci.sh" },
    })
    expect(locked.status).toBe(400)
    expect(locked.body.data.message).toContain("locked at namespace")
    const wrong = await request("PUT", "/operator/hook", project.path, {
      name: "odd",
      hook: { event: "tool.sometime", command: "hooks/ci.sh" },
    })
    expect(wrong.status).toBe(400)
    expect(wrong.body.data.message).toContain("unknown event tool.sometime")

    // Edited (a field dropped is gone, not merged) and renamed.
    expect(
      (
        await request("PUT", "/operator/hook", project.path, {
          name: "ci",
          hook: { event: "turn.before", command: script.body.command },
        })
      ).body.timeout,
    ).toBeUndefined()
    const renamed = await request("PUT", "/operator/hook", project.path, {
      name: "ci-status",
      previous: "ci",
      hook: { event: "turn.before", command: script.body.command },
    })
    expect(renamed.status).toBe(200)
    expect(summary((await listIn(project.path)).hooks)).toEqual([
      "namespace:guard:on",
      "project:lint:on",
      "project:ci-status:on",
    ])
  })

  test("a namespace turns an inherited hook off and on, never a locked one; its own goes to Trash with its script and comes back", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await globalHooks({ audit: hook("turn.after"), policy: hook("tool.before", { locked: true }) })
    const scope = await listIn(project.path, "acme")
    expect(scope.level).toBe("namespace")
    expect(summary(scope.hooks)).toEqual(["global:audit:on", "global:policy:on"])

    const off = await request("POST", "/operator/hook/state", project.path, {
      namespace: "acme",
      name: "audit",
      off: true,
    })
    expect(off.body).toMatchObject({ state: "off", offAt: "namespace" })
    const file = JSON.parse(await fs.readFile(scope.file, "utf8"))
    expect(file.capabilities.disabled.hooks).toEqual(["audit"])
    expect(
      (await request("POST", "/operator/hook/state", project.path, { namespace: "acme", name: "audit", off: false }))
        .body.state,
    ).toBe("on")
    const refused = await request("POST", "/operator/hook/state", project.path, {
      namespace: "acme",
      name: "policy",
      off: true,
    })
    expect(refused.status).toBe(400)
    expect(refused.body.data.message).toContain("locked at global")

    const script = await request("POST", "/operator/hook/script", project.path, {
      namespace: "acme",
      name: "lint",
      language: "python",
      event: "tool.after",
    })
    expect(script.body.path).toBe(path.join(folder.path, ".opencode", "hooks", "lint.py"))
    await request("PUT", "/operator/hook", project.path, {
      namespace: "acme",
      name: "lint",
      hook: { event: "tool.after", command: script.body.command, match: ["edit"] },
    })
    // Inherited hooks are turned off, not deleted.
    expect(
      (await request("POST", "/operator/hook/remove", project.path, { namespace: "acme", name: "audit" })).status,
    ).toBe(400)
    const removed = await request("POST", "/operator/hook/remove", project.path, {
      namespace: "acme",
      name: "lint",
      script: true,
    })
    expect(removed.body).toBe(true)
    expect(summary((await listIn(project.path, "acme")).hooks)).toEqual(["global:audit:on", "global:policy:on"])
    expect(await Bun.file(script.body.path).exists()).toBe(false)
    const trash = (await request("GET", "/operator/trash", project.path)).body as Array<{
      id: string
      kind: string
      name: string
    }>
    const entry = trash.find((item) => item.kind === "hook" && item.name === "lint")!
    expect(entry).toBeDefined()
    expect((await request("POST", `/operator/trash/${entry.id}/restore`, project.path)).status).toBe(200)
    expect((await listIn(project.path, "acme")).hooks.find((item) => item.name === "lint")).toMatchObject({
      match: ["edit"],
      level: "namespace",
    })
    expect(await Bun.file(script.body.path).exists()).toBe(true)
  })

  test("Test runs a hook on a sample event in its level's folder; it's a Test run, never a hook's last run", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    const hooksFolder = path.join(folder.path, ".opencode", "hooks")
    await write(
      path.join(hooksFolder, "where.sh"),
      [
        "#!/bin/sh",
        "input=$(cat)",
        `case "$input" in *'"tool":"bash"'*) printf '{"allow":false,"reason":"in %s"}' "$(pwd)" ;; esac`,
      ].join("\n"),
    )
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), {
      hooks: { where: hook("tool.before", { command: "hooks/where.sh" }) },
    })
    const sample = await request("GET", "/operator/hook/sample?event=tool.before&language=python", project.path)
    expect(sample.body.input).toMatchObject({ event: "tool.before", tool: "bash" })
    expect(sample.body.script).toContain("json.load(sys.stdin)")

    const tested = await request("POST", "/operator/hook/test", project.path, { namespace: "acme", name: "where" })
    expect(tested.status).toBe(200)
    expect(tested.body).toMatchObject({ outcome: "denied", answer: { allow: false } })
    expect(tested.body.answer.reason).toBe(`in ${await fs.realpath(path.join(folder.path, ".opencode"))}`)
    expect(tested.body.run).toMatchObject({ test: true, hook: "where", event: "tool.before" })
    // The event as given: a call of another tool gets no objection.
    const other = await request("POST", "/operator/hook/test", project.path, {
      namespace: "acme",
      name: "where",
      input: { tool: "read", input: { filePath: "a.ts" } },
    })
    expect(other.body.outcome).toBe("ok")
    expect((await request("GET", "/operator/hook/runs?test=true&hook=where", project.path)).body.total).toBe(2)
    expect((await listIn(project.path, "acme")).hooks.find((item) => item.name === "where")?.lastRun).toBeUndefined()
  })

  test("scripts are listed, read and saved in the scope's hooks/ folder only; others are read-only", async () => {
    await using folder = await tmpdir()
    await using elsewhere = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    const outside = path.join(elsewhere.path, "audit.sh")
    await write(outside, "#!/bin/sh\nexit 0\n")
    await globalHooks({ audit: hook("turn.after", { command: outside }) })
    const made = await request("POST", "/operator/hook/script", project.path, {
      namespace: "acme",
      name: "notes",
      language: "javascript",
      event: "turn.after",
    })
    expect(made.body.path).toEndWith(path.join(".opencode", "hooks", "notes.js"))
    // Not twice.
    expect(
      (
        await request("POST", "/operator/hook/script", project.path, {
          namespace: "acme",
          name: "notes",
          language: "javascript",
          event: "turn.after",
        })
      ).status,
    ).toBe(400)
    expect((await request("GET", "/operator/hook/scripts?namespace=acme", project.path)).body).toEqual([made.body.path])
    const read = await request(
      "GET",
      `/operator/hook/script?namespace=acme&path=${encodeURIComponent(made.body.path)}`,
      project.path,
    )
    expect(read.body).toMatchObject({ path: made.body.path, editable: true })
    expect(read.body.text).toContain("Bun.stdin.text()")
    expect(
      (
        await request("PUT", "/operator/hook/script", project.path, {
          namespace: "acme",
          path: made.body.path,
          text: "// mine\n",
        })
      ).status,
    ).toBe(200)
    expect(await fs.readFile(made.body.path, "utf8")).toBe("// mine\n")
    // An inherited hook's script: read-only; anything else: refused.
    const inherited = await request(
      "GET",
      `/operator/hook/script?namespace=acme&path=${encodeURIComponent(outside)}`,
      project.path,
    )
    expect(inherited.body).toMatchObject({ editable: false, text: "#!/bin/sh\nexit 0\n" })
    expect(
      (await request("PUT", "/operator/hook/script", project.path, { namespace: "acme", path: outside, text: "" }))
        .status,
    ).toBe(400)
    expect(
      (await request("GET", `/operator/hook/script?path=${encodeURIComponent("/etc/hostname")}`, project.path)).status,
    ).toBe(400)
  })
})

describe("an agent's own hooks", () => {
  test("saved in its definition, an inherited one turned off for it (never a locked one), deleted to Trash and back", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), {
      hooks: { guard: hook("tool.before", { locked: true }), lint: hook("tool.after") },
    })
    await write(path.join(project.path, ".opencode", "opencode.jsonc"), {
      agent: { reviewer: { mode: "primary", description: "Reviews", prompt: "Review." } },
    })
    const agentList = async () =>
      ((await request("GET", "/operator/hook?agent=reviewer", project.path)).body as { hooks: Hook[] }).hooks

    const saved = await request("PUT", "/operator/hook", project.path, {
      agent: "reviewer",
      name: "mine",
      hook: { event: "step.after", command: "hooks/mine.sh" },
    })
    expect(saved.body.data?.message).toBeUndefined()
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ name: "mine", level: "agent", state: "on" })
    const file = JSON.parse(await fs.readFile(path.join(project.path, ".opencode", "opencode.jsonc"), "utf8"))
    expect(file.agent.reviewer.hooks).toEqual({ mine: { event: "step.after", command: "hooks/mine.sh" } })

    // The project's own config has only the namespace's locked hook.
    expect(summary(await agentList())).toEqual(["namespace:guard:on", "agent:mine:on"])
    const locked = await request("POST", "/operator/hook/state", project.path, {
      agent: "reviewer",
      name: "guard",
      off: true,
    })
    expect(locked.status).toBe(400)
    expect(locked.body.data.message).toContain("locked at namespace")
    // A locked hook can't be replaced by the agent either.
    expect(
      (
        await request("PUT", "/operator/hook", project.path, {
          agent: "reviewer",
          name: "guard",
          hook: { event: "tool.before", command: "x.sh" },
        })
      ).status,
    ).toBe(400)

    expect(
      (await request("POST", "/operator/hook/remove", project.path, { agent: "reviewer", name: "mine" })).body,
    ).toBe(true)
    expect(summary(await agentList())).toEqual(["namespace:guard:on"])
    const trash = (await request("GET", "/operator/trash", project.path)).body as Array<{
      id: string
      kind: string
      name: string
    }>
    const entry = trash.find((item) => item.kind === "hook" && item.name === "mine")!
    expect((await request("POST", `/operator/trash/${entry.id}/restore`, project.path)).status).toBe(200)
    expect(summary(await agentList())).toEqual(["namespace:guard:on", "agent:mine:on"])
  })

  test("a project that uses its namespace's config: the agent turns an inherited hook off, and on again", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await acme(folder.path, [project.path])
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), {
      hooks: { lint: hook("tool.after") },
      agent: { reviewer: { mode: "primary", description: "Reviews", prompt: "Review." } },
    })
    const off = await request("POST", "/operator/hook/state?confirmCopy=true", project.path, {
      agent: "reviewer",
      name: "lint",
      off: true,
    })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ state: "off", offAt: "agent" })
    const on = await request("POST", "/operator/hook/state?confirmCopy=true", project.path, {
      agent: "reviewer",
      name: "lint",
      off: false,
    })
    expect(on.body.state).toBe("on")
  })
})
