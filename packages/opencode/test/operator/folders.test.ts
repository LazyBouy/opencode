import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorFolders } from "@/operator/folders"
import { Project } from "@/project/project"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([OperatorFolders.node, Project.node])))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

// Makes a folder inside the test project the only workspace root for the duration of a test.
const withRoot = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = path.join((yield* TestInstance).directory, "workspace")
    yield* Effect.promise(() => fs.mkdir(path.join(root, "existing", "nested"), { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(path.join(root, ".hidden")))
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.OPENCODE_WORKSPACE_ROOTS
        process.env.OPENCODE_WORKSPACE_ROOTS = root
        return previous
      }),
      () => body(root),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous
        }),
    )
  })

it.instance("roots come from OPENCODE_WORKSPACE_ROOTS", () =>
  Effect.sync(() => {
    expect(OperatorFolders.workspaceRoots(["/a", "/b/"].join(path.delimiter))).toEqual(["/a", "/b"])
    expect(OperatorFolders.workspaceRoots("")).toHaveLength(1)
    expect(OperatorFolders.rootOf(["/a"], "/a/b/../c")).toBe("/a")
    expect(OperatorFolders.rootOf(["/a"], "/a/../b")).toBeUndefined()
    expect(OperatorFolders.rootOf(["/a"], "/ab")).toBeUndefined()
  }),
)

it.instance("lists sub-folders of the root, without hidden ones", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const folders = yield* OperatorFolders.Service
      const listing = yield* folders.list()
      const realRoot = yield* Effect.promise(() => fs.realpath(root))

      expect(listing.path).toBe(realRoot)
      expect(listing.parent).toBeUndefined()
      expect(listing.folders.map((item) => item.name)).toEqual(["existing"])

      const nested = yield* folders.list(path.join(root, "existing"))
      expect(nested.parent).toBe(realRoot)
      expect(nested.folders.map((item) => item.name)).toEqual(["nested"])
    }),
  ),
)

it.instance("refuses folders outside the roots, including through ..", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const folders = yield* OperatorFolders.Service
      const outside = yield* Effect.exit(folders.list(path.join(root, "..")))
      expect(Exit.isFailure(outside)).toBe(true)
      const escape = yield* Effect.exit(folders.create({ parent: root, name: "..", git: false }))
      expect(Exit.isFailure(escape)).toBe(true)
      const slash = yield* Effect.exit(folders.create({ parent: root, name: "a/b", git: false }))
      expect(Exit.isFailure(slash)).toBe(true)
    }),
  ),
)

unix("refuses a symlink that points outside the roots", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const folders = yield* OperatorFolders.Service
      yield* Effect.promise(() => fs.symlink(path.dirname(root), path.join(root, "link")))
      const exit = yield* Effect.exit(folders.list(path.join(root, "link")))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  ),
)

unix("creates a git folder that is its own project", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const folders = yield* OperatorFolders.Service
      const created = yield* folders.create({ parent: root, name: "new-app", git: true })

      expect(created).toBe(path.join(yield* Effect.promise(() => fs.realpath(root)), "new-app"))
      expect((yield* folders.list()).folders.find((item) => item.name === "new-app")?.project).toBe(true)
      const project = yield* (yield* Project.Service).fromDirectory(created)
      expect(project.project.worktree).toBe(created)
      expect(project.project.id).not.toBe("global")

      const again = yield* Effect.exit(folders.create({ parent: root, name: "new-app", git: true }))
      expect(Exit.isFailure(again)).toBe(true)
    }),
  ),
)

unix("turns an existing folder into a git repository once", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const folders = yield* OperatorFolders.Service
      const target = path.join(root, "existing")
      yield* folders.init(target)
      expect((yield* folders.list(target)).project).toBe(true)
      const again = yield* Effect.exit(folders.init(target))
      expect(Exit.isFailure(again)).toBe(true)
    }),
  ),
)
