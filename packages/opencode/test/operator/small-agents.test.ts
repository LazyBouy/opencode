import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import matter from "gray-matter"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorAgents } from "@/operator/agents"
import { OperatorConfig } from "@/operator/config"
import { OperatorModels } from "@/operator/models"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorSmallAgentNotes } from "@/operator/small-agent-notes"
import { OperatorSmallAgents } from "@/operator/small-agents"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

// Agents on the small model (agent_form_spec.md §2.2): `modelSource: "small"` with the model it resolves to in
// `model`, rewritten when the small model in effect changes; a variant the new model lacks is cleared and noted.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([root, OperatorModels.node, OperatorProfileStore.node, OperatorConfig.node, OperatorAgents.node]),
    replacements,
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

const withGlobal = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        return previous
      }),
      () => body(dir),
      (previous) => Effect.sync(() => ((Global.Path as { config: string }).config = previous)),
    )
  })

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

unix("an agent on the small model follows it; a variant the new model lacks is cleared and noted", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      const projectConfig = (extra: Record<string, unknown>) =>
        write(
          path.join(directory, "opencode.json"),
          JSON.stringify({
            provider: {
              test: {
                name: "Test",
                id: "test",
                env: [],
                npm: "@ai-sdk/openai-compatible",
                models: { "test-model": model("test-model"), "other-model": model("other-model") },
                options: { apiKey: "test-key", baseURL: llm.url },
              },
            },
            ...extra,
          }),
        )
      yield* projectConfig({ small_model: "test/test-model" })
      const agents = yield* OperatorAgents.Service

      // Created on the small model: it gets the project's small model.
      const patch = yield* OperatorSmallAgents.fill("project", {
        modelSource: "small" as const,
        description: "Quick searches",
        variant: "high",
      })
      expect(patch.model).toBe("test/test-model")
      const file = yield* agents.create("project", "scout", patch)
      const read = () => Effect.promise(async () => matter(await fs.readFile(file, "utf8")).data)
      expect(yield* read()).toMatchObject({ modelSource: "small", model: "test/test-model", variant: "high" })
      expect((yield* Effect.promise(() => OperatorSmallAgents.holders([directory]))).projects).toEqual([directory])

      // The project's small model changes: the agent follows; the test models have no variants, so "high" goes.
      yield* projectConfig({ small_model: "test/other-model" })
      expect(yield* OperatorSmallAgents.sync()).toEqual(["scout"])
      const after = yield* read()
      expect(after).toMatchObject({ modelSource: "small", model: "test/other-model" })
      expect(after.variant).toBeUndefined()
      // Noted for the agent page (the agent list reads it once the project reloads).
      const notes = yield* Effect.promise(() => OperatorSmallAgentNotes.forProject(directory))
      expect(notes.scout).toMatchObject({ variant: "high", model: "test/other-model" })

      // Nothing changed: nothing is rewritten.
      expect(yield* OperatorSmallAgents.sync()).toEqual([])
    }),
  ),
)
