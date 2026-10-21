import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorAgents } from "@/operator/agents"
import { OperatorConfig } from "@/operator/config"
import { OperatorHooks } from "@/operator/hooks/hooks"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { configure, replacements, root } from "../../merge/harness"

// SPEC-0022 §13: hooks fire on every tool call and model call. What an event costs with no hook for it, cold
// and warm, and one `sh` hook that prints nothing: the numbers are printed for the commit and the report.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorHooks.node, OperatorConfig.node, OperatorAgents.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const ROUNDS = 50
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>, times: number) =>
  Effect.gen(function* () {
    const start = performance.now()
    const first = yield* effect
    const cold = performance.now() - start
    const warmStart = performance.now()
    for (let index = 1; index < times; index++) yield* effect
    return { first, cold, warm: (performance.now() - warmStart) / (times - 1) }
  })

unix("an event with no hooks, and one sh hook that prints nothing", () =>
  Effect.gen(function* () {
    yield* configure({})
    const hooks = yield* OperatorHooks.Service
    const none = yield* timed(hooks.forEvent({ event: "tool.before", subject: "bash" }), ROUNDS)
    expect(none.first).toEqual([])

    const { directory } = yield* TestInstance
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "hooks"), { recursive: true })
      await fs.writeFile(path.join(directory, "hooks", "noop.sh"), "exit 0\n")
    })
    yield* configure({ hooks: { noop: { event: "tool.before", command: "hooks/noop.sh" } } })
    const found = yield* hooks.forEvent({ event: "tool.before", subject: "bash" })
    expect(found.map((item) => item.name)).toEqual(["noop"])
    const one = yield* timed(
      Effect.gen(function* () {
        const [hook] = yield* hooks.forEvent({ event: "tool.before", subject: "bash" })
        return yield* hooks.execute(
          hook!,
          { event: "tool.before", hook: "noop", level: "project", time: new Date().toISOString(), cwd: directory },
          { cwd: directory, sessionID: "ses_cost" },
        )
      }),
      10,
    )
    expect(one.first?.outcome).toBe("ok")
    console.log(
      `hooks: an event with no hook cold ${none.cold.toFixed(2)} ms, warm ${none.warm.toFixed(3)} ms; ` +
        `one sh hook printing nothing cold ${one.cold.toFixed(1)} ms, warm ${one.warm.toFixed(1)} ms`,
    )
  }),
)
