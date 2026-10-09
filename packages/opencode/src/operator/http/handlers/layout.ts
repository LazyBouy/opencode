import fs from "fs/promises"
import path from "path"
import { OperatorFolders } from "@/operator/folders"
import { OperatorLayout } from "@/operator/layout"
import { OperatorLayoutMove } from "@/operator/layout-move"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiLayoutError } from "../groups/layout"
import { OperatorRootApi } from "../groups/overview"

const fail = (message: string) => new ApiLayoutError({ name: "OperatorLayoutError", data: { message } })

// "Not now" on the upgrade's confirmation: until the server starts again (§12.3).
let later = false

// Whether the upgrade's confirmation waits (§12.2, §12.3): moves to make, not confirmed yet, not put off.
async function upgradeState(layout: OperatorLayout.Snapshot) {
  const settings = await OperatorLayout.readSettings()
  const projects = await OperatorProfileStore.readProjects()
  const found = OperatorLayout.upgradeItems(
    layout,
    Object.fromEntries(Object.entries(projects).map(([key, value]) => [key, value.namespace])),
  )
  // A blank working directory with other namespaces than OpenCode: one is asked for first.
  const others = layout.places.filter((place) => !place.global && place.id !== OperatorLayout.OPENCODE)
  const needsWorkingDir = layout.merged && others.length > 0
  const suggested = needsWorkingDir ? OperatorLayout.sharedParent(others.map((place) => place.folder)) : undefined
  const count = found.namespaces.length + found.projects.length
  return {
    waiting: !settings.upgradeDone && !later && (count > 0 || needsWorkingDir),
    namespaces: found.namespaces.length,
    projects: found.projects.length,
    needsWorkingDir,
    ...(suggested ? { suggested } : {}),
  }
}

export const operatorLayoutHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorLayout", (handlers) =>
  Effect.gen(function* () {
    const store = yield* OperatorProfileStore.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const moves = yield* OperatorLayoutMove.Service
    const moveError = (error: OperatorLayoutMove.MoveError) => fail(error.message)

    const view = Effect.fnUntraced(function* () {
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const summaries = yield* store.namespaces()
      const projects = yield* store.projects()
      return {
        ...(layout.workingDir ? { workingDir: layout.workingDir } : {}),
        merged: layout.merged,
        namespaces: summaries.map((item) => ({
          id: item.namespace.id,
          name: item.namespace.name,
          folder: item.namespace.folder ?? item.target,
          target: item.target,
          inPlace: item.inPlace,
          global: item.global,
          configFile: item.configFile,
          inheritGlobal: item.global || item.namespace.inheritGlobal !== false,
        })),
        flagged: projects.flatMap((item) =>
          item.flag ? [{ project: item.key, name: item.name, namespace: item.namespace, flag: item.flag }] : [],
        ),
        upgrade: yield* Effect.promise(() => upgradeState(layout)),
      }
    })

    return handlers
      .handle("plan", (ctx) => moves.plan(ctx.payload).pipe(Effect.mapError(moveError)))
      .handle("move", (ctx) => moves.move(ctx.payload).pipe(Effect.mapError(moveError)))
      .handle("report", (ctx) => moves.report(ctx.params.id).pipe(Effect.mapError(moveError)))
      .handle("later", () =>
        Effect.sync(() => {
          later = true
          return true
        }),
      )
      .handle("get", () => view())
      .handle("workingDir", (ctx) =>
        Effect.gen(function* () {
          const settings = yield* Effect.promise(() => OperatorLayout.readSettings())
          if (settings.workingDir)
            return yield* fail(
              `The working directory is ${settings.workingDir}. Changing it moves every namespace folder, which comes with Move.`,
            )
          const folder = ctx.payload.workingDir.trim()
          const problem = yield* Effect.promise(() =>
            OperatorLayout.workingDirProblem(folder, OperatorFolders.workspaceRoots()),
          )
          if (problem) return yield* fail(problem)
          const resolved = path.resolve(folder)
          yield* Effect.tryPromise({
            try: () => fs.mkdir(resolved, { recursive: true }),
            catch: () => fail(`${resolved} cannot be created`),
          })
          yield* Effect.promise(() => OperatorLayout.writeSettings({ ...settings, workingDir: resolved }))
          yield* Effect.promise(() => OperatorProfileStore.settleLayout())
          // Every project's namespace layer may change: they reload when idle.
          yield* reloads.want("global")
          return yield* view()
        }),
      )
  }),
)
