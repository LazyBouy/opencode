import { expect, test } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { tmpdir } from "../fixture/fixture"

// The fork's line in project/instance-store.ts (FORK.md): closing the store's scope while an instance is
// still loading (a shutdown; the HttpApi gate's teardown during worktree.create's background boot) used
// to hang, because the load was interrupted before it settled and disposeAll waits for every load.

const stuck = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.never }))

test("closing the store while an instance loads finishes, and the load's waiters are released", async () => {
  await using dir = await tmpdir({ git: true })
  const layer = LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, stuck],
  ])
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)
      const store = Context.get(context, InstanceStore.Service)
      const waiter = yield* store.load({ directory: dir.path }).pipe(Effect.exit, Effect.forkDetach)
      yield* Effect.sleep("300 millis")
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("10 seconds"), Effect.exit)
      return { closed, waited: yield* Fiber.await(waiter).pipe(Effect.timeout("5 seconds"), Effect.exit) }
    }),
  )
  expect(Exit.isSuccess(result.closed)).toBe(true)
  expect(Exit.isSuccess(result.waited)).toBe(true)
}, 30_000)
