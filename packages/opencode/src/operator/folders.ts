export * as OperatorFolders from "./folders"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

// Folders people can browse and create projects in: the workspace roots the server is given in
// OPENCODE_WORKSPACE_ROOTS (path-delimiter separated), or the user's home folder. In the Docker dev
// stack this is the mounted workspace, so new folders persist on the host.

export const Entry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  project: Schema.Boolean.annotate({ description: "A git repository, so OpenCode treats it as its own project" }),
}).annotate({ identifier: "OperatorFolderEntry" })

export const Listing = Schema.Struct({
  path: Schema.String,
  root: Schema.String.annotate({ description: "The workspace root this folder is in" }),
  parent: Schema.optional(Schema.String).annotate({ description: "The parent folder, when it is inside the root" }),
  project: Schema.Boolean,
  folders: Schema.Array(Entry),
}).annotate({ identifier: "OperatorFolderListing" })
export type Listing = typeof Listing.Type

export class OutsideError extends Schema.TaggedErrorClass<OutsideError>()("OperatorFolderOutside", {
  message: Schema.String,
}) {}
export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorFolderInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly roots: () => ReadonlyArray<string>
  readonly list: (folder?: string) => Effect.Effect<Listing, OutsideError | InvalidError>
  /** Creates `name` in `parent`, optionally as a git repository with an empty first commit. */
  readonly create: (input: {
    parent: string
    name: string
    git: boolean
  }) => Effect.Effect<string, OutsideError | InvalidError>
  /** Turns an existing folder into a git repository with an empty first commit. */
  readonly init: (folder: string) => Effect.Effect<string, OutsideError | InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorFolders") {}

export function workspaceRoots(env: string | undefined = process.env.OPENCODE_WORKSPACE_ROOTS) {
  const roots = (env ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item))
  return roots.length ? roots : [os.homedir()]
}

// The root that contains `folder`, if any. Paths are resolved first, so ".." cannot escape a root.
export function rootOf(roots: ReadonlyArray<string>, folder: string) {
  const resolved = path.resolve(folder)
  return roots.find(
    (root) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
  )
}

const NAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/

// Symlinks are followed before the check, so a link inside a root cannot reach outside it. A
// folder that does not exist yet is checked through its parent.
const real = (folder: string): Promise<string> =>
  fs.realpath(folder).catch(() => {
    const parent = path.dirname(folder)
    return parent === folder ? folder : real(parent).then((dir) => path.join(dir, path.basename(folder)))
  })

// A folder, resolved, with the workspace root it is in (none when it is outside them all).
export async function locate(folder: string) {
  const roots = await Promise.all(workspaceRoots().map(real))
  const resolved = await real(path.resolve(folder))
  return { resolved, root: rootOf(roots, resolved), roots }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const inside = Effect.fnUntraced(function* (folder: string) {
      const found = yield* Effect.promise(() => locate(folder))
      if (!found.root)
        return yield* new OutsideError({
          message: `${found.resolved} is outside the workspace (${found.roots.join(", ")})`,
        })
      return { resolved: found.resolved, root: found.root }
    })

    const isRepository = (folder: string) =>
      Effect.promise(() =>
        fs
          .stat(path.join(folder, ".git"))
          .then(() => true)
          .catch(() => false),
      )

    const git = (cwd: string, args: string[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }))
          const [stderr, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
            { concurrency: "unbounded" },
          )
          if (code !== 0) return yield* new InvalidError({ message: `git ${args[0]} failed: ${stderr.trim()}` })
        }),
      ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new InvalidError({ message: String(error) }))))

    // A repository needs a first commit to have a project identity; without one it would join the
    // shared project for folders outside git.
    const initialize = (folder: string) =>
      git(folder, ["init", "--quiet"]).pipe(
        Effect.andThen(
          git(folder, [
            "-c",
            "user.name=OpenCode",
            "-c",
            "user.email=opencode@localhost",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial commit",
          ]),
        ),
      )

    const list = Effect.fn("OperatorFolders.list")(function* (folder?: string) {
      const { resolved, root } = yield* inside(folder ?? workspaceRoots()[0]!)
      const entries = yield* Effect.tryPromise({
        try: () => fs.readdir(resolved, { withFileTypes: true }),
        catch: () => new InvalidError({ message: `${resolved} is not a readable folder` }),
      })
      const folders = yield* Effect.forEach(
        entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")),
        (entry) => {
          const child = path.join(resolved, entry.name)
          return isRepository(child).pipe(Effect.map((project) => ({ name: entry.name, path: child, project })))
        },
        { concurrency: 16 },
      )
      return {
        path: resolved,
        root,
        ...(resolved === root ? {} : { parent: path.dirname(resolved) }),
        project: yield* isRepository(resolved),
        folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
      }
    })

    const create = Effect.fn("OperatorFolders.create")(function* (input: {
      parent: string
      name: string
      git: boolean
    }) {
      const name = input.name.trim()
      if (!NAME.test(name)) return yield* new InvalidError({ message: `"${input.name}" is not a valid folder name` })
      const { resolved } = yield* inside(path.join(input.parent, name))
      yield* Effect.tryPromise({
        try: () => fs.mkdir(resolved),
        catch: (cause) =>
          new InvalidError({
            message: (cause as NodeJS.ErrnoException).code === "EEXIST" ? `${resolved} already exists` : String(cause),
          }),
      })
      if (input.git) yield* initialize(resolved)
      return resolved
    })

    const init = Effect.fn("OperatorFolders.init")(function* (folder: string) {
      const { resolved } = yield* inside(folder)
      if (yield* isRepository(resolved))
        return yield* new InvalidError({ message: `${resolved} is already a git repository` })
      yield* initialize(resolved)
      return resolved
    })

    return Service.of({ roots: () => workspaceRoots(), list, create, init })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [CrossSpawnSpawner.node] })
