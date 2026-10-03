import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { OperatorConfig } from "@/operator/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([OperatorConfig.node, FSUtil.node])))

// Points the global config directory at a folder inside the test project for the duration of a test.
const withGlobalDirectory = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        return previous
      }),
      () => body(dir),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }),
    )
  })

const readText = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

it.instance("a project write creates .opencode/opencode.jsonc and lists it as a source", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const config = yield* OperatorConfig.Service

    const result = yield* config.update("project", { username: "operator" })
    const layers = yield* config.layers()

    expect(result).toEqual({ path: path.join(directory, ".opencode", "opencode.jsonc"), changed: true })
    expect(JSON.parse(yield* readText(result.path))).toEqual({ username: "operator" })
    expect(layers.targets.project).toBe(result.path)
    expect(layers.sources.findLast((source) => source.kind === "directory")?.path).toBe(result.path)
  }),
)

it.instance("a project write edits the existing project file, keeping comments, and null removes a key", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const file = path.join(directory, "opencode.jsonc")
    yield* Effect.promise(() =>
      fs.writeFile(
        file,
        '// settings for this repo\n{\n  // shown in the chat\n  "username": "before",\n  "share": "manual"\n}\n',
      ),
    )
    const config = yield* OperatorConfig.Service

    const result = yield* config.update("project", { share: null, username: "after" })

    expect(result.path).toBe(file)
    const written = yield* readText(file)
    expect(written).toContain("// settings for this repo")
    expect(written).toContain("// shown in the chat")
    expect(written).toContain('"username": "after"')
    expect(written).not.toContain("share")
  }),
)

it.instance("an invalid patch is rejected and nothing is written", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const config = yield* OperatorConfig.Service

    const exit = yield* config.update("project", { share: "sometimes" }).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(OperatorConfig.InvalidError)
      expect(String((error as OperatorConfig.InvalidError).message)).toContain("share")
    }
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, ".opencode", "opencode.jsonc")).exists())).toBe(
      false,
    )
  }),
)

it.instance("writing the value a file already has reports no change", () =>
  Effect.gen(function* () {
    const config = yield* OperatorConfig.Service
    yield* config.update("project", { username: "same" })

    expect((yield* config.update("project", { username: "same" })).changed).toBe(false)
  }),
)

it.instance("a global write goes to the global config file", () =>
  withGlobalDirectory((dir) =>
    Effect.gen(function* () {
      const config = yield* OperatorConfig.Service

      const result = yield* config.update("global", { merge: { adapters: { claude: { enabled: false } } } })
      const layers = yield* config.layers()

      expect(result.path).toBe(path.join(dir, "opencode.jsonc"))
      expect(JSON.parse(yield* readText(result.path))).toEqual({ merge: { adapters: { claude: { enabled: false } } } })
      expect(layers.sources.find((source) => source.kind === "global")?.path).toBe(result.path)
      expect(layers.targets.global).toBe(result.path)
    }),
  ),
)

it.instance("a raw write replaces the file after validating it", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const config = yield* OperatorConfig.Service
    const text = '{\n  // edited by hand\n  "username": "raw"\n}\n'

    const result = yield* config.write("project", text)
    expect(result).toEqual({ path: path.join(directory, ".opencode", "opencode.jsonc"), changed: true })
    expect(yield* readText(result.path)).toBe(text)

    const exit = yield* config.write("project", '{ "share": "sometimes" }').pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* readText(result.path)).toBe(text)
    const broken = yield* config.write("project", "{ not json").pipe(Effect.exit)
    expect(Exit.isFailure(broken)).toBe(true)
  }),
)

it.effect("the JSON schema describes the fork's config keys", () =>
  Effect.sync(() => {
    const schema = OperatorConfig.jsonSchema()
    const properties = schema.properties as Record<string, unknown>
    expect(properties.merge).toBeDefined()
    expect(properties.model).toBeDefined()
  }),
)
