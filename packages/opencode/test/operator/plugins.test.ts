import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { operatorPlugins } from "@/operator/plugins"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorPromptText } from "@/operator/prompt-text"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The prompt plugin on its own, called the way request preparation and the tool registry call it.
const it = testEffect(LayerNode.compile(OperatorProfileStore.node))
const P = OperatorProfile.PREFIX
const BASE = OperatorPromptText.BUILTINS.find((item) => item.id === "base.default")!.text

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

const hooks = Effect.fnUntraced(function* () {
  const { directory } = yield* TestInstance
  return yield* Effect.promise(() =>
    operatorPlugins[0]({ directory, worktree: directory } as Parameters<(typeof operatorPlugins)[0]>[0]),
  )
})
const parts = { agent: { native: true }, base: [], environment: ["<env/>"], instructions: [], extra: [] }
const model = { providerID: "test", api: { id: "test-model" } } as never

it.instance("the system prompt is rebuilt from the agent's profile, with the namespace's purpose first", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      yield* store.updateNamespace("opencode", { purpose: "We value care." })
      const transform = (yield* hooks())["experimental.chat.system.transform"]!
      const output = { system: [`${BASE}\n<env/>`] }
      yield* Effect.promise(() => transform({ model, agent: "build", parts }, output))
      expect(output.system).toEqual([`We value care.\n${BASE}\n<env/>`])
    }),
  ),
)

it.instance("a tool's description is the copy in the agent's profile, else OpenCode's", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const store = yield* OperatorProfileStore.Service
      const bash = yield* store.copyBuiltin("opencode", `${P}tool.bash`, "Run commands.")
      const spec = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === `${P}profile.spec`)!
      const profile = yield* store.saveProfile("opencode", undefined, {
        name: "Tools",
        group: spec.group,
        slots: { ...spec.slots, capabilities: [...spec.slots.capabilities!, bash.id] },
      })
      yield* store.setAgent(directory, "build", { profile: profile.id })
      const definition = (yield* hooks())["tool.definition"]!
      const build = { description: "Runs a command.", parameters: {} }
      yield* Effect.promise(() => definition({ toolID: "bash", agent: "build" }, build))
      const plan = { description: "Runs a command.", parameters: {} }
      yield* Effect.promise(() => definition({ toolID: "bash", agent: "plan" }, plan))
      expect(build.description).toBe("Run commands.")
      expect(plan.description).toBe("Runs a command.")
    }),
  ),
)
