import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { OperatorCapabilitySwitches } from "@/operator/capability-switches"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Capability scopes, phase 3 (capability_scopes_spec.md §5): a project accepts, overrides or disables
// an inherited capability, and Revert brings the inherited one back. The source never changes.

const app = () => Server.Default().app
const json = { "content-type": "application/json" }
const store = () => path.join(Global.Path.config, "namespaces")
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const command = (template: string) => `---\ndescription: Says hello\n---\n${template}\n`
const skill = (name: string) => `---\nname: ${name}\ndescription: Greets\n---\nGreet.\n`

const written: string[] = []
let projects = ""
afterEach(async () => {
  for (const file of written.splice(0)) await fs.rm(file, { force: true })
  await fs.writeFile(path.join(store(), "projects.json"), projects || "{}\n").catch(() => undefined)
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

const acme = async (folder: string, members: string[]) => {
  projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "")
  await write(
    path.join(store(), "acme", "namespace.json"),
    JSON.stringify({ id: "acme", name: "Acme", purpose: "", folder, createdAt: 1, updatedAt: 1 }),
  )
  const current = projects ? (JSON.parse(projects) as Record<string, unknown>) : {}
  await write(
    path.join(store(), "projects.json"),
    JSON.stringify({ ...current, ...Object.fromEntries(members.map((key) => [key, { namespace: "acme" }])) }),
  )
}

type Item = {
  kind: string
  name: string
  origin: string
  state: string
  location: string
  hides: Array<{ origin: string; location: string }>
  disabledAt?: { origin: string }
}
const where = (directory: string) => `?directory=${encodeURIComponent(directory)}`
const inventory = async (directory: string) =>
  ((await (await app().request(`/operator/capabilities${where(directory)}`)).json()) as { items: Item[] }).items
const find = async (directory: string, kind: string, name: string) =>
  (await inventory(directory)).find((item) => item.kind === kind && item.name === name)
const act = async (action: string, directory: string, kind: string, name: string) => {
  const response = await app().request(`/operator/capabilities/${action}${where(directory)}`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ kind, name }),
  })
  return { status: response.status, body: (await response.json()) as Item & { data?: { message: string } } }
}
// Changes reload the project in the background, right after the reply.
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 50 && !(await check()); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100))
}
const names = async (route: string, directory: string) =>
  ((await (await app().request(`${route}${where(directory)}`)).json()) as Array<{ name: string }>).map(
    (item) => item.name,
  )

describe("capabilities by scope", () => {
  test("each capability has its scope and state: local, inherited, overridden", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    const layer = path.join(folder.path, ".opencode")
    const global = path.join(Global.Path.config, "commands", "hello.md")
    await write(global, command("Global hello"))
    written.push(global)
    await write(path.join(layer, "commands", "hello.md"), command("Acme hello"))
    await write(path.join(layer, "commands", "acme-only.md"), command("Acme only"))
    await write(path.join(own.path, ".opencode", "commands", "hello.md"), command("Project hello"))
    await write(path.join(own.path, ".opencode", "commands", "mine.md"), command("Mine"))
    await acme(folder.path, [own.path])

    const hello = await find(own.path, "command", "hello")
    expect(hello).toMatchObject({ origin: "project", state: "overridden" })
    expect(hello!.hides.map((item) => item.origin)).toEqual(["global", "namespace"])
    expect(await find(own.path, "command", "acme-only")).toMatchObject({ origin: "namespace", state: "inherited" })
    expect(await find(own.path, "command", "mine")).toMatchObject({ origin: "project", state: "local" })
    expect(await find(own.path, "command", "init")).toMatchObject({ origin: "opencode", state: "inherited" })
    expect(await find(own.path, "tool", "read")).toMatchObject({ origin: "opencode" })

    // The namespace's own view: its layer over Global and OpenCode.
    const view = (await (await app().request(`/operator/capabilities${where(own.path)}&namespace=acme`)).json()) as {
      items: Item[]
    }
    expect(view.items.find((item) => item.kind === "command" && item.name === "hello")).toMatchObject({
      origin: "namespace",
      state: "overridden",
    })
    expect(view.items.some((item) => item.name === "mine")).toBe(false)
  })

  test("override copies the namespace's file into the project; revert moves the copy to Trash", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    const source = path.join(folder.path, ".opencode", "commands", "acme-only.md")
    await write(source, command("Acme only"))
    await acme(folder.path, [own.path])
    const before = await fs.readFile(source, "utf8")

    const overridden = await act("override", own.path, "command", "acme-only")
    expect(overridden.status).toBe(200)
    expect(overridden.body).toMatchObject({ origin: "project", state: "overridden" })
    const copy = path.join(own.path, ".opencode", "commands", "acme-only.md")
    expect(await fs.readFile(copy, "utf8")).toBe(before)
    expect((await act("override", own.path, "command", "acme-only")).status).toBe(400)

    const reverted = await act("revert", own.path, "command", "acme-only")
    expect(reverted.body).toMatchObject({ origin: "namespace", state: "inherited" })
    expect(await fs.stat(copy).catch(() => undefined)).toBeUndefined()
    expect(await fs.readFile(source, "utf8")).toBe(before)
  })

  test("disable uses each kind's switch, and revert removes it", async () => {
    await using folder = await tmpdir()
    await using own = await tmpdir({ git: true })
    const layer = path.join(folder.path, ".opencode")
    await write(path.join(layer, "commands", "acme-only.md"), command("Acme only"))
    await write(path.join(layer, "skills", "greet", "SKILL.md"), skill("greet"))
    await write(
      path.join(layer, "agents", "helperx.md"),
      "---\ndescription: Acme's helper\nmode: subagent\n---\nHelp.\n",
    )
    await write(
      path.join(layer, "opencode.jsonc"),
      JSON.stringify({ mcp: { docs: { type: "remote", url: "https://example.com/mcp", enabled: false } } }),
    )
    await acme(folder.path, [own.path])
    // A command: hidden from the project's command list.
    expect(await names("/command", own.path)).toContain("acme-only")
    // Read once loaded: OpenCode adds `$schema` to a config file it loads without one.
    const sourceFiles = await Promise.all(
      ["commands/acme-only.md", "skills/greet/SKILL.md", "agents/helperx.md", "opencode.jsonc"].map((file) =>
        fs.readFile(path.join(layer, file), "utf8"),
      ),
    )

    expect((await act("disable", own.path, "command", "acme-only")).body).toMatchObject({ state: "disabled" })
    await settle(async () => !(await names("/command", own.path)).includes("acme-only"))
    expect(await names("/command", own.path)).not.toContain("acme-only")

    // An agent: disable: true.
    expect((await act("disable", own.path, "agent", "helperx")).body).toMatchObject({ state: "disabled" })
    await settle(async () => !(await names("/agent", own.path)).includes("helperx"))
    expect(await names("/agent", own.path)).not.toContain("helperx")

    // A skill and a tool: a deny permission.
    expect((await act("disable", own.path, "skill", "greet")).body).toMatchObject({ state: "disabled" })
    expect((await act("disable", own.path, "tool", "webfetch")).body).toMatchObject({ state: "disabled" })
    // Written to the project's own config file.
    const config = parse(await fs.readFile(path.join(own.path, ".opencode", "opencode.jsonc"), "utf8")) as {
      permission?: Record<string, unknown>
      agent?: Record<string, { disable?: boolean }>
    }
    expect(config.permission).toMatchObject({ webfetch: "deny", skill: { greet: "deny" } })
    expect(config.agent).toEqual({ helperx: { disable: true } })
    expect(OperatorCapabilitySwitches.disabledList(config, "commands")).toEqual(["acme-only"])

    // Revert each: the inherited ones are back.
    for (const [kind, name] of [
      ["command", "acme-only"],
      ["agent", "helperx"],
      ["skill", "greet"],
      ["tool", "webfetch"],
    ] as const)
      expect((await act("revert", own.path, kind, name)).body.state).toBe("inherited")
    await settle(async () => (await names("/command", own.path)).includes("acme-only"))
    expect(await names("/command", own.path)).toContain("acme-only")
    expect(await names("/agent", own.path)).toContain("helperx")

    // The namespace's files never changed.
    expect(
      await Promise.all(
        ["commands/acme-only.md", "skills/greet/SKILL.md", "agents/helperx.md", "opencode.jsonc"].map((file) =>
          fs.readFile(path.join(layer, file), "utf8"),
        ),
      ),
    ).toEqual(sourceFiles)
  })

  test("/merge can't be turned off, and OpenCode's agents can't be copied", async () => {
    await using own = await tmpdir({ git: true })
    expect((await act("disable", own.path, "command", "merge")).status).toBe(400)
    expect((await act("override", own.path, "agent", "build")).status).toBe(400)
  })
})

describe("the fork's switches", () => {
  test("plugins are left out by package or file name, commands by name", () => {
    const config = {
      plugin: ["opencode-wakatime@1.2.3", "file:///work/.opencode/plugins/local-thing.ts", "keep-me"],
      plugin_origins: [
        { spec: "opencode-wakatime@1.2.3" },
        { spec: "file:///work/.opencode/plugins/local-thing.ts" },
        { spec: "keep-me" },
      ],
      capabilities: { disabled: { plugins: ["opencode-wakatime", "local-thing"], commands: ["hello"] } },
      command: { hello: { template: "Hi" }, other: { template: "Yo" } },
    }
    expect(OperatorCapabilitySwitches.withoutDisabledPlugins(config).plugin).toEqual(["keep-me"])
    expect(OperatorCapabilitySwitches.withoutDisabledPlugins(config).plugin_origins).toEqual([{ spec: "keep-me" }])
    OperatorCapabilitySwitches.removeDisabledCommands(config)
    expect(Object.keys(config.command)).toEqual(["other"])
  })
})
