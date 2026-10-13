import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { MergeAdapterRegistry } from "@/merge/adapter/registry"
import { OperatorFolders } from "@/operator/folders"
import { OperatorLayout } from "@/operator/layout"
import { OperatorOnboarding } from "@/operator/onboarding"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjects } from "@/operator/projects"
import { OperatorReloadWhenIdle } from "@/operator/reload-when-idle"
import { Project } from "@/project/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiOnboardingError } from "../groups/onboarding"
import { OperatorRootApi } from "../groups/overview"

const fail = (message: string) => new ApiOnboardingError({ name: "OperatorOnboardingError", data: { message } })

// The folders onboarding would make, and what stops it (memory_spec.md §10).
async function preview(input: { workingDir: string; project: string }) {
  const settings = await OperatorLayout.readSettings()
  const made = OperatorOnboarding.folders(input.workingDir, input.project)
  const problems: string[] = []
  const state = await OperatorOnboarding.read()
  if (!state) problems.push("This installation isn't waiting for onboarding: it was set up before onboarding came.")
  else if ("done" in state) problems.push(`Onboarding ran already, with the working folder ${state.workingDir}.`)
  // Set while onboarding waited (Settings → Namespaces): it stays, and onboarding uses it.
  if (settings.workingDir) {
    if (path.resolve(settings.workingDir) !== made.workingDir)
      problems.push(
        `The working folder is ${settings.workingDir} already. Changing it moves every namespace folder: Settings → Namespaces.`,
      )
  } else {
    const problem = await OperatorLayout.workingDirProblem(input.workingDir.trim(), OperatorFolders.workspaceRoots())
    if (problem) problems.push(problem)
  }
  const name = OperatorOnboarding.projectNameProblem(input.project)
  if (name) problems.push(name)
  const stat = name ? undefined : await fs.stat(made.project).catch(() => undefined)
  if (stat && !stat.isDirectory()) problems.push(`${made.project} is a file`)
  if (stat?.isDirectory()) {
    const current = await OperatorProjects.projectOf(made.project)
    if (current && current.key !== made.project) problems.push(`${made.project} is part of the project ${current.key}`)
  }
  return {
    workingDir: made.workingDir,
    opencodeFolder: made.opencode,
    projectFolder: made.project,
    projectExists: stat?.isDirectory() ?? false,
    problems,
    separateFileSystems: !(await OperatorOnboarding.sameFileSystem(Global.Path.config, made.workingDir)),
  }
}

export const operatorOnboardingHandlers = HttpApiBuilder.group(OperatorRootApi, "operatorOnboarding", (handlers) =>
  Effect.gen(function* () {
    // The store's start settles the namespace store, which marks a new installation pending.
    const store = yield* OperatorProfileStore.Service
    const folders = yield* OperatorFolders.Service
    const reloads = yield* OperatorReloadWhenIdle.Service
    const adapters = yield* MergeAdapterRegistry.Service
    const projects = yield* Project.Service

    return handlers
      .handle("status", () =>
        Effect.gen(function* () {
          const state = yield* Effect.promise(() => OperatorOnboarding.read())
          const settings = yield* Effect.promise(() => OperatorLayout.readSettings())
          const roots = OperatorFolders.workspaceRoots()
          const suggested = settings.workingDir || (yield* Effect.promise(() => OperatorOnboarding.suggested(roots)))
          // Merged agents keep records per working folder (Claude Code's transcripts): a move updates them only
          // where the server can reach them, which in production is the home folder.
          const agents = yield* Effect.forEach(
            adapters
              .list()
              .flatMap((adapter) => (adapter.relocator ? [{ adapter, relocator: adapter.relocator }] : [])),
            ({ adapter, relocator }) =>
              relocator.check(suggested, process.env).pipe(
                Effect.flatMap((check) =>
                  Effect.promise(async () => ({
                    id: adapter.id,
                    name: adapter.name,
                    folder: check.root,
                    exists: await fs.stat(check.root).then(
                      () => true,
                      () => false,
                    ),
                    insideHome: OperatorOnboarding.insideHome(check.root),
                  })),
                ),
              ),
          )
          return {
            pending: state !== undefined && "pending" in state,
            ...(state && "done" in state
              ? { done: { at: state.at, workingDir: state.workingDir, project: state.project } }
              : {}),
            ...(settings.workingDir ? { workingDir: settings.workingDir } : {}),
            suggested,
            project: OperatorOnboarding.DEFAULT_PROJECT,
            home: OperatorOnboarding.home(),
            roots,
            globalFolder: Global.Path.config,
            agents,
          }
        }),
      )
      .handle("check", (ctx) => Effect.promise(() => preview(ctx.payload)))
      .handle("finish", (ctx) =>
        Effect.gen(function* () {
          const checked = yield* Effect.promise(() => preview(ctx.payload))
          if (checked.problems.length) return yield* fail(checked.problems.join(" "))
          const git = ctx.payload.git !== false
          const made = (folder: string) =>
            Effect.tryPromise({
              try: () => fs.mkdir(folder, { recursive: true }),
              catch: () => fail(`${folder} cannot be created`),
            })
          // The working folder: Global and OpenCode become separate namespaces, OpenCode's at <it>/opencode.
          yield* made(checked.opencodeFolder)
          const settings = yield* Effect.promise(() => OperatorLayout.readSettings())
          if (!settings.workingDir) {
            yield* Effect.promise(() => OperatorLayout.writeSettings({ ...settings, workingDir: checked.workingDir }))
            yield* Effect.promise(() => OperatorProfileStore.settleLayout())
            yield* reloads.want("global")
          }
          // The default project, in OpenCode's folder: a git repository (with a first commit), or a folder
          // registered as it is. A folder there already that is a project stays as it is.
          yield* made(checked.projectFolder)
          const current = yield* Effect.promise(() => OperatorProjects.projectOf(checked.projectFolder))
          if (!current) {
            if (git) yield* folders.init(checked.projectFolder).pipe(Effect.mapError((error) => fail(error.message)))
            // The console's record of it, with its id (a git repository too).
            yield* store
              .setProject(checked.projectFolder, { namespace: OperatorProfile.OPENCODE })
              .pipe(Effect.mapError((error) => fail(error.message)))
          }
          const repository = current ? current.git : git
          // A git project is known once OpenCode has seen it.
          if (repository) yield* projects.fromDirectory(checked.projectFolder)
          yield* store
            .updateNamespace(OperatorProfile.OPENCODE, { defaultProject: checked.projectFolder })
            .pipe(Effect.mapError((error) => fail(error.message)))
          yield* Effect.promise(() =>
            OperatorOnboarding.markDone({ workingDir: checked.workingDir, project: checked.projectFolder }),
          )
          return {
            workingDir: checked.workingDir,
            opencodeFolder: checked.opencodeFolder,
            project: checked.projectFolder,
            git: repository,
          }
        }),
      )
  }),
)
