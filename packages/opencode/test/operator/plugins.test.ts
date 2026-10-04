import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorProfileStore } from "@/operator/profile-store"
import { operatorPlugins } from "@/operator/plugins"
import { OperatorPromptText } from "@/operator/prompt-text"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The prompt plugin on its own, called the way request preparation calls it.
const it = testEffect(LayerNode.compile(OperatorProfileStore.node))

// Points the global config folder inside the test project for the duration of a test.
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
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }),
    )
  })

const layer = (dir: string, file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, "identity"), { recursive: true })
    await fs.writeFile(path.join(dir, "identity", file), text)
  })

it.instance("the prompt plugin puts the agent's identity layers in its first system message", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* layer(global, "voice.md", "---\nagents: [build]\n---\nThis repo uses Bun.\n")
      const hooks = yield* Effect.promise(() =>
        operatorPlugins[0]({ directory, worktree: directory } as Parameters<(typeof operatorPlugins)[0]>[0]),
      )
      const transform = hooks["experimental.chat.system.transform"]!
      const model = { providerID: "test", api: { id: "test-model" } } as Parameters<typeof transform>[0]["model"]
      const parts = (native: boolean) => ({
        agent: { native },
        base: [],
        environment: [],
        instructions: [],
        extra: [],
      })
      const base = OperatorPromptText.BUILTINS.find((item) => item.id === "base.default")!.text

      const build = { system: ["ignored"] }
      yield* Effect.promise(() => transform({ model, agent: "build", parts: parts(true) }, build))
      const plan = { system: ["ignored"] }
      yield* Effect.promise(() => transform({ model, agent: "plan", parts: parts(true) }, plan))

      expect(build.system).toEqual([`${base}\nThis repo uses Bun.`])
      expect(plan.system).toEqual([base])
    }),
  ),
)

it.instance("identity layers from before profiles keep their order: org, user, then priority", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* layer(global, "voice.md", "---\nname: Voice\npriority: 20\n---\nBe brief.\n")
      yield* layer(global, "habits.md", "---\npriority: 10\n---\nRun tests first.\n")
      yield* layer(global, "off.md", "---\nenabled: false\n---\nIgnored.\n")
      const hooks = yield* Effect.promise(() =>
        operatorPlugins[0]({ directory, worktree: directory } as Parameters<(typeof operatorPlugins)[0]>[0]),
      )
      const transform = hooks["experimental.chat.system.transform"]!
      const model = { providerID: "test", api: { id: "test-model" } } as Parameters<typeof transform>[0]["model"]
      const output = { system: [] as string[] }
      yield* Effect.promise(() =>
        transform(
          {
            model,
            agent: "build",
            parts: { agent: { native: true }, base: [], environment: [], instructions: [], extra: [] },
          },
          output,
        ),
      )
      expect(output.system[0]).toEndWith("Run tests first.\nBe brief.")
    }),
  ),
)
