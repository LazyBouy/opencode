import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorIdentity } from "@/operator/identity"
import { operatorPlugins } from "@/operator/plugins"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(OperatorIdentity.node))

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

it.instance("layers are ordered org, user, project, then by priority, and filtered per agent", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const project = path.join(directory, ".opencode")
      yield* layer(global, "voice.md", "---\nname: Voice\npriority: 20\n---\nBe brief.\n")
      yield* layer(global, "company.md", "---\nname: Company\nlayer: org\n---\nWe build editors.\n")
      yield* layer(global, "habits.md", "---\npriority: 10\n---\nRun tests first.\n")
      yield* layer(project, "repo.md", "---\nname: Repo\nagents: [build]\n---\nThis repo uses Bun.\n")
      yield* layer(project, "off.md", "---\nenabled: false\n---\nIgnored.\n")
      yield* layer(project, "long.md", "---\nmax_length: 5\n---\nABCDEFGHIJ\n")
      const identity = yield* OperatorIdentity.Service

      const layers = yield* identity.list()
      expect(layers.map((item) => [item.kind, item.name])).toEqual([
        ["org", "Company"],
        ["user", "habits"],
        ["user", "Voice"],
        ["project", "long"],
        ["project", "off"],
        ["project", "Repo"],
      ])
      expect(yield* identity.preview("build")).toBe(
        "We build editors.\n\nRun tests first.\n\nBe brief.\n\nABCDE\n\nThis repo uses Bun.",
      )
      expect(yield* identity.preview("plan")).toBe("We build editors.\n\nRun tests first.\n\nBe brief.\n\nABCDE")
    }),
  ),
)

it.instance("layers can be saved, reordered and deleted", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const identity = yield* OperatorIdentity.Service
      const first = yield* identity.save({ scope: "project", name: "Style guide", content: "Use tabs." })
      yield* identity.save({ scope: "project", name: "Testing", content: "Write tests.", priority: 5 })

      expect(first.path).toBe(path.join(directory, ".opencode", "identity", "style-guide.md"))
      expect((yield* identity.list()).map((item) => item.name)).toEqual(["Testing", "Style guide"])

      const reordered = yield* identity.reorder("project", ["style-guide.md", "testing.md"])
      expect(reordered.map((item) => [item.name, item.priority])).toEqual([
        ["Style guide", 10],
        ["Testing", 20],
      ])

      yield* identity.remove("project", "testing.md")
      expect((yield* identity.list()).map((item) => item.name)).toEqual(["Style guide"])
    }),
  ),
)

it.instance("the identity plugin puts the agent's layers first in its system prompt", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* layer(path.join(directory, ".opencode"), "repo.md", "---\nagents: [build]\n---\nThis repo uses Bun.\n")
      const hooks = yield* Effect.promise(() =>
        operatorPlugins[0]({ directory, worktree: directory } as Parameters<(typeof operatorPlugins)[0]>[0]),
      )
      const transform = hooks["experimental.chat.system.transform"]!
      const model = {} as Parameters<typeof transform>[0]["model"]

      const build = { system: ["Base prompt"] }
      yield* Effect.promise(() => transform({ model, agent: "build" }, build))
      const plan = { system: ["Base prompt"] }
      yield* Effect.promise(() => transform({ model, agent: "plan" }, plan))

      expect(build.system).toEqual(["This repo uses Bun.", "Base prompt"])
      expect(plan.system).toEqual(["Base prompt"])
    }),
  ),
)
