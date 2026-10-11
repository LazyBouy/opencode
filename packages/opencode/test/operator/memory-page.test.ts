import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorMemoryPage } from "@/operator/memory-page"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

// The Memory page's Memory tab (memory_spec.md §8): a project's three levels, and the user's edits with
// the memory tool's code.

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorMemoryPage.node]), replacements))

it.instance("the three levels; new, edit, MEMORY.md as text, and delete to Trash", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    const page = yield* OperatorMemoryPage.Service
    const empty = yield* page.levels()
    expect(empty.agent).toBe("build")
    expect(empty.instructions).toBe(true)
    expect(empty.limits).toEqual({ lines: 200, chars: 25_000 })
    expect(empty.levels.map((item) => [item.level, item.exists])).toEqual([
      ["namespace", expect.any(Boolean)],
      ["project", false],
      ["agent", false],
    ])
    expect(empty.levels[2]!.folder).toBe(path.join(directory, ".memory", "agents", "build"))

    const saved = yield* page.save({
      level: "project",
      title: "Release checklist",
      description: "Steps before tagging",
      content: "1. Run the tests",
    })
    expect(saved).toMatchObject({ file: "release-checklist.md", by: "user", content: "1. Run the tests" })
    const changed = yield* page.save({
      level: "project",
      file: "release-checklist.md",
      title: "Release checklist",
      description: "The steps before tagging a release",
      content: "1. Run the tests\n2. Tag",
    })
    expect(changed.description).toBe("The steps before tagging a release")
    expect((yield* page.entry({ level: "project", file: "release-checklist.md" })).content).toBe(
      "1. Run the tests\n2. Tag",
    )

    // By hand: a line that is not an entry is kept and flagged; a file no line names is listed.
    const folder = path.join(directory, ".memory")
    yield* Effect.promise(() => fs.writeFile(path.join(folder, "orphan.md"), "---\ntitle: Orphan\n---\n"))
    const level = yield* page.writeIndex({
      level: "project",
      text: "- [Release checklist](release-checklist.md) — The steps before tagging a release\nA note by hand",
    })
    expect(level.invalid).toEqual([{ line: 2, text: "A note by hand" }])
    expect(level.unindexed).toEqual(["orphan.md"])
    expect(level.entries[0]).toMatchObject({ title: "Release checklist", by: "user" })
    expect(level.lines).toBe(1)

    yield* page.forget({ level: "project", file: "release-checklist.md" })
    expect((yield* page.levels()).levels[1]!.entries).toEqual([])
    const trashed = yield* Effect.promise(() => OperatorTrashFiles.list())
    expect(trashed.some((entry) => entry.name === "Release checklist (project memory)")).toBe(true)

    // Refused: a file name that is a path; a title too long.
    expect(Exit.isFailure(yield* Effect.exit(page.entry({ level: "project", file: "../x.md" })))).toBe(true)
    const long = yield* Effect.exit(
      page.save({ level: "agent", title: "x".repeat(81), description: "d", content: "c" }),
    )
    expect(Exit.isFailure(long)).toBe(true)
  }),
)

it.instance("an agent's level is in its home when it has one", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure({ agent: { docs: { home: "agents/docs/" } } })
    const levels = yield* (yield* OperatorMemoryPage.Service).levels("docs")
    expect(levels.agent).toBe("docs")
    expect(levels.levels[2]!.folder).toBe(path.join(directory, "agents", "docs", ".memory"))
  }),
)
