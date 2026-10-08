import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Capability scopes, phase 1 (capability_scopes_spec.md §4): a namespace's `.opencode` folder is a layer
// between the global config and the project. OpenCode → Global → Namespace → Project; the nearer wins.

const app = () => Server.Default().app
const read = async <T>(response: Response) => (await response.json()) as T
const store = () => path.join(Global.Path.config, "namespaces")
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const command = (template: string) => `---\ndescription: Says hello\n---\n${template}\n`
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Greets\n---\n${body}\n`

// Files written into the test run's global config folder, removed after each test.
const written: string[] = []
const global = async (relative: string, text: string) => {
  const file = path.join(Global.Path.config, relative)
  await write(file, text)
  written.push(file)
}
const keep = { projects: "", acme: false }

afterEach(async () => {
  for (const file of written.splice(0)) await fs.rm(file, { force: true })
  await fs.writeFile(path.join(store(), "projects.json"), keep.projects || "{}\n").catch(() => undefined)
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
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
  const current = keep.projects ? (JSON.parse(keep.projects) as Record<string, unknown>) : {}
  await write(
    path.join(store(), "projects.json"),
    JSON.stringify({ ...current, ...Object.fromEntries(projects.map((key) => [key, { namespace: "acme" }])) }),
  )
}

const get = async <T>(route: string, directory: string) =>
  read<T>(await app().request(`${route}?directory=${encodeURIComponent(directory)}`))

type Command = { name: string; template: string }
type Skill = { name: string; location: string }
type Agent = { name: string }

describe("the namespace layer", () => {
  test("commands, skills, agents and config: the project's win over the namespace's, the namespace's over global", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    await using plain = await tmpdir({ git: true })
    await using opencode = await tmpdir({ git: true })
    const layer = path.join(folder.path, ".opencode")
    await global("commands/hello.md", command("Global hello"))
    await write(path.join(layer, "commands", "hello.md"), command("Acme hello"))
    await write(path.join(layer, "skills", "greet", "SKILL.md"), skill("greet", "Acme greets."))
    await write(
      path.join(layer, "agents", "acme-helper.md"),
      "---\ndescription: Acme's helper\nmode: subagent\n---\nHelp.\n",
    )
    await write(path.join(layer, "opencode.jsonc"), JSON.stringify({ username: "acme" }))
    await write(path.join(own.path, ".opencode", "commands", "hello.md"), command("Project hello"))
    await write(path.join(own.path, ".opencode", "skills", "greet", "SKILL.md"), skill("greet", "The project greets."))
    await write(path.join(own.path, "opencode.json"), JSON.stringify({ username: "project" }))
    await acme(folder.path, [own.path, plain.path])

    const hello = async (directory: string) =>
      (await get<Command[]>("/command", directory)).find((item) => item.name === "hello")?.template.trim()
    expect(await hello(own.path)).toBe("Project hello")
    expect(await hello(plain.path)).toBe("Acme hello")
    expect(await hello(opencode.path)).toBe("Global hello")

    const greet = async (directory: string) =>
      (await get<Skill[]>("/skill", directory)).find((item) => item.name === "greet")?.location
    expect(await greet(own.path)).toBe(path.join(own.path, ".opencode", "skills", "greet", "SKILL.md"))
    expect(await greet(plain.path)).toBe(path.join(layer, "skills", "greet", "SKILL.md"))
    expect(await greet(opencode.path)).toBeUndefined()

    const agents = async (directory: string) => (await get<Agent[]>("/agent", directory)).map((item) => item.name)
    expect(await agents(plain.path)).toContain("acme-helper")
    expect(await agents(opencode.path)).not.toContain("acme-helper")

    const username = async (directory: string) => (await get<{ username?: string }>("/config", directory)).username
    expect(await username(own.path)).toBe("project")
    expect(await username(plain.path)).toBe("acme")
    expect(await username(opencode.path)).not.toBe("acme")
  })

  test("the same skill name in two scopes resolves the same way every time", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    const layer = path.join(folder.path, ".opencode")
    for (const name of ["a", "b", "c", "d", "e"])
      await write(path.join(layer, "skills", `greet-${name}`, "SKILL.md"), skill("greet", `Acme ${name}.`))
    await write(path.join(own.path, ".opencode", "skills", "greet", "SKILL.md"), skill("greet", "The project greets."))
    await acme(folder.path, [own.path])
    const seen = new Set<string>()
    for (let run = 0; run < 20; run++) {
      const found = (await get<Skill[]>("/skill", own.path)).find((item) => item.name === "greet")
      seen.add(found?.location ?? "")
      await disposeAllInstances()
    }
    expect([...seen]).toEqual([path.join(own.path, ".opencode", "skills", "greet", "SKILL.md")])
  })

  test("a namespace without a .opencode folder adds nothing", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    await acme(folder.path, [own.path])
    const before = (await get<Command[]>("/command", own.path)).map((item) => item.name).toSorted()
    await disposeAllInstances()
    expect(await fs.stat(path.join(folder.path, ".opencode")).catch(() => undefined)).toBeUndefined()
    expect((await get<Command[]>("/command", own.path)).map((item) => item.name).toSorted()).toEqual(before)
  })

  test("moving a project to another namespace reloads it with that namespace's capabilities", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    await write(path.join(folder.path, ".opencode", "commands", "acme-only.md"), command("Only in Acme"))
    await acme(folder.path, [])
    const names = async () => (await get<Command[]>("/command", own.path)).map((item) => item.name)
    expect(await names()).not.toContain("acme-only")
    const moved = await app().request("/operator/project-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: own.path, namespace: "acme" }),
    })
    expect(moved.status).toBe(200)
    // The reload runs in the background, right after the reply.
    for (let attempt = 0; attempt < 50 && !(await names()).includes("acme-only"); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await names()).toContain("acme-only")
  })
})
