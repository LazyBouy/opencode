import path from "path"
import { expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { OperatorHelperRuns } from "@/operator/helper-runs"
import { OperatorHelpers } from "@/operator/helpers"
import { OperatorHelperTexts } from "@/operator/helper-texts"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorRegistry } from "@/operator/registry"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { configure, replacements, root } from "../merge/harness"

// Roles (agent_types_spec.md §4.4, §4.6, §6): a namespace's helper takes over a built-in role (its text and model),
// one per role; a Dynamic layer can name the helper that writes it.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorProfileStore.node,
      OperatorHelpers.node,
      OperatorHelperRuns.node,
      OperatorHelperTexts.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

// The global config folder (where namespaces/ lives) inside the test project, for one test.
const withGlobal = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
        }),
    )
  })

// The test provider with a second model, for the role helpers to pick.
const twoModels = Effect.gen(function* () {
  const llm = yield* TestLLMServer
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
  return yield* configure({
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: { "test-model": model("test-model"), "test-model-2": model("test-model-2") },
        options: { apiKey: "test-key", baseURL: llm.url },
      },
    },
  })
})

// The request whose body holds `text` (title runs on its own fiber).
const request = (text: string) =>
  Effect.gen(function* () {
    const found = (yield* (yield* TestLLMServer).inputs).find((input) => JSON.stringify(input).includes(text))
    if (!found) return yield* Effect.fail("not yet")
    return found
  }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }), Effect.orDie)

const sendIn = (directory: string, text: string) =>
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    return yield* instances.provide(
      { directory },
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({})
        yield* (yield* SessionPrompt.Service).prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          parts: [{ type: "text", text }],
        })
        return session
      }),
    )
  })

unix("a Title-role helper in namespace Acme titles Acme's sessions; OpenCode's sessions keep OpenCode's title", () =>
  withGlobal(
    Effect.gen(function* () {
      const { directory, llm } = yield* twoModels
      const instances = yield* InstanceStore.Service
      for (let index = 0; index < 6; index++) yield* llm.text("A title")

      // In the OpenCode namespace: OpenCode's title prompt and model.
      yield* sendIn(directory, "opencode-hello")
      const opencode = yield* request("You are a title generator")
      expect(opencode.model).toBe("test-model")

      // Acme, the project's namespace now, with a Title-role helper of its own model.
      const store = yield* OperatorProfileStore.Service
      const acme = yield* store.createNamespace({ name: "Acme", folder: path.join(directory, "namespaces", "acme") })
      yield* store.setProject(directory, { namespace: acme.id })
      yield* (yield* OperatorHelpers.Service).create(acme.id, {
        name: "titler",
        model: { source: "pick", model: "test/test-model-2" },
        text: "ACME TITLES: one short line.",
        roles: ["title"],
      })
      yield* instances.disposeDirectory(directory)

      yield* sendIn(directory, "acme-hello")
      const titled = yield* request("ACME TITLES")
      expect(titled.model).toBe("test-model-2")
      expect(JSON.stringify(titled)).not.toContain("You are a title generator")
    }),
  ),
)

unix("a Dynamic layer naming a helper is written by it; such a helper may only read", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const helpers = yield* OperatorHelpers.Service
      const store = yield* OperatorProfileStore.Service
      yield* helpers.create("opencode", {
        name: "scribe",
        model: { source: "default" },
        text: "WRITE THE LAYER from the instructions.",
      })
      yield* helpers.create("opencode", { name: "doer", model: { source: "default" }, text: "x", actions: ["bash"] })

      // Only a helper that reads can write a layer.
      const refused = yield* store
        .saveLayer("opencode", undefined, {
          name: "Notes",
          type: OperatorProfile.DYNAMIC,
          text: "",
          prompt: "Say hello",
          writer: "doer",
        })
        .pipe(Effect.flip)
      expect(refused.message).toContain("may only read")
      const layer = yield* store.saveLayer("opencode", undefined, {
        name: "Notes",
        type: OperatorProfile.DYNAMIC,
        text: "",
        prompt: "Say hello",
        writer: "scribe",
      })
      expect(layer.writer).toBe("scribe")

      yield* llm.text("Written by the scribe.")
      const text = yield* (yield* OperatorHelperTexts.Service).sample(layer)
      expect(text).toBe("Written by the scribe.")
      expect(JSON.stringify((yield* llm.inputs).at(-1))).toContain("WRITE THE LAYER")
      const [run] = yield* (yield* OperatorHelperRuns.Service).runs("opencode", "scribe")
      expect(run?.startedBy).toMatchObject({ kind: "layer", layer: "Notes" })

      // While it writes the layer it can't declare more than reading, nor be deleted.
      expect((yield* helpers.update("opencode", "scribe", { actions: ["bash"] }).pipe(Effect.flip)).message).toContain(
        "may only declare read actions",
      )
      expect((yield* helpers.remove("opencode", "scribe").pipe(Effect.flip)).message).toContain("choose another writer")
    }),
  ),
)

unix("one helper per role in a namespace; a role helper has no actions; the built-in shows who replaced it", () =>
  withGlobal(
    Effect.gen(function* () {
      const { directory, llm } = yield* twoModels
      const helpers = yield* OperatorHelpers.Service
      const base = { model: { source: "default" as const }, text: "Draft a purpose." }
      expect(
        (yield* helpers
          .create("opencode", { ...base, name: "busy", roles: ["purpose-generator"], actions: ["read"] })
          .pipe(Effect.flip)).message,
      ).toContain("has no actions")
      yield* helpers.create("opencode", { ...base, name: "first", roles: ["purpose-generator"] })
      yield* helpers.create("opencode", {
        ...base,
        name: "second",
        roles: ["purpose-generator", "agent-generator"],
        model: { source: "pick", model: "test/test-model-2" },
      })
      const listed = yield* helpers.list("opencode")
      expect(listed.find((item) => item.name === "first")?.roles).toEqual([])
      expect(listed.find((item) => item.name === "second")?.roles).toEqual(["purpose-generator", "agent-generator"])
      expect(listed.find((item) => item.builtin && item.name === "purpose-generator")?.replacedBy).toBe("second")

      // The Purpose generator role: the helper drafts, and its run is recorded.
      yield* llm.text("To ship good tools.")
      expect(yield* (yield* OperatorHelperTexts.Service).purpose({ kind: "project" })).toBe("To ship good tools.")
      const [run] = yield* (yield* OperatorHelperRuns.Service).runs("opencode", "second")
      expect(run?.startedBy).toMatchObject({ kind: "role", role: "purpose-generator" })

      // The Agent generator role's model, for OpenCode's agent generator (agent/agent.ts).
      expect(
        yield* Effect.promise(() => OperatorRegistry.helpers.roleModel!({ directory, role: "agent-generator" })),
      ).toEqual({
        providerID: "test",
        modelID: "test-model-2",
      })
      expect(
        yield* Effect.promise(() => OperatorRegistry.helpers.roleModel!({ directory, role: "title" })),
      ).toBeUndefined()
    }),
  ),
)
