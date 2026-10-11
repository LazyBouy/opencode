import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { OperatorConfig } from "@/operator/config"
import { OperatorModels } from "@/operator/models"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjectConfig } from "@/operator/project-config"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { configure, replacements, root } from "../merge/harness"

// The default and small model's chain (default_models_spec.md §3, §6, §13.1): Settings → Namespace → Project
// → the environment, else OpenCode decides; copies leave the model keys out; a project with its own config
// still follows its namespace's model at run time.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([root, OperatorModels.node, OperatorProfileStore.node, OperatorConfig.node]),
    replacements,
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

// Global's folder inside the test project for one test, so Settings starts empty.
const withGlobal = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body(dir),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
        }),
    )
  })

// The environment variables that set config, for one block.
const withEnvironment = <A, E, R>(
  values: { config?: string; dir?: string; content?: string },
  body: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        config: Flag.OPENCODE_CONFIG,
        content: Flag.OPENCODE_CONFIG_CONTENT,
        dir: process.env.OPENCODE_CONFIG_DIR,
      }
      const flags = Flag as { OPENCODE_CONFIG?: string; OPENCODE_CONFIG_CONTENT?: string }
      flags.OPENCODE_CONFIG = values.config
      flags.OPENCODE_CONFIG_CONTENT = values.content
      if (values.dir) process.env.OPENCODE_CONFIG_DIR = values.dir
      else delete process.env.OPENCODE_CONFIG_DIR
      return previous
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        const flags = Flag as { OPENCODE_CONFIG?: string; OPENCODE_CONFIG_CONTENT?: string }
        flags.OPENCODE_CONFIG = previous.config
        flags.OPENCODE_CONFIG_CONTENT = previous.content
        if (previous.dir === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previous.dir
      }),
  )

// The project's own config: the test provider with two models, and `extra`.
const projectConfig = (directory: string, url: string, extra: Record<string, unknown> = {}) =>
  write(path.join(directory, "opencode.json"), configText(url, extra))
const configText = (url: string, extra: Record<string, unknown> = {}) => {
  const model = (id: string) => ({
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: "2025-01-01",
    limit: { context: 100000, output: 10000 },
    cost: { input: 0, output: 0 },
    options: {},
  })
  return JSON.stringify({
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: { "test-model": model("test-model"), "other-model": model("other-model") },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
    ...extra,
  })
}

const chain = Effect.gen(function* () {
  return (yield* (yield* OperatorModels.Service).defaults()).chain
})
const levels = (found: OperatorModels.Chain) =>
  found.levels.map((link) => [link.level, link.set ? link.model : "-", link.variable ?? "", link.overriddenBy ?? ""])

// A namespace with its own folder; the test project is assigned to it.
const acme = Effect.gen(function* () {
  const store = yield* OperatorProfileStore.Service
  const folder = path.join((yield* TestInstance).directory, "namespaces", "acme")
  const created = yield* store.createNamespace({ name: "Acme", folder })
  yield* store.setProject((yield* TestInstance).directory, { namespace: created.id })
  return { id: created.id, folder, config: path.join(folder, ".opencode", "opencode.jsonc") }
})

unix("the chain: Settings, the namespace, the project, each set or not; OpenCode decides when none is", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      yield* projectConfig(directory, llm.url)
      // A blank working directory: OpenCode is Global, so there's no namespace level; nothing sets a model.
      let found = yield* chain
      expect(found.model.levels.map((link) => link.level)).toEqual(["settings", "project"])
      expect(found.model.effective).toMatchObject({ from: "opencode", rule: "ranking" })
      expect(found.model.effective.model).toStartWith("test/")
      expect(found.model.inherited).toEqual(found.model.effective)
      expect(found.small.effective.from).toBe("opencode")

      // Settings sets it.
      yield* write(path.join(global, "opencode.jsonc"), JSON.stringify({ model: "test/test-model" }))
      found = yield* chain
      expect(found.model.effective).toEqual({ model: "test/test-model", from: "settings" })

      // A namespace of its own, which sets it, and then the project too.
      const ns = yield* acme
      found = yield* chain
      expect(found.model.levels.map((link) => link.level)).toEqual(["settings", "namespace", "project"])
      expect(found.model.effective.from).toBe("settings")
      yield* write(ns.config, JSON.stringify({ model: "test/other-model", small_model: "test/test-model" }))
      found = yield* chain
      expect(found.model.effective).toEqual({ model: "test/other-model", from: "namespace" })
      expect(found.small.effective).toEqual({ model: "test/test-model", from: "namespace" })
      yield* projectConfig(directory, llm.url, { model: "test/test-model" })
      found = yield* chain
      expect(levels(found.model)).toEqual([
        ["settings", "test/test-model", "", ""],
        ["namespace", "test/other-model", "", ""],
        ["project", "test/test-model", "", ""],
      ])
      expect(found.model.effective).toEqual({ model: "test/test-model", from: "project" })
      // Inherit (the picker's first option) would give the namespace's.
      expect(found.model.inherited).toEqual({ model: "test/other-model", from: "namespace" })
      // A model no connected provider offers is flagged.
      yield* projectConfig(directory, llm.url, { model: "test/missing" })
      expect((yield* chain).model.effective).toEqual({ model: "test/missing", from: "project", unavailable: true })
    }),
  ),
)

unix("the environment: OPENCODE_CONFIG before the project, OPENCODE_CONFIG_DIR and _CONTENT after it", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      yield* projectConfig(directory, llm.url, { model: "test/test-model" })
      yield* write(path.join(global, "opencode.jsonc"), JSON.stringify({ model: "test/test-model" }))
      const custom = path.join(directory, "env", "custom.json")
      yield* write(custom, JSON.stringify({ model: "test/other-model" }))
      // OPENCODE_CONFIG: the project still wins; Settings is overridden by it in turn.
      let found = yield* withEnvironment({ config: custom }, chain)
      expect(levels(found.model)).toEqual([
        ["settings", "test/test-model", "", ""],
        ["environment", "test/other-model", "OPENCODE_CONFIG", ""],
        ["project", "test/test-model", "", ""],
      ])
      expect(found.model.effective.from).toBe("project")
      // OPENCODE_CONFIG_CONTENT overrides even the project.
      found = yield* withEnvironment({ content: JSON.stringify({ model: "test/other-model" }) }, chain)
      expect(found.model.effective).toEqual({
        model: "test/other-model",
        from: "environment",
        variable: "OPENCODE_CONFIG_CONTENT",
      })
      expect(found.model.levels.find((link) => link.level === "project")?.overriddenBy).toBe("OPENCODE_CONFIG_CONTENT")
      expect(found.model.levels.find((link) => link.level === "settings")?.overriddenBy).toBe("OPENCODE_CONFIG_CONTENT")
      // OPENCODE_CONFIG_DIR, likewise.
      const dir = path.join(directory, "env", "dir")
      yield* write(path.join(dir, "opencode.json"), JSON.stringify({ small_model: "test/other-model" }))
      found = yield* withEnvironment({ dir }, chain)
      expect(found.small.effective).toEqual({
        model: "test/other-model",
        from: "environment",
        variable: "OPENCODE_CONFIG_DIR",
      })
    }),
  ),
)

unix("a copy leaves the model keys out, and the project keeps its namespace's model at run time", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      // The project starts on its namespace's config: no file of its own.
      yield* Effect.promise(() => fs.rm(path.join(directory, "opencode.json")))
      const ns = yield* acme
      yield* write(ns.config, configText(llm.url, { model: "test/other-model", username: "acme" }))
      const operatorConfig = yield* OperatorConfig.Service
      // A first write that isn't about models: the copy has the namespace's other keys, not its model.
      const written = yield* operatorConfig
        .update("project", { share: "disabled" })
        .pipe(OperatorProjectConfig.consent(true))
      const copy = JSON.parse(yield* read(written.path)) as Record<string, unknown>
      expect(copy.share).toBe("disabled")
      expect(copy.username).toBe("acme")
      expect(copy.provider).toBeDefined()
      expect("model" in copy).toBe(false)
      // The page reads it from the namespace…
      expect((yield* chain).model.effective).toEqual({ model: "test/other-model", from: "namespace" })
      // …and so does the loader: only the model keys, not the namespace's other keys.
      const config = yield* Config.Service
      yield* config.invalidate()
      const loaded = yield* config.get()
      expect(loaded.model).toBe("test/other-model")
      // A request with no model chosen uses it.
      yield* llm.text("ok")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "default model" })
      yield* (yield* SessionPrompt.Service).prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "which model" }],
      })
      const sent = yield* Effect.gen(function* () {
        const found = (yield* (yield* TestLLMServer).inputs).find((input) =>
          JSON.stringify(input).includes("which model"),
        )
        if (!found) return yield* Effect.fail("not yet")
        return found as Record<string, unknown>
      }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }), Effect.orDie)
      expect(sent.model).toBe("other-model")

      // Setting the project's model writes only its file; Inherit (null) removes it.
      const nsBefore = yield* read(ns.config)
      yield* operatorConfig.update("project", { model: "test/test-model" })
      expect(JSON.parse(yield* read(written.path)).model).toBe("test/test-model")
      expect(yield* read(ns.config)).toBe(nsBefore)
      expect((yield* chain).model.effective).toEqual({ model: "test/test-model", from: "project" })
      yield* operatorConfig.update("project", { model: null })
      expect("model" in JSON.parse(yield* read(written.path))).toBe(false)
      expect((yield* chain).model.effective.from).toBe("namespace")

      // The config file and the page are one: a hand edit shows as set for the project.
      yield* write(written.path, JSON.stringify({ ...copy, model: "test/test-model" }))
      expect((yield* chain).model.levels.find((link) => link.level === "project")).toMatchObject({
        set: true,
        model: "test/test-model",
        path: written.path,
      })
    }),
  ),
)

unix("a whole text saved from the Config page leaves the namespace's unchanged model out of the copy", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* configure()
      yield* Effect.promise(() => fs.rm(path.join(directory, "opencode.json")))
      const ns = yield* acme
      yield* write(ns.config, JSON.stringify({ model: "test/other-model", small_model: "test/test-model" }))
      const operatorConfig = yield* OperatorConfig.Service
      // The editor showed the namespace's text; the user changed the small model only.
      const written = yield* operatorConfig
        .write("project", JSON.stringify({ model: "test/other-model", small_model: "test/other-model" }))
        .pipe(OperatorProjectConfig.consent(true))
      expect(JSON.parse(yield* read(written.path))).toEqual({ small_model: "test/other-model" })
    }),
  ),
)
