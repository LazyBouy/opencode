import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "@/operator/config"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { OperatorProjectConfig } from "@/operator/project-config"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import path from "path"
import { ApiOperatorConfigInvalidError } from "../groups/config"
import { copyOr } from "../groups/project-config"

const invalid = (message: string, file = "") =>
  new ApiOperatorConfigInvalidError({ name: "OperatorConfigInvalidError", data: { path: file, message } })

export const operatorConfigHandlers = HttpApiBuilder.group(InstanceHttpApi, "operatorConfig", (handlers) =>
  Effect.gen(function* () {
    const operatorConfig = yield* OperatorConfig.Service
    const reloads = yield* OperatorReloadWhenIdle.Service

    // Every instance of the project reloads when idle: its own config replaces its namespace's.
    const reloadProject = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const layer = yield* Effect.promise(() => OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree))
      const directories = new Set([ctx.directory, ...OperatorNamespaceScope.instancesOf({ project: layer.project })])
      const reloaded = yield* Effect.forEach([...directories], (directory) => reloads.want({ directory }))
      return reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const)
    })

    const apply = Effect.fnUntraced(function* (
      scope: OperatorConfig.WriteScope,
      write: Effect.Effect<
        typeof OperatorConfig.UpdateResult.Type,
        OperatorConfig.InvalidError | OperatorProjectConfig.CopyNeededError
      >,
      namespace?: string,
    ) {
      const result = yield* write.pipe(
        Effect.mapError(copyOr((error: OperatorConfig.InvalidError) => invalid(error.message, error.path))),
      )
      // The project (every project, for global config; the namespace's loaded projects, for its config)
      // reloads to read it when none of its sessions is running.
      if (!result.changed) return result
      if (scope === "namespace") {
        const id = yield* operatorConfig.namespaceOf(namespace)
        const reloaded = yield* Effect.forEach(OperatorNamespaceScope.instancesOf({ namespace: id }), (item) =>
          reloads.want({ directory: item }),
        )
        return { ...result, reload: reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const) }
      }
      if (scope === "global") return { ...result, reload: yield* reloads.want("global") }
      return { ...result, reload: yield* reloadProject() }
    })

    const resolved = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const found = yield* Effect.promise(() => OperatorProjectConfig.resolved(ctx))
      const subfolderFiles = yield* Effect.promise(() => OperatorProjectConfig.subfolderFiles(found.project))
      return { ...found, subfolderFiles }
    })

    // "Use the namespace's config again": the project's own files go to Trash (restorable).
    const revert = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const found = yield* Effect.promise(() => OperatorProjectConfig.resolved(ctx))
      if (found.mode !== "own") return yield* invalid("This project has no config of its own")
      for (const file of found.ownFiles)
        if (yield* Effect.promise(() => OperatorProjectConfig.tracked(file)))
          return yield* invalid(`git tracks ${file}: the console doesn't remove it`, file)
      const copy = yield* Effect.promise(() => OperatorProjectConfig.copyOf(found.project))
      const entry = yield* Effect.promise(() =>
        OperatorTrashFiles.put({
          kind: "config",
          name: `${path.basename(found.project)} config`,
          project: found.project,
          paths: found.ownFiles,
          ...(copy ? { copy } : {}),
        }),
      )
      yield* Effect.promise(async () => {
        await OperatorProjectConfig.takeBack(found.project, copy)
        await OperatorProjectConfig.removeCopy(found.project)
      })
      return { trash: entry.id, reload: yield* reloadProject() }
    })

    const compare = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const found = yield* Effect.promise(() => OperatorProjectConfig.resolved(ctx))
      const namespace = yield* Effect.promise(() => OperatorProjectConfig.namespaceConfig(found.namespace.id))
      return {
        project: {
          file: found.mode === "own" ? found.file : found.target,
          text: found.mode === "own" ? found.text : "",
        },
        namespace: { id: namespace.id, name: namespace.name, file: namespace.file, text: namespace.text ?? "" },
      }
    })

    return handlers
      .handle("layers", (ctx) => operatorConfig.layers(ctx.query.namespace))
      .handle("update", (ctx) =>
        apply(
          ctx.query.scope,
          operatorConfig.update(ctx.query.scope, ctx.payload, ctx.query.namespace),
          ctx.query.namespace,
        ).pipe(OperatorProjectConfig.consent(ctx.query.confirmCopy)),
      )
      .handle("schema", () => Effect.sync(() => OperatorConfig.jsonSchema()))
      .handle("resolved", () => resolved())
      .handle("project", (ctx) =>
        apply("project", operatorConfig.write("project", ctx.payload.text)).pipe(
          OperatorProjectConfig.consent(ctx.query.confirmCopy),
        ),
      )
      .handle("revert", () => revert())
      .handle("compare", () => compare())
  }),
)
