import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorProfileStore } from "@/operator/profile-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

it.instance("lists built-in resources, OpenCode first among projects, and old files in place", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      yield* write(path.join(global, "prompts", "base.kimi.md"), "Kimi, be brief.\n")
      yield* write(path.join(global, "prompts", "not-a-text.md"), "ignored\n")
      yield* write(
        path.join(global, "identity", "company.md"),
        "---\nname: Company\nlayer: org\n---\nWe build editors.\n",
      )
      const store = yield* OperatorProfileStore.Service
      const catalog = yield* store.catalog()

      expect(catalog.projects[0]).toEqual({ key: "opencode", name: "OpenCode" })
      expect(catalog.profiles.map((item) => item.id)).toEqual(["default", "helper"])
      expect(catalog.layers.some((item) => item.id === "slot.base")).toBe(true)
      const kimi = catalog.layers.find((item) => item.overrides === "base.kimi")
      expect(kimi).toMatchObject({ origin: "file", projects: "*", section: "base", text: "Kimi, be brief." })
      expect(catalog.layers.some((item) => item.name === "not-a-text")).toBe(false)
      expect(catalog.layers.find((item) => item.name === "Company")).toMatchObject({
        section: "identity",
        origin: "file",
        path: path.join(global, "identity", "company.md"),
      })
    }),
  ),
)

it.instance("saves layers, groups, profiles and defaults as files, and refuses broken saves", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const role = yield* store.saveLayer(undefined, {
        name: "Reviewer",
        section: "role",
        projects: "*",
        text: "You review drafts.",
      })
      expect(role.id).toBe("reviewer")
      expect(yield* read(path.join(global, "profile", "layers", "reviewer.md"))).toContain("section: role")

      const group = yield* store.saveGroup(undefined, {
        name: "Review",
        type: "role",
        projects: "*",
        layers: ["reviewer"],
      })
      const profile = yield* store.saveProfile(undefined, {
        name: "Reviewing",
        projects: "*",
        groups: ["builtin.purpose", group.id, "builtin.identity"],
      })
      yield* store.saveDefaults({ global: profile.id, projects: {} })
      expect(JSON.parse(yield* read(path.join(global, "profile", "defaults.json")))).toEqual({
        global: "reviewing",
        projects: {},
      })

      const catalog = yield* store.catalog()
      expect(catalog.groups.find((item) => item.id === "review")?.layers).toEqual(["reviewer"])
      expect(catalog.defaults.global).toBe("reviewing")

      const refused = (effect: Effect.Effect<unknown, unknown>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error as { message: string }).message),
        )
      expect(yield* refused(store.removeLayer("reviewer"))).toContain("uses this layer")
      expect(yield* refused(store.removeGroup("review"))).toContain("uses this group")
      expect(yield* refused(store.removeProfile("reviewing"))).toContain("is a default")
      expect(
        yield* refused(store.saveGroup("builtin.role", { name: "x", type: "role", projects: "*", layers: [] })),
      ).toContain("Built-in groups")
      expect(
        yield* refused(
          store.saveLayer(undefined, {
            name: "Goal",
            section: "purpose",
            purpose: "goal",
            projects: ["opencode"],
            text: "x",
          }),
        ),
      ).toContain("Base Model Group")
      // A group change that would break a profile using it is refused.
      expect(
        yield* refused(store.saveGroup("review", { name: "Review", type: "identity", projects: "*", layers: [] })),
      ).toContain("Reviewing")
    }),
  ),
)

it.instance("an old file layer is written back to its file and is never deleted", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const file = path.join(global, "identity", "company.md")
      yield* write(file, "---\nname: Company\nlayer: org\npriority: 10\n---\nWe build editors.\n")
      const store = yield* OperatorProfileStore.Service
      const company = (yield* store.catalog()).layers.find((item) => item.path === file)!

      yield* store.saveLayer(company.id, {
        name: "Company",
        section: "identity",
        projects: "*",
        enabled: false,
        text: "We build fast editors.",
      })
      const text = yield* read(file)
      expect(text).toContain("layer: org")
      expect(text).toContain("enabled: false")
      expect(text).toContain("We build fast editors.")

      const moved = yield* store
        .saveLayer(company.id, { name: "Company", section: "identity", projects: ["/x"], text: "x" })
        .pipe(Effect.flip)
      expect(moved.message).toContain("its scope is where the file is")
      const removed = yield* store.removeLayer(company.id).pipe(Effect.flip)
      expect(removed.message).toContain("delete the file yourself")
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
    }),
  ),
)
