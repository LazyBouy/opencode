import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorLayoutMove } from "@/operator/layout-move"
import { OperatorPathRewrite } from "@/operator/path-rewrite"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { replacements, root } from "../merge/harness"

// A move a stopped server left half done (global_and_opencode_namespaces_spec.md §11.3) is rolled back at
// the next start, from its journal: the folder goes back, and the stores it rewrote with it.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorLayoutMove.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const journal = (id: string, entry: Record<string, unknown>) =>
  Effect.promise(async () => {
    const folder = path.join(Global.Path.data, "operator", "moves")
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(
      path.join(folder, `${id}.json`),
      JSON.stringify({
        id,
        plan: { id: "mp_x", kind: "project", items: [] },
        startedAt: 1,
        entries: [
          { id: "mi_x", kind: "project", name: "site", namespace: "acme", sessions: 0, blockers: [], ...entry },
        ],
        report: { id, plan: "mp_x", status: "running", moved: [], skipped: [], byHand: [], startedAt: 1 },
      }),
    )
  })
const readJournal = (id: string) =>
  Effect.promise(async () =>
    JSON.parse(await fs.readFile(path.join(Global.Path.data, "operator", "moves", `${id}.json`), "utf8")),
  )
const exists = (file: string) =>
  Effect.promise(() =>
    fs
      .stat(file)
      .then(() => true)
      .catch(() => false),
  )

it.instance("a journal stopped after the rename and rewrite is rolled back: the folder and the stores go back", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const from = path.join(directory, "old", "site")
    const to = path.join(directory, "acme", "site")
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.mkdir(from, { recursive: true })
      await fs.writeFile(path.join(from, "README.md"), "site")
      await fs.rename(from, to)
    })
    // A store rewritten before the server stopped, with its backup.
    const store = path.join(Global.Path.data, "operator", "agent-permission-locks.json")
    const before = JSON.stringify({ [from]: { build: { locks: [], inherit: "own" } } })
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(store), { recursive: true })
      await fs.writeFile(store, before)
    })
    const undo = yield* Effect.promise(() => OperatorPathRewrite.rewrite("mv_stop", from, to, []))
    expect(yield* Effect.promise(() => fs.readFile(store, "utf8"))).toContain(to)
    yield* journal("mv_stop", { from, to, step: "rewriting", undo })

    yield* (yield* OperatorLayoutMove.Service).recover()
    expect(yield* exists(path.join(from, "README.md"))).toBe(true)
    expect(yield* exists(to)).toBe(false)
    expect(yield* Effect.promise(() => fs.readFile(store, "utf8"))).toBe(before)
    const after = yield* readJournal("mv_stop")
    expect(after.report.status).toBe("failed")
    expect(after.entries[0].step).toBe("rolled-back")
  }),
)

it.instance("a journal stopped while finishing is finished, not rolled back", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const to = path.join(directory, "acme", "site")
    yield* Effect.promise(() => fs.mkdir(to, { recursive: true }))
    yield* journal("mv_finish", { from: path.join(directory, "old", "site"), to, step: "finishing" })
    yield* (yield* OperatorLayoutMove.Service).recover()
    expect(yield* exists(to)).toBe(true)
    const after = yield* readJournal("mv_finish")
    expect(after.entries[0].step).toBe("done")
    expect(after.report.status).toBe("done")
  }),
)
