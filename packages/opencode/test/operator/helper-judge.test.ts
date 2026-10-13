import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorHelperRuns } from "@/operator/helper-runs"
import { OperatorHelperTexts } from "@/operator/helper-texts"
import { OperatorHelpers } from "@/operator/helpers"
import { OperatorModels } from "@/operator/models"
import { promptAudit } from "@/operator/plugins"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorPrompts } from "@/operator/prompts"
import { OperatorResolver } from "@/operator/resolver"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send } from "../merge/harness"

// The helper judge (dynamic_layer_resolution_spec.md §2.3, §5, §8): a Dynamic layer can let a helper of its namespace
// score the candidates its filter kept, 0 to 1 each, times a weight. It is asked at the session's first resolution
// and again only when the candidates change, never per turn; its scores show in the trace.

const resolver = (judge?: OperatorResolver.Judge): OperatorResolver.Resolver => ({
  sources: [
    { kind: "text", location: "a", name: "alpha", text: "A" },
    { kind: "text", location: "b", name: "beta", text: "B" },
    { kind: "text", location: "c", name: "gamma", text: "" },
  ],
  filter: [{ kind: "available", need: "text" }],
  score: [],
  ...(judge ? { judge } : {}),
  select: { policy: "one" },
  template: { item: "{name}: {text}", separator: "\n" },
})
const candidates: OperatorResolver.Candidate[] = [
  { source: 0, location: "a", text: "A", attributes: { name: "alpha" } },
  { source: 1, location: "b", text: "B", attributes: { name: "beta" } },
  { source: 2, location: "c", text: "", attributes: { name: "gamma" } },
]

describe("the judge in the pipeline", () => {
  test("its scores, times its weight, are a score part; it is asked only about what the filter kept", () => {
    const judge = { helper: "picker", weight: 2 }
    expect(OperatorResolver.toJudge(resolver(judge), candidates)).toEqual([0, 1])
    // Without scores the first source wins (order).
    expect(OperatorResolver.run(resolver(judge), candidates).text).toBe("alpha: A")
    const done = OperatorResolver.run(resolver(judge), candidates, {
      judged: new Map([
        [0, 0.2],
        [1, 0.9],
      ]),
      judge: { helper: "picker", status: "ran" },
    })
    expect(done.text).toBe("beta: B")
    expect(done.trace.judge).toEqual({ helper: "picker", status: "ran" })
    expect(done.trace.candidates[1]!.parts).toEqual([{ rule: "judge (picker)", points: 1.8 }])
    expect(done.trace.candidates[0]!.why).toBe("lost to beta (judge (picker))")
  })

  test("its reply is read as id: score lines or JSON, within 0–1", () => {
    expect([...OperatorHelperTexts.parseScores("1: 0.2\n2 = 0.9\n3) 1.5\n9: 0.5", 3)]).toEqual([
      [1, 0.2],
      [2, 0.9],
      [3, 1],
    ])
    expect([...OperatorHelperTexts.parseScores('Here: {"1": 0.4, "2": -1}', 2)]).toEqual([
      [1, 0.4],
      [2, 0],
    ])
    expect([...OperatorHelperTexts.parseScores("[0.3, 0.7]", 2)]).toEqual([
      [1, 0.3],
      [2, 0.7],
    ])
    expect([...OperatorHelperTexts.parseScores('[{"id": 2, "score": 0.5}]', 2)]).toEqual([[2, 0.5]])
    expect(OperatorHelperTexts.parseScores("no idea", 2).size).toBe(0)
  })
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorPrompts.node,
      OperatorProfileStore.node,
      OperatorModels.node,
      OperatorHelpers.node,
      OperatorHelperRuns.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const withGlobal = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        return previous
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
          promptAudit.listen = undefined
        }),
    )
  })

unix("a layer's judge runs once per session and per change of its candidates, never per turn", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const helpers = yield* OperatorHelpers.Service
      const prompts = yield* OperatorPrompts.Service
      const runs = yield* OperatorHelperRuns.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key

      // A judge only reads: one that may run bash is refused.
      yield* helpers.create("opencode", { name: "picker", model: { source: "default" }, text: "Judge." })
      yield* helpers.create("opencode", {
        name: "doer",
        model: { source: "default" },
        text: "Do.",
        actions: ["bash"],
      })
      const refused = yield* store
        .saveLayer("opencode", undefined, {
          name: "Picked",
          type: "dynamic",
          text: "",
          resolver: resolver({ helper: "doer", weight: 1 }),
        })
        .pipe(Effect.flip)
      expect(refused.message).toContain("may only read")

      const judge = { helper: "picker", weight: 1, instructions: "Prefer B." }
      const layer = yield* store.saveLayer("opencode", undefined, {
        name: "Picked",
        type: "dynamic",
        text: "",
        resolver: resolver(judge),
      })
      // While it judges a layer, the helper may not run bash, and isn't deleted.
      expect((yield* helpers.update("opencode", "picker", { actions: ["bash"] }).pipe(Effect.flip)).message).toContain(
        "judges the Dynamic layer",
      )
      expect((yield* helpers.remove("opencode", "picker").pipe(Effect.flip)).message).toContain("another judge")
      const opencode = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === OperatorProfile.OPENCODE_PROFILE)!
      const profile = yield* store.saveProfile("opencode", undefined, {
        name: "Judged",
        group: opencode.group,
        slots: { ...opencode.slots, dynamic: [...opencode.slots.dynamic!, layer.id] },
      })
      yield* store.setProject(key, { defaultProfile: profile.id })

      // The preview asks no model.
      const preview = yield* prompts.preview({ agent: "build" })
      expect(preview.sections.find((item) => item.layer === layer.id)?.text).toBe("alpha: A")

      // Test resolve asks it once for these candidates; its scores show in the trace.
      yield* llm.text("1: 0.1\n2: 0.9")
      const tested = yield* prompts.sample({ agent: "build", layer: layer.id })
      expect(tested.text).toBe("beta: B")
      expect(tested.resolution!.judge).toEqual({ helper: "picker", status: "ran" })
      expect(tested.resolution!.candidates[1]!.parts).toEqual([{ rule: "judge (picker)", points: 0.9 }])
      const again = yield* prompts.sample({ agent: "build", layer: layer.id })
      expect(again.resolution!.judge?.status).toBe("reused")
      const asked = String(
        ((yield* llm.inputs)[0] as { messages: Array<{ content: unknown }> }).messages.at(-1)!.content,
      )
      expect(asked).toContain("Prefer B.")
      expect(asked).toContain('<candidate id="2" name="beta" location="b">')
      expect(asked).not.toContain("gamma")

      // A session: asked at its first request, then reused on the next turn.
      const seen: string[] = []
      promptAudit.listen = (entry) => entry.agent === "build" && seen.push(entry.sent[0]!)
      yield* llm.text("1: 0.8\n2: 0.3")
      yield* llm.text("first")
      yield* llm.text("second")
      const chat = yield* (yield* Session.Service).create({ title: "Judged" })
      yield* send(chat.id, "hello", "build")
      yield* send(chat.id, "again", "build")
      expect(seen).toHaveLength(2)
      expect(seen[0]).toContain("alpha: A")
      expect(seen[1]).toBe(seen[0])
      const judgeRuns = (yield* runs.runs("opencode", "picker")).filter((run) => run.startedBy.kind === "layer")
      expect(judgeRuns).toHaveLength(2)
      expect(judgeRuns[0]!.startedBy).toMatchObject({ kind: "layer", layer: "Picked", sessionID: chat.id })

      // A changed candidate asks it again.
      yield* store.saveLayer("opencode", layer.id, {
        name: "Picked",
        type: "dynamic",
        text: "",
        resolver: {
          ...resolver(judge),
          sources: resolver(judge).sources.map((item) => (item.name === "gamma" ? { ...item, text: "G" } : item)),
        },
      })
      yield* llm.text("1: 0.1\n2: 0.1\n3: 0.9")
      yield* llm.text("third")
      yield* send(chat.id, "once more", "build")
      expect(seen[2]).toContain("gamma: G")
      expect((yield* runs.runs("opencode", "picker")).filter((run) => run.startedBy.kind === "layer")).toHaveLength(3)
    }),
  ),
)
