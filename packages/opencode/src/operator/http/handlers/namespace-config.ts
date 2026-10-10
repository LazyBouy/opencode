import fs from "fs/promises"
import path from "path"
import { Config } from "@/config/config"
import { OperatorConfig } from "@/operator/config"
import { OperatorLayout } from "@/operator/layout"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjectConfig } from "@/operator/project-config"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiNamespaceConfigError } from "../groups/namespace-config"
import { OperatorRootApi } from "../groups/overview"

const fail = (message: string, file = "") =>
  new ApiNamespaceConfigError({ name: "OperatorNamespaceConfigError", data: { message, path: file } })

export const operatorNamespaceConfigHandlers = HttpApiBuilder.group(
  OperatorRootApi,
  "operatorNamespaceConfig",
  (handlers) =>
    Effect.gen(function* () {
      const store = yield* OperatorProfileStore.Service
      const reloads = yield* OperatorReloadWhenIdle.Service
      const instances = yield* InstanceStore.Service
      const config = yield* Config.Service
      const operatorConfig = yield* OperatorConfig.Service

      const view = Effect.fnUntraced(function* (id: string) {
        const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
        if (!OperatorLayout.placeOf(id, layout)) return yield* fail(`No namespace ${id}`)
        const source = yield* Effect.promise(() => OperatorProjectConfig.namespaceConfig(id))
        const projects = (yield* store.projects()).filter((item) => item.namespace === source.id)
        const split = yield* Effect.promise(() =>
          Promise.all(
            projects.map(async (item) => ({
              project: item.key,
              name: item.name,
              own: (await OperatorNamespaceScope.ownConfigFiles(item.key)).length > 0,
            })),
          ),
        )
        const names = new Map((yield* store.namespaces()).map((item) => [item.namespace.id, item.namespace.name]))
        return {
          id: source.id,
          name: source.name,
          global: source.global,
          file: source.file,
          text: source.text ?? OperatorProjectConfig.emptyText(source.name),
          exists: source.text !== undefined,
          using: split.filter((item) => !item.own).map(({ project, name }) => ({ project, name })),
          own: split.filter((item) => item.own).map(({ project, name }) => ({ project, name })),
          inheriting: source.global
            ? layout.places
                .filter((place) => !place.global && place.inheritGlobal)
                .map((place) => names.get(place.id) ?? place.id)
            : [],
        }
      })

      // The config as loaded at the namespace's folder: an instance there is the namespace level
      // (namespace-scope.ts), so it gets Global's base, the namespace's config and the environment. It stays
      // loaded like a project's. A save reloads it only after the reply (and, for Global, only once no
      // session runs anywhere), so the files it was loaded from are compared with the files now, and it is
      // reloaded when they differ (unless a session runs in that very folder). Upstream keeps Global's
      // config read once for every instance: that read is dropped too (loaded instances keep theirs).
      const loadedFrom = new Map<string, string>()
      const effective = Effect.fnUntraced(function* (id: string) {
        const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
        const place = OperatorLayout.placeOf(id, layout)
        if (!place) return yield* fail(`No namespace ${id}`)
        const folder = yield* Effect.promise(() =>
          fs.stat(place.folder).then(
            (stat) => stat.isDirectory(),
            () => false,
          ),
        )
        if (!folder) return yield* fail(`The folder of ${place.id} doesn't exist: ${place.folder}`, place.folder)
        const read = instances.provide(
          { directory: place.folder },
          Effect.gen(function* () {
            const layers = yield* operatorConfig.layers(place.id)
            return { layers, loaded: yield* config.get() }
          }),
        )
        const signature = (sources: ReadonlyArray<OperatorConfig.Source>) =>
          JSON.stringify(sources.map((source) => [source.path, source.text]))
        const fresh = Effect.gen(function* () {
          if ((yield* reloads.runningIn(place.folder)).length) return false
          yield* config.invalidate()
          yield* instances.reload({ directory: place.folder })
          return true
        })
        // The first read loads it fresh (an instance someone else loaded there may be old).
        const known = loadedFrom.get(place.folder)
        if (known === undefined) yield* fresh
        let found = yield* read
        if (known !== undefined && known !== signature(found.layers.sources) && (yield* fresh)) found = yield* read
        loadedFrom.set(place.folder, signature(found.layers.sources))
        return {
          id: place.id,
          folder: place.folder,
          config: OperatorConfig.maskSecrets(found.loaded),
          sources: found.layers.sources,
          origins: found.layers.origins,
          variables: found.layers.variables,
        }
      })

      const save = Effect.fnUntraced(function* (id: string, text: string) {
        const before = yield* view(id)
        yield* OperatorConfig.validate(before.file, text).pipe(
          Effect.mapError((error) => fail(error.message, error.path)),
        )
        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(path.dirname(before.file), { recursive: true })
            await fs.writeFile(before.file, text)
          },
          catch: (error) => fail(error instanceof Error ? error.message : String(error), before.file),
        })
        // Global's config is the base under every project; a namespace's reaches its projects that use it.
        const reloaded = before.global
          ? [yield* reloads.want("global")]
          : yield* Effect.forEach(OperatorNamespaceScope.instancesOf({ namespace: before.id }), (directory) =>
              reloads.want({ directory }),
            )
        return {
          ...(yield* view(id)),
          reload: reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const),
        }
      })

      return handlers
        .handle("get", (ctx) => view(ctx.params.id))
        .handle("effective", (ctx) => effective(ctx.params.id))
        .handle("save", (ctx) => save(ctx.params.id, ctx.payload.text))
    }),
)
