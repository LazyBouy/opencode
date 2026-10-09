import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { OperatorPermissionMarks } from "@/operator/permission-marks"
import { OperatorProjectConfig } from "@/operator/project-config"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// A project's config (global_and_opencode_namespaces_spec.md §6, §7): its own if it has one, else its
// namespace's; the first save from a project page copies the namespace's (after consent), and from then
// on the namespace's config doesn't reach it. Locked lines stay in the namespace's file.

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
  await fs.rm(path.join(store(), "project-config-copies.json"), { force: true })
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
  await write(
    path.join(store(), "projects.json"),
    JSON.stringify(Object.fromEntries(projects.map((key) => [key, { namespace: "acme" }]))),
  )
}

const call = (method: string, route: string, directory: string, body?: unknown) =>
  app().request(`${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
const json = async <T>(response: Response) => (await response.json()) as T

type Resolved = {
  mode: "own" | "namespace"
  file: string
  text: string
  copy?: { namespace: string; changedSince: boolean }
  ownFiles: string[]
}
const resolved = async (directory: string) => json<Resolved>(await call("GET", "/operator/config/resolved", directory))
const username = async (directory: string) => {
  await disposeAllInstances()
  return (await json<{ username?: string }>(await call("GET", "/config", directory))).username
}

const ACME = `// Acme's settings
{
  "username": "acme",
  "permission": { "bash": { "rm *": "deny", "git *": "allow" } }
}
`

describe("a project's config", () => {
  test("without its own, it uses its namespace's; with its own, the namespace's isn't merged", async () => {
    await using folder = await tmpdir()
    await using plain = await tmpdir({ git: true })
    await using own = await tmpdir({ git: true })
    await write(
      path.join(folder.path, ".opencode", "opencode.jsonc"),
      JSON.stringify({ username: "acme", theme: "acme" }),
    )
    await write(path.join(own.path, "opencode.json"), JSON.stringify({ username: "own" }))
    await acme(folder.path, [plain.path, own.path])
    expect(await username(plain.path)).toBe("acme")
    expect((await resolved(plain.path)).mode).toBe("namespace")
    // The own config is a full copy: Acme's theme doesn't reach it either.
    expect(await username(own.path)).toBe("own")
    const config = await json<{ theme?: string }>(await call("GET", "/config", own.path))
    expect(config.theme).toBeUndefined()
    expect(await resolved(own.path)).toMatchObject({ mode: "own", file: path.join(own.path, "opencode.json") })
  })

  test("the first save copies the namespace's config, after consent; the namespace's file is unchanged", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    const acmeFile = path.join(folder.path, ".opencode", "opencode.jsonc")
    await write(acmeFile, ACME)
    await acme(folder.path, [project.path])
    // Acme locks "bash rm *" and deletes webfetch for its projects.
    await OperatorPermissionMarks.writeNamespace("acme", {
      deleted: [{ permission: "webfetch", pattern: "*" }],
      locks: [{ permission: "bash", pattern: "rm *" }],
    })
    const before = await resolved(project.path)
    expect(before).toMatchObject({ mode: "namespace", file: acmeFile, text: ACME })

    // Without consent: refused, with what the copy would be.
    const text = before.text.replace('"username": "acme"', '"username": "mine"')
    const refused = await call("PUT", "/operator/config/project", project.path, { text })
    expect(refused.status).toBe(409)
    expect(await json<{ name: string; data: { file: string } }>(refused)).toMatchObject({
      name: "OperatorProjectConfigCopyNeededError",
      data: { file: path.join(project.path, ".opencode", "opencode.jsonc") },
    })
    expect(await Bun.file(path.join(project.path, ".opencode", "opencode.jsonc")).exists()).toBe(false)

    const saved = await call("PUT", "/operator/config/project?confirmCopy=true", project.path, { text })
    expect(saved.status).toBe(200)
    const copy = await fs.readFile(path.join(project.path, ".opencode", "opencode.jsonc"), "utf8")
    // Comments kept, the change applied, the locked line left in Acme's file.
    expect(copy).toContain("// Acme's settings")
    expect(copy).toContain('"username": "mine"')
    expect(copy).toContain('"git *": "allow"')
    expect(copy).not.toContain("rm *")
    expect(await fs.readFile(acmeFile, "utf8")).toBe(ACME)
    expect(await username(project.path)).toBe("mine")
    // Acme's deletion is the project's now.
    expect((await OperatorPermissionMarks.projectMarks(project.path)).deleted).toEqual([
      { permission: "webfetch", pattern: "*" },
    ])
    // Acme's locked line still applies, from Acme's file.
    const level = await json<{
      inherited: Array<{ permission: string; pattern: string; action: string; level: string }>
    }>(await call("GET", "/operator/permission/level/project", project.path))
    expect(level.inherited).toContainEqual(
      expect.objectContaining({ permission: "bash", pattern: "rm *", action: "deny", level: "namespace" }),
    )
    expect(level.inherited.some((line) => line.pattern === "git *" && line.level === "namespace")).toBe(false)

    // Recorded; "changed since" once Acme's config changes, which doesn't reach the project.
    expect(await resolved(project.path)).toMatchObject({
      mode: "own",
      copy: { namespace: "acme", changedSince: false },
    })
    await write(acmeFile, ACME.replace('"acme"', '"acme-2"'))
    expect((await resolved(project.path)).copy?.changedSince).toBe(true)
    expect(await username(project.path)).toBe("mine")
  })

  test("every project write is copy-on-write: a model picked for the project copies too", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), JSON.stringify({ username: "acme" }))
    await acme(folder.path, [project.path])
    const patch = (confirm: boolean) =>
      call("PATCH", `/operator/config?scope=project${confirm ? "&confirmCopy=true" : ""}`, project.path, {
        small_model: "opencode/tiny",
      })
    expect((await patch(false)).status).toBe(409)
    expect((await patch(true)).status).toBe(200)
    const copy = JSON.parse(await fs.readFile(path.join(project.path, ".opencode", "opencode.jsonc"), "utf8"))
    expect(copy).toMatchObject({ username: "acme", small_model: "opencode/tiny" })
    // From then on the project's own file is edited, without asking.
    expect((await patch(false)).status).toBe(200)
  })

  test("Use the namespace's config again: the project's config goes to Trash, and comes back from it", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), JSON.stringify({ username: "acme" }))
    await acme(folder.path, [project.path])
    await OperatorPermissionMarks.writeNamespace("acme", {
      deleted: [{ permission: "webfetch", pattern: "*" }],
      locks: [],
    })
    const text = JSON.stringify({ username: "mine" })
    expect((await call("PUT", "/operator/config/project?confirmCopy=true", project.path, { text })).status).toBe(200)
    expect(await username(project.path)).toBe("mine")

    const reverted = await call("POST", "/operator/config/project/revert", project.path)
    expect(reverted.status).toBe(200)
    const { trash } = await json<{ trash: string }>(reverted)
    expect(await Bun.file(path.join(project.path, ".opencode", "opencode.jsonc")).exists()).toBe(false)
    expect((await resolved(project.path)).mode).toBe("namespace")
    expect(await username(project.path)).toBe("acme")
    expect(await OperatorProjectConfig.copyOf(project.path)).toBeUndefined()
    expect((await OperatorPermissionMarks.projectMarks(project.path)).deleted).toEqual([])

    expect((await app().request(`/operator/trash/${trash}/restore`, { method: "POST" })).status).toBe(200)
    expect(await username(project.path)).toBe("mine")
    expect(await OperatorProjectConfig.copyOf(project.path)).toMatchObject({ namespace: "acme" })
    expect((await OperatorPermissionMarks.projectMarks(project.path)).deleted).toEqual([
      { permission: "webfetch", pattern: "*" },
    ])
    await fs.rm(path.join(OperatorTrashFiles.root(), trash), { recursive: true, force: true })
  })

  test("a file git tracks is edited but never removed", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await write(path.join(project.path, "opencode.json"), JSON.stringify({ username: "tracked" }))
    await Bun.$`git add opencode.json && git commit -qm config`.cwd(project.path).quiet()
    await acme(folder.path, [project.path])
    expect(await resolved(project.path)).toMatchObject({ mode: "own", tracked: true })
    const reverted = await call("POST", "/operator/config/project/revert", project.path)
    expect(reverted.status).toBe(400)
    expect(await Bun.file(path.join(project.path, "opencode.json")).exists()).toBe(true)
  })

  test("several own files: all are listed in merge order, the first of §7.1 is edited", async () => {
    await using folder = await tmpdir()
    await using project = await tmpdir({ git: true })
    await write(path.join(project.path, "opencode.json"), "{}")
    await write(path.join(project.path, ".opencode", "opencode.jsonc"), "{}")
    await write(path.join(project.path, "packages", "web", "opencode.json"), "{}")
    await acme(folder.path, [project.path])
    const found = await json<Resolved & { subfolderFiles: string[] }>(
      await call("GET", "/operator/config/resolved", project.path),
    )
    expect(found.file).toBe(path.join(project.path, ".opencode", "opencode.jsonc"))
    expect(found.ownFiles).toEqual([
      path.join(project.path, "opencode.json"),
      path.join(project.path, ".opencode", "opencode.jsonc"),
    ])
    expect(found.subfolderFiles).toEqual([path.join(project.path, "packages", "web", "opencode.json")])
  })
})

describe("a namespace's config", () => {
  test("edited in its own page; it reaches the projects that use it, not the ones with a copy", async () => {
    await using folder = await tmpdir()
    await using plain = await tmpdir({ git: true })
    await using own = await tmpdir({ git: true })
    await write(path.join(own.path, "opencode.json"), JSON.stringify({ username: "own" }))
    await acme(folder.path, [plain.path, own.path])
    const view = await json<{ exists: boolean; using: Array<{ project: string }>; own: Array<{ project: string }> }>(
      await app().request("/operator/namespace/acme/config"),
    )
    expect(view.exists).toBe(false)
    expect(view.using.map((item) => item.project)).toEqual([plain.path])
    expect(view.own.map((item) => item.project)).toEqual([own.path])
    const bad = await app().request("/operator/namespace/acme/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: '{ "username": 3 }' }),
    })
    expect(bad.status).toBe(400)
    const saved = await app().request("/operator/namespace/acme/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: '{ "username": "acme" }' }),
    })
    expect(saved.status).toBe(200)
    expect(await fs.readFile(path.join(folder.path, ".opencode", "opencode.jsonc"), "utf8")).toBe(
      '{ "username": "acme" }',
    )
    expect(await username(plain.path)).toBe("acme")
    expect(await username(own.path)).toBe("own")
  })

  test("Global's own config files are never a Global project's own (§6)", () => {
    const global = path.join(Global.Path.config, "opencode.jsonc")
    const project = path.join(Global.Path.config, "notes", "opencode.json")
    expect(OperatorNamespaceScope.projectFiles([global, project])).toEqual([project])
  })
})

describe("copies leave locked lines out", () => {
  test("a locked pattern, and a permission locked whole", () => {
    const text = `{
  // keep me
  "permission": { "bash": { "rm *": "deny", "git *": "allow" }, "webfetch": "deny", "edit": "ask" }
}`
    const out = OperatorProjectConfig.withoutLocked(text, [
      { permission: "bash", pattern: "rm *" },
      { permission: "webfetch", pattern: "*" },
    ])
    expect(out).toContain("// keep me")
    expect(out).toContain('"git *": "allow"')
    expect(out).toContain('"edit": "ask"')
    expect(out).not.toContain("rm *")
    expect(out).not.toContain("webfetch")
  })
})
