import fs from "fs/promises"
import path from "path"
import { OperatorConfig } from "@/operator/config"
import { OperatorLayout } from "@/operator/layout"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjectConfig } from "@/operator/project-config"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
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
        .handle("save", (ctx) => save(ctx.params.id, ctx.payload.text))
    }),
)
