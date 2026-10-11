import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { OperatorConfig } from "@/operator/config"
import { OperatorLayout } from "@/operator/layout"
import { OperatorModels } from "@/operator/models"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjectConfig } from "@/operator/project-config"
import { OperatorProjects } from "@/operator/projects"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { OperatorSmallAgents } from "@/operator/small-agents"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiModelDefaultError, WriteInput } from "../groups/model-defaults"
import { OperatorRootApi } from "../groups/overview"
import { copyOr } from "../groups/project-config"

const fail = (message: string) => new ApiModelDefaultError({ name: "OperatorModelDefaultError", data: { message } })
const failConfig = (error: OperatorConfig.InvalidError) => fail(error.message)

export const operatorModelDefaultsHandlers = HttpApiBuilder.group(
  OperatorRootApi,
  "operatorModelDefaults",
  (handlers) =>
    Effect.gen(function* () {
      const models = yield* OperatorModels.Service
      const operatorConfig = yield* OperatorConfig.Service
      const instances = yield* InstanceStore.Service
      const store = yield* OperatorProfileStore.Service
      const reloads = yield* OperatorReloadWhenIdle.Service

      // Where a namespace's own values are computed (what OpenCode decides needs the connected providers): its
      // default project, else its own folder (an instance there is the namespace level; Global's folder for
      // Settings), else the server's folder.
      const folderOf = Effect.fnUntraced(function* (namespace?: string) {
        const project = yield* store.defaultProject(namespace ?? OperatorProfile.OPENCODE)
        if (project) return project
        const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
        const folder = namespace ? OperatorLayout.placeOf(namespace, layout)?.folder : Global.Path.config
        const there = folder
          ? yield* Effect.promise(() =>
              fs.stat(folder).then(
                (stat) => stat.isDirectory(),
                () => false,
              ),
            )
          : false
        return there ? folder! : process.cwd()
      })

      const exists = Effect.fnUntraced(function* (namespace: string) {
        const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
        const place = OperatorLayout.placeOf(namespace, layout)
        if (!place) return yield* fail(`No namespace ${namespace}`)
        return place
      })

      const nameOf = Effect.fnUntraced(function* (namespace: string) {
        return (yield* store.namespaces()).find((item) => item.namespace.id === namespace)?.namespace.name ?? namespace
      })

      // Agents on the small model follow it (small-agents.ts): those of the projects the write reaches (and
      // Global's, for Settings) get their `model` rewritten, before the projects reload.
      const syncSmall = Effect.fnUntraced(function* (projects: ReadonlyArray<string>, global: boolean) {
        const found = yield* Effect.promise(() => OperatorSmallAgents.holders(projects))
        const where = [...found.projects, ...(global && found.global ? [yield* folderOf()] : [])]
        for (const directory of new Set(where))
          yield* instances.provide({ directory }, OperatorSmallAgents.sync()).pipe(Effect.ignore)
      })

      const write = Effect.fnUntraced(function* (input: typeof WriteInput.Type) {
        const patch = { [input.key]: input.model }
        if (input.level === "settings") {
          const result = yield* instances
            .provide({ directory: yield* folderOf() }, operatorConfig.update("global", patch))
            .pipe(Effect.mapError(copyOr(failConfig)))
          if (!result.changed) return result
          yield* syncSmall(
            (yield* store.projects()).map((item) => item.key),
            true,
          )
          return { ...result, reload: yield* reloads.want("global") }
        }
        if (input.level === "namespace") {
          if (!input.namespace) return yield* fail("level namespace needs a namespace")
          const place = yield* exists(input.namespace)
          // Global's config is Settings (§3.3).
          if (place.global) return yield* fail("This namespace's config is Settings: set it in Settings → Models")
          const result = yield* instances
            .provide({ directory: yield* folderOf(place.id) }, operatorConfig.update("namespace", patch, place.id))
            .pipe(Effect.mapError(copyOr(failConfig)))
          if (!result.changed) return result
          yield* syncSmall(
            (yield* store.projects()).filter((item) => item.namespace === place.id).map((item) => item.key),
            false,
          )
          const reloaded = yield* Effect.forEach(
            OperatorNamespaceScope.instancesOf({ namespace: place.id }),
            (directory) => reloads.want({ directory }),
          )
          return { ...result, reload: reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const) }
        }
        if (!input.directory) return yield* fail("level project needs a directory")
        const project = yield* Effect.promise(() => OperatorProjects.projectOf(input.directory!))
        if (!project) return yield* fail(`${input.directory} is not part of a project`)
        const result = yield* instances
          .provide(
            { directory: project.key },
            operatorConfig.update("project", patch).pipe(OperatorProjectConfig.consent(input.confirmCopy)),
          )
          .pipe(Effect.mapError(copyOr(failConfig)))
        if (!result.changed) return result
        yield* syncSmall([project.key], false)
        const directories = new Set([project.key, ...OperatorNamespaceScope.instancesOf({ project: project.key })])
        const reloaded = yield* Effect.forEach([...directories], (directory) => reloads.want({ directory }))
        return { ...result, reload: reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const) }
      })

      return handlers
        .handle("namespace", (ctx) =>
          Effect.gen(function* () {
            const id = ctx.query.namespace ? (yield* exists(ctx.query.namespace)).id : undefined
            const found = yield* Effect.promise(() => OperatorModels.namespaceSources(id))
            const chain = yield* instances.provide(
              { directory: yield* folderOf(id) },
              models.chains(found.sources, found.targets),
            )
            return {
              ...(id ? { namespace: id, name: yield* nameOf(id) } : {}),
              settings: found.settings,
              path: found.targets.namespace ?? found.targets.settings,
              chain,
            }
          }),
        )
        .handle("write", (ctx) => write(ctx.payload))
        .handle("defaultFor", (ctx) =>
          Effect.gen(function* () {
            const model = ctx.query.model
            const settings = yield* Effect.promise(() => OperatorModels.namespaceSources())
            const own = settings.sources.filter((source) => source.level === "settings")
            const value = {
              model: OperatorModels.linksOf(own, "model", settings.targets).last,
              small: OperatorModels.linksOf(own, "small_model", settings.targets).last,
            }
            const namespaces = yield* Effect.forEach(
              (yield* store.namespaces()).filter((item) => !item.global),
              (item) =>
                Effect.promise(async () => {
                  const layer = await OperatorNamespaceScope.namespaceLayer(item.namespace.id)
                  if (!layer.target) return []
                  const found = await OperatorNamespaceScope.namespaceModels(layer.target)
                  const path = found.files.model ?? found.files.small_model
                  return path && (found.value.model === model || found.value.small_model === model)
                    ? [
                        {
                          id: item.namespace.id,
                          name: item.namespace.name,
                          model: found.value.model === model,
                          small: found.value.small_model === model,
                          path,
                        },
                      ]
                    : []
                }),
            )
            const projects = yield* Effect.forEach(yield* store.projects(), (item) =>
              Effect.promise(async () => {
                const found = await OperatorModels.projectModels(item.key)
                const path = found.files.model ?? found.files.small_model
                return path && (found.value.model === model || found.value.small_model === model)
                  ? [
                      {
                        key: item.key,
                        name: item.name,
                        namespace: item.namespace,
                        model: found.value.model === model,
                        small: found.value.small_model === model,
                        path,
                      },
                    ]
                  : []
              }),
            )
            const inSettings = value.model?.model === model || value.small?.model === model
            return {
              model,
              ...(inSettings
                ? {
                    settings: {
                      model: value.model?.model === model,
                      small: value.small?.model === model,
                      path: (value.model?.model === model ? value.model : value.small)!.path,
                    },
                  }
                : {}),
              namespaces: namespaces.flat(),
              projects: projects.flat(),
            }
          }),
        )
    }),
)
