import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// A namespace's and Global's effective config (global_and_opencode_namespaces_spec.md §8): loaded at the
// namespace's folder, which is the namespace level, never a project with a config of its own.

const app = () => Server.Default().app
const store = () => path.join(Global.Path.config, "namespaces")
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const written: string[] = []
const keep = { projects: undefined as string | undefined }

afterEach(async () => {
  for (const file of written.splice(0)) await fs.rm(file, { force: true })
  if (keep.projects !== undefined) await fs.writeFile(path.join(store(), "projects.json"), keep.projects)
  keep.projects = undefined
  await fs.rm(path.join(store(), "acme"), { recursive: true, force: true })
  // The route reads Global's config again when its files change; later tests must not keep this test's.
  await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate()))
  await disposeAllInstances()
  await resetDatabase()
})

const globalConfig = async (config: Record<string, unknown>) => {
  const file = path.join(Global.Path.config, "opencode.json")
  await write(file, JSON.stringify(config))
  written.push(file)
}

// Acme, with its folder and config.
const acme = async (folder: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  await write(
    path.join(store(), "acme", "namespace.json"),
    JSON.stringify({ id: "acme", name: "Acme", purpose: "", folder, createdAt: 1, updatedAt: 1, ...extra }),
  )
  await write(path.join(folder, ".opencode", "opencode.jsonc"), JSON.stringify(config))
}

type Effective = {
  id: string
  folder: string
  config: Record<string, unknown>
  sources: Array<{ kind: string; path: string; variable?: string }>
  origins: Record<string, string>
  variables?: Record<string, string>
}

const effective = async (id: string) => {
  const response = await app().request(`/operator/namespace/${id}/config/effective`)
  expect(response.status).toBe(200)
  return (await response.json()) as Effective
}

const GLOBAL = {
  username: "global-user",
  model: "opencode/big",
  command: { gjson: { template: "From global JSON" } },
  provider: { acme: { options: { apiKey: "sk-secret" } } },
}

describe("a namespace's effective config", () => {
  test("Global's base, then the namespace's own keys, which win; Global's capabilities while it inherits them", async () => {
    await using folder = await tmpdir()
    await globalConfig(GLOBAL)
    await acme(folder.path, { username: "acme", share: "disabled" })
    const found = await effective("acme")
    expect(found.folder).toBe(path.resolve(folder.path))
    expect(found.config.username).toBe("acme")
    expect(found.config.share).toBe("disabled")
    expect(found.config.model).toBe("opencode/big")
    expect(found.config.command).toMatchObject({ gjson: { template: "From global JSON" } })
    expect(found.origins).toMatchObject({
      username: "namespace",
      share: "namespace",
      model: "global",
      command: "global",
    })
    // Global's base first, the namespace's last; nothing of a project's.
    const kinds = found.sources.map((source) => source.kind)
    expect(kinds[0]).toBe("global")
    expect(kinds.at(-1)).toBe("namespace")
    expect(kinds.filter((kind) => kind === "project" || kind === "directory")).toEqual([])
    // Secrets are masked.
    expect(JSON.stringify(found.config)).not.toContain("sk-secret")
  })

  test("with inheritance off, Global's capability keys are left out and its other settings stay", async () => {
    await using folder = await tmpdir()
    await globalConfig(GLOBAL)
    await acme(folder.path, { username: "acme" }, { inheritGlobal: false })
    const found = await effective("acme")
    expect(found.config.command ?? {}).not.toHaveProperty("gjson")
    expect(found.config.model).toBe("opencode/big")
    expect(found.origins).not.toHaveProperty("command")
    expect(found.origins.model).toBe("global")
  })

  test("the environment's config is labelled with its variable", async () => {
    await using folder = await tmpdir()
    await using env = await tmpdir()
    await write(path.join(env.path, "opencode.json"), JSON.stringify({ username: "from-env" }))
    await acme(folder.path, { username: "acme" })
    const before = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = env.path
    try {
      const found = await effective("acme")
      // Loaded after the namespace's config, so it wins.
      expect(found.config.username).toBe("from-env")
      expect(found.origins.username).toBe("env")
      expect(found.variables?.username).toBe("OPENCODE_CONFIG_DIR")
      expect(found.sources.find((source) => source.kind === "env")).toMatchObject({ variable: "OPENCODE_CONFIG_DIR" })
    } finally {
      if (before === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = before
    }
  })

  test("Global shows Global's base only", async () => {
    await globalConfig(GLOBAL)
    const found = await effective("global")
    expect(found.folder).toBe(path.resolve(Global.Path.config))
    expect(found.config.username).toBe("global-user")
    expect(found.config.command).toMatchObject({ gjson: { template: "From global JSON" } })
    expect(found.sources.every((source) => source.kind === "global")).toBe(true)
  })

  test("the namespace's folder is the namespace level, never a project with a config of its own", async () => {
    await using folder = await tmpdir()
    await acme(folder.path, { username: "acme" })
    expect((await effective("acme")).config.username).toBe("acme")
    // Loading it there doesn't make it a project.
    const projects = (await (await app().request("/operator/project-settings")).json()) as Array<{ key: string }>
    expect(projects.map((item) => item.key)).not.toContain(path.resolve(folder.path))
    // Even registered as a project, the folder stays the namespace's: its `.opencode/opencode.jsonc` is the
    // namespace's config, merged as layer 2, not a project's own.
    keep.projects = await fs.readFile(path.join(store(), "projects.json"), "utf8").catch(() => "{}\n")
    await write(path.join(store(), "projects.json"), JSON.stringify({ [folder.path]: { namespace: "acme" } }))
    expect(await OperatorNamespaceScope.layerOf(folder.path)).toMatchObject({ namespace: "acme", atFolder: true })
    expect(
      await Effect.runPromise(OperatorNamespaceScope.configFiles({ directory: folder.path, worktree: "/" })),
    ).toEqual([
      path.join(folder.path, ".opencode", "opencode.json"),
      path.join(folder.path, ".opencode", "opencode.jsonc"),
    ])
  })

  test("a change to the namespace's or Global's file shows on the next read", async () => {
    await using folder = await tmpdir()
    await globalConfig({ model: "opencode/big" })
    await acme(folder.path, { username: "acme" })
    expect((await effective("acme")).config.username).toBe("acme")
    await write(path.join(folder.path, ".opencode", "opencode.jsonc"), JSON.stringify({ username: "acme-2" }))
    expect((await effective("acme")).config.username).toBe("acme-2")
    await globalConfig({ model: "opencode/small" })
    expect((await effective("acme")).config.model).toBe("opencode/small")
  })

  test("an unknown namespace is refused", async () => {
    const response = await app().request("/operator/namespace/nope/config/effective")
    expect(response.status).toBe(400)
  })
})
