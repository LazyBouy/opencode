export * as OperatorTrashItems from "./trash-items"

import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Skill } from "@/skill"
import { OperatorConfig } from "./config"
import { OperatorProjectConfig } from "./project-config"
import { OperatorMemory } from "./memory"
import { OperatorProjects } from "./projects"
import { OperatorScopes } from "./scopes"
import { OperatorTrash } from "./trash"
import { OperatorTrashFiles } from "./trash-files"

// A project's own capabilities and memory files, moved to Trash: skills (their folder), commands and
// custom tools (their file), MCP servers and commands defined in config (their entry, kept to write
// back), and memory files. They can be the project's, its namespace's or Global's (scopes.ts says
// which); built-in ones, the environment's, and ones from plugins or other folders are not.

export const ItemKind = Schema.Literals(["skill", "command", "tool", "mcp", "memory"]).annotate({
  identifier: "OperatorTrashItemKind",
})
export type ItemKind = typeof ItemKind.Type

export interface Interface {
  readonly remove: (input: {
    kind: ItemKind
    name: string
  }) => Effect.Effect<OperatorTrash.Entry, OperatorTrash.TrashError | OperatorProjectConfig.CopyNeededError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorTrashItems") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* Skill.Service
    const config = yield* OperatorConfig.Service
    const memory = yield* OperatorMemory.Service
    const fail = (message: string) => new OperatorTrash.TrashError({ message })
    const put = (input: Parameters<typeof OperatorTrashFiles.put>[0]) =>
      Effect.tryPromise({
        try: () => OperatorTrashFiles.put(input),
        catch: (error) => fail(error instanceof Error ? error.message : String(error)),
      })

    // The project's .opencode folder, its namespace's and Global's config folder, where its own items
    // live, nearest first.
    const folders = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const layers = yield* config.layers()
      return {
        ctx,
        project,
        own: [
          OperatorConfig.scopeDirectory("project", ctx),
          ...(layers.folders.namespace ? [layers.folders.namespace] : []),
          OperatorConfig.scopeDirectory("global", ctx),
        ],
      }
    })

    // A file among the given names in the own folders' subfolders.
    const findFile = (own: ReadonlyArray<string>, subfolders: ReadonlyArray<string>, names: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        for (const folder of own)
          for (const sub of subfolders)
            for (const name of names) {
              const file = path.join(folder, sub, name)
              if (await OperatorTrashFiles.exists(file)) return file
            }
        return undefined
      })

    // A config entry (`section`.`name`) in the project's, its namespace's or Global's config file, and
    // its value; the nearest one.
    const configEntry = Effect.fnUntraced(function* (section: string, name: string) {
      const layers = yield* config.layers()
      const find = (kinds: ReadonlyArray<string>) =>
        layers.sources
          .filter((source) => kinds.includes(source.kind))
          .map(
            (source) => (parse(source.text) as Record<string, Record<string, unknown> | undefined>)?.[section]?.[name],
          )
          .findLast((value) => value !== undefined)
      const project = find(["project", "directory"])
      if (project !== undefined) return { scope: "project" as const, value: project }
      const namespace = find(["namespace"])
      if (namespace !== undefined) return { scope: "namespace" as const, value: namespace, namespace: layers.namespace }
      const global = find(["global"])
      if (global !== undefined) return { scope: "global" as const, value: global }
      return undefined
    })

    const fromConfig = Effect.fnUntraced(function* (
      kind: "command" | "mcp",
      section: string,
      name: string,
      directory: string,
    ) {
      const entry = yield* configEntry(section, name)
      if (!entry) return yield* fail(`${name} is not defined in this project's, its namespace's or Global's config`)
      // A project page never writes its namespace's or Global's config (global_and_opencode_namespaces_spec.md
      // §7.3): a namespace's entry goes from the project's own copy of that config; Global's is the base
      // under every namespace and can't be removed from a project.
      if (entry.scope === "global")
        return yield* fail(
          `${name} is in Global's config: delete it in Settings → Namespaces → Global, or turn it off for this project`,
        )
      yield* config
        .update("project", { [section]: { [name]: null } })
        .pipe(
          Effect.mapError((error) =>
            error instanceof OperatorProjectConfig.CopyNeededError ? error : fail(error.message),
          ),
        )
      return yield* put({
        kind,
        name,
        project: directory,
        config: { scope: "project", key: [section, name], value: entry.value },
      })
    })

    const remove = Effect.fn("OperatorTrashItems.remove")(function* (input: { kind: ItemKind; name: string }) {
      const { ctx, project, own } = yield* folders()
      const name = input.name
      if (input.kind === "skill") {
        const skill = (yield* skills.all()).find((item) => item.name === name)
        if (!skill) return yield* fail(`No skill named ${name}`)
        if (skill.location === "<built-in>") return yield* fail(`${name} is built in`)
        // The project's, its namespace's or Global's; not the environment's or another folder's.
        const scope = (yield* Effect.promise(() => OperatorScopes.of(skill.location, [project]))).kind
        if (scope !== "project" && scope !== "namespace" && scope !== "global")
          return yield* fail(`${name} comes from ${skill.location}; remove it there`)
        return yield* put({ kind: "skill", name, project: ctx.directory, paths: [path.dirname(skill.location)] })
      }
      if (input.kind === "command") {
        const file = yield* findFile(own, ["command", "commands"], [`${name}.md`])
        if (file) return yield* put({ kind: "command", name, project: ctx.directory, paths: [file] })
        return yield* fromConfig("command", "command", name, ctx.directory)
      }
      if (input.kind === "tool") {
        const file = yield* findFile(own, ["tool", "tools"], [`${name}.ts`, `${name}.js`])
        if (!file) return yield* fail(`${name} is not a custom tool of this project or the global config`)
        return yield* put({ kind: "tool", name, project: ctx.directory, paths: [file] })
      }
      if (input.kind === "mcp") return yield* fromConfig("mcp", "mcp", name, ctx.directory)
      // A memory file: one the Memory page can edit.
      const file = (yield* memory.overview()).files.find((item) => item.path === name)
      if (!file?.editable) return yield* fail(`${name} is not a memory file that can be deleted`)
      return yield* put({ kind: "memory", name: path.basename(name), project: ctx.directory, paths: [name] })
    })

    return Service.of({ remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Skill.node, OperatorConfig.node, OperatorMemory.node],
})
