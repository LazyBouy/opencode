import fs from "fs/promises"
import path from "path"
import { OperatorFolders } from "@/operator/folders"
import { OperatorNamespaceScope } from "@/operator/namespace-scope"
import { OperatorProfile } from "@/operator/profile"
import { OperatorLayout } from "@/operator/layout"
import { OperatorMemoryDefaults } from "@/operator/memory-defaults"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjectCopy } from "@/operator/project-copy"
import { OperatorProjectSessions } from "@/operator/project-sessions"
import { OperatorProjectRecords } from "@/operator/project-records"
import { OperatorProjects } from "@/operator/projects"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { OperatorScopes } from "@/operator/scopes"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiProfileInvalidError, ApiProfileNotFoundError } from "../groups/namespaces"
import { OperatorRootApi } from "../groups/overview"

export const apiError = (error: OperatorProfileStore.InvalidError | OperatorProfileStore.NotFoundError) =>
  error._tag === "OperatorProfileInvalid"
    ? new ApiProfileInvalidError({ name: "OperatorProfileInvalidError", data: { message: error.message } })
    : new ApiProfileNotFoundError({ name: "OperatorProfileNotFoundError", data: { message: error.message } })

export const operatorNamespaceHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorNamespace", (handlers) =>
  Effect.gen(function* () {
    const store = yield* OperatorProfileStore.Service
    const folders = yield* OperatorFolders.Service
    const sessions = yield* OperatorProjectSessions.Service
    const instances = yield* InstanceStore.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    // A namespace's capabilities come from its folder: a project that moves, or a namespace whose folder
    // changes, reloads its loaded instances (each when none of its sessions is running).
    const reload = (target: { namespace: string } | { project: string }) =>
      Effect.forEach(OperatorNamespaceScope.instancesOf(target), (directory) => reloads.want({ directory }), {
        discard: true,
      })
    const done = Effect.as(true)
    const invalid = (message: string) =>
      new ApiProfileInvalidError({ name: "OperatorProfileInvalidError", data: { message } })

    return handlers
      .handle("list", () => store.namespaces())
      .handle("create", (ctx) =>
        store.createNamespace(ctx.payload).pipe(
          // Its memory lines (memory_spec.md §6.1), shown and editable in its Permissions. An adopted
          // folder keeps its .opencode as it is.
          Effect.tap((created) =>
            ctx.payload.adopt
              ? Effect.void
              : Effect.promise(() => OperatorMemoryDefaults.forNamespace(created.id).catch(() => false)),
          ),
          Effect.mapError(apiError),
        ),
      )
      .handle("folderPreview", (ctx) =>
        Effect.promise(() => OperatorProfileStore.namespacePreview(ctx.query.name)).pipe(
          Effect.flatMap((found) => ("error" in found ? Effect.fail(invalid(found.error!)) : Effect.succeed(found))),
        ),
      )
      .handle("get", (ctx) =>
        store.catalog(ctx.params.ns).pipe(
          Effect.map((catalog) => catalog.namespace),
          Effect.mapError(apiError),
        ),
      )
      .handle("update", (ctx) =>
        store.updateNamespace(ctx.params.ns, ctx.payload).pipe(
          Effect.tap(() =>
            ctx.payload.folder === undefined && ctx.payload.inheritGlobal === undefined
              ? Effect.void
              : reload({ namespace: ctx.params.ns }),
          ),
          Effect.mapError(apiError),
        ),
      )
      .handle("remove", (ctx) => store.removeNamespace(ctx.params.ns).pipe(done, Effect.mapError(apiError)))
      .handle("catalog", (ctx) => store.catalog(ctx.params.ns).pipe(Effect.mapError(apiError)))
      .handle("typeCreate", (ctx) =>
        store.saveType(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("typeUpdate", (ctx) =>
        store.saveType(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("typeRemove", (ctx) =>
        store.remove(ctx.params.ns, "type", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("layerCreate", (ctx) =>
        store.saveLayer(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("layerUpdate", (ctx) =>
        store.saveLayer(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("layerRemove", (ctx) =>
        store.remove(ctx.params.ns, "layer", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("layerCopy", (ctx) =>
        store.copyBuiltin(ctx.params.ns, ctx.params.id, ctx.payload.text).pipe(Effect.mapError(apiError)),
      )
      .handle("layerSync", (ctx) => store.syncLayer(ctx.params.ns, ctx.params.id).pipe(Effect.mapError(apiError)))
      .handle("groupCreate", (ctx) =>
        store.saveGroup(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("groupUpdate", (ctx) =>
        store.saveGroup(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("groupRemove", (ctx) =>
        store.remove(ctx.params.ns, "group", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("profileCreate", (ctx) =>
        store.saveProfile(ctx.params.ns, undefined, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("profileUpdate", (ctx) =>
        store.saveProfile(ctx.params.ns, ctx.params.id, ctx.payload).pipe(Effect.mapError(apiError)),
      )
      .handle("profileRemove", (ctx) =>
        store.remove(ctx.params.ns, "profile", ctx.params.id).pipe(done, Effect.mapError(apiError)),
      )
      .handle("copy", (ctx) =>
        store.copyTo(ctx.params.ns, ctx.payload.kind, ctx.payload.id, ctx.payload.target).pipe(
          Effect.map((copied) => ({ copied })),
          Effect.mapError(apiError),
        ),
      )
      .handle("projects", () => store.projects())
      .handle("projectResolve", (ctx) =>
        Effect.promise(async () => {
          const directory = path.resolve(ctx.query.directory)
          const project = await OperatorProjects.projectOf(directory)
          return { directory, ...(project ? { project } : {}) }
        }),
      )
      .handle("projectRegister", (ctx) =>
        Effect.gen(function* () {
          const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
          // A new project is made at <namespace folder>/<name> (§10.2); an existing folder is registered
          // where it is, and joins the namespace whose folder holds it (else OpenCode's, flagged).
          const made = ctx.payload.directory === undefined
          let git = ctx.payload.git === true
          let directory: string
          if (made) {
            const target = OperatorLayout.placeOf(ctx.payload.namespace ?? OperatorProfile.OPENCODE, layout)
            if (!target) return yield* invalid(`No namespace ${ctx.payload.namespace}`)
            const name = (ctx.payload.name ?? "").trim()
            const problem = target.global
              ? yield* Effect.promise(() => OperatorLayout.globalNameProblem(name))
              : !name || name.includes("/") || name.startsWith(".")
                ? `"${name}" isn't a folder name for a project`
                : undefined
            if (problem) return yield* invalid(problem)
            // Global's projects sit next to its config: a git repository stops upstream walking up into it.
            if (target.global) git = true
            directory = path.join(target.folder, name)
            if (
              yield* Effect.promise(() =>
                fs.stat(directory).then(
                  () => true,
                  () => false,
                ),
              )
            )
              return yield* invalid(`${directory} already exists`)
          } else directory = path.resolve(ctx.payload.directory!)
          const current = yield* Effect.promise(() => OperatorProjects.projectOf(directory))
          if (current?.git) return yield* invalid(`${directory} is already in the git repository ${current.key}`)
          if (current) return yield* invalid(`${directory} is already part of the project ${current.key}`)
          const source = ctx.payload.from ? path.resolve(ctx.payload.from) : undefined
          if (source && (yield* Effect.promise(() => OperatorProjects.projectOf(source)))?.key !== source)
            return yield* invalid(`${source} is not a project`)
          const from = source ? (yield* store.projects()).find((item) => item.key === source) : undefined
          const namespace =
            ctx.payload.namespace ?? from?.namespace ?? OperatorLayout.membership(directory, layout).namespace
          // Only inside the workspace roots, or Global's folder (global_and_opencode_namespaces_spec.md §4.3).
          const place = yield* Effect.promise(() => OperatorFolders.locate(directory))
          const global = OperatorScopes.classify(place.resolved, { projects: [], namespaces: [] }).kind === "global"
          if (!place.root && !global)
            return yield* invalid(`${place.resolved} is outside the workspace (${place.roots.join(", ")})`)
          yield* Effect.tryPromise({
            try: () => fs.mkdir(directory, { recursive: true }),
            catch: () => invalid(`${directory} cannot be created`),
          })
          if (git) yield* folders.init(directory).pipe(Effect.mapError((error) => invalid(error.message)))
          // Outside git, the project is its entry in projects.json; a git project gets one for a
          // namespace other than OpenCode, or for the prompt settings of the project it copies.
          const copied = source
            ? yield* Effect.gen(function* () {
                const settings = yield* store
                  .copyProject(source, directory, { namespace })
                  .pipe(Effect.mapError(apiError))
                const files = yield* Effect.promise(() => OperatorProjectCopy.copyFiles(source, directory))
                // Its record too: description, status, members, groups, manager.
                yield* Effect.promise(() => OperatorProjectRecords.copy(source, directory))
                return { files: files.copied, kept: files.kept, items: settings.copied, sessions: 0 }
              })
            : undefined
          if (!source && (!git || namespace !== OperatorProfile.OPENCODE))
            yield* store.setProject(directory, { namespace }).pipe(Effect.mapError(apiError))
          // An instance loaded before is reloaded with the folder's new project, agents and config.
          yield* instances.disposeDirectory(directory)
          if (copied && ctx.payload.sessions) copied.sessions = yield* sessions.copy(source!, directory)
          const listed = (yield* store.projects()).find((item) => item.key === directory)
          return {
            project: listed ?? { key: directory, name: path.basename(directory), namespace, registered: true },
            ...(copied ? { copied } : {}),
          }
        }),
      )
      .handle("folderMove", (ctx) =>
        Effect.gen(function* () {
          const directory = path.resolve(ctx.payload.directory)
          const target = path.resolve(ctx.payload.project)
          if (yield* Effect.promise(() => OperatorProjects.projectOf(directory)))
            return yield* invalid(`${directory} is part of a project already`)
          if ((yield* Effect.promise(() => OperatorProjects.projectOf(target)))?.key !== target)
            return yield* invalid(`${target} is not a project`)
          return yield* sessions.move(directory, target)
        }),
      )
      .handle("folderArchive", (ctx) =>
        Effect.gen(function* () {
          const directory = path.resolve(ctx.payload.directory)
          if (yield* Effect.promise(() => OperatorProjects.projectOf(directory)))
            return yield* invalid(`${directory} is part of a project already`)
          return { archived: yield* sessions.archive(directory) }
        }),
      )
      .handle("project", (ctx) =>
        store
          .setProject(ctx.payload.key, {
            namespace: ctx.payload.namespace,
            purpose: ctx.payload.purpose,
            defaultProfile: ctx.payload.defaultProfile,
            dryRun: ctx.payload.dryRun,
          })
          .pipe(
            Effect.tap(() =>
              ctx.payload.namespace === undefined || ctx.payload.dryRun
                ? Effect.void
                : reload({ project: ctx.payload.key }),
            ),
            Effect.mapError(apiError),
          ),
      )
  }),
)
