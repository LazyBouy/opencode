export * as OperatorConfig from "./config"

import path from "path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "@/config/parse"
import { ConfigPaths } from "@/config/paths"
import { ConfigV2Compat } from "@/config/v2-compat"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import { OperatorNamespaceScope } from "./namespace-scope"

export const Scope = Schema.Literals(["global", "project"]).annotate({ identifier: "OperatorConfigScope" })
export type Scope = typeof Scope.Type

// Where a config write goes: the user's global config, the namespace folder's .opencode/opencode.jsonc,
// or the project's.
export const WriteScope = Schema.Literals(["global", "namespace", "project"]).annotate({
  identifier: "OperatorConfigWriteScope",
})
export type WriteScope = typeof WriteScope.Type

export const Source = Schema.Struct({
  kind: Schema.Literals(["global", "namespace", "project", "directory", "env"]).annotate({
    description:
      "global: Global's config (and `~/.opencode`, part of the Global base); namespace: the namespace's; project and directory: the project's files and `.opencode` folders; env: OPENCODE_CONFIG, OPENCODE_CONFIG_DIR or OPENCODE_CONFIG_CONTENT, never written by the console",
  }),
  path: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "OperatorConfigSource" })
export type Source = typeof Source.Type

export const Layers = Schema.Struct({
  sources: Schema.Array(Source).annotate({
    description: "Config sources that exist, in load order. Later sources override earlier ones.",
  }),
  targets: Schema.Struct({
    global: Schema.String,
    project: Schema.String,
    namespace: Schema.optional(Schema.String).annotate({ description: "Absent when the namespace has no folder" }),
  }).annotate({ description: "The file a write at each scope goes to. It is created if missing." }),
  folders: Schema.Struct({
    global: Schema.String,
    project: Schema.String,
    namespace: Schema.optional(Schema.String),
  }).annotate({ description: "The folder that holds agent, command and skill files at each scope" }),
  namespace: Schema.String.annotate({ description: "The namespace the namespace scope stands for" }),
  origins: Schema.Record(Schema.String, Source.fields.kind).annotate({
    description: "For each top-level key, the kind of source that sets it last (the one in effect)",
  }),
}).annotate({ identifier: "OperatorConfigLayers" })
export type Layers = typeof Layers.Type

export const UpdateResult = Schema.Struct({
  path: Schema.String,
  changed: Schema.Boolean,
  reload: Schema.optional(Schema.Literals(["now", "when-idle"])).annotate({
    description:
      "When the project (or, for a global file, every project) reloads to read it: now, or once none of its sessions is running",
  }),
}).annotate({ identifier: "OperatorConfigUpdateResult" })

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorConfigInvalid", {
  path: Schema.String,
  message: Schema.String,
}) {}

// The namespace scope is the project's namespace unless `namespace` names another.
export interface Interface {
  readonly layers: (namespace?: string) => Effect.Effect<Layers>
  readonly update: (
    scope: WriteScope,
    patch: Record<string, unknown>,
    namespace?: string,
  ) => Effect.Effect<typeof UpdateResult.Type, InvalidError>
  /** Replaces the scope's config file with `text` after validating it, for raw JSONC editing. */
  readonly write: (
    scope: WriteScope,
    text: string,
    namespace?: string,
  ) => Effect.Effect<typeof UpdateResult.Type, InvalidError>
  /** The namespace the namespace scope stands for: `namespace`, else the project's. */
  readonly namespaceOf: (namespace?: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorConfig") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const read = (kind: Source["kind"], file: string) =>
      fs.readFileStringSafe(file).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map((text) => (text === undefined ? [] : [{ kind, path: file, text }])),
      )

    // The namespace the namespace scope stands for, and its folder's config file (an existing
    // opencode.json, else opencode.jsonc, created on the first write).
    const namespaceOf = Effect.fn("OperatorConfig.namespaceOf")(function* (namespace?: string) {
      if (namespace) return namespace
      const ctx = yield* InstanceState.context
      return (yield* Effect.promise(() => OperatorNamespaceScope.layerOf(ctx.directory, ctx.worktree))).namespace
    })
    const namespaceFile = Effect.fnUntraced(function* (namespace?: string) {
      const id = yield* namespaceOf(namespace)
      const layer = yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(id))
      if (!layer.target) return { id, dir: undefined, file: undefined }
      const existing = yield* Effect.forEach(["opencode.jsonc", "opencode.json"], (name) =>
        fs.existsSafe(path.join(layer.target!, name)).pipe(Effect.map((found) => (found ? name : undefined))),
      )
      const name = existing.find((item) => item !== undefined) ?? "opencode.jsonc"
      return { id, dir: layer.target, file: path.join(layer.target, name) }
    })

    // Mirrors the load order in Config.loadInstanceState so the last project source is the effective one:
    // the global files, the namespace's, a custom file, the project's, then the config folders'.
    const collect = Effect.fnUntraced(function* (namespace?: string) {
      const ctx = yield* InstanceState.context
      const global = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
        read("global", path.join(Global.Path.config, name)),
      )
      const own = yield* namespaceFile(namespace)
      const ns = own.dir
        ? yield* Effect.forEach(["opencode.json", "opencode.jsonc"], (name) =>
            read("namespace", path.join(own.dir!, name)),
          )
        : []
      // The environment's files are "env" (global_and_opencode_namespaces_spec.md §13 #5).
      const custom = Flag.OPENCODE_CONFIG ? yield* read("env", Flag.OPENCODE_CONFIG) : []
      const project = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? []
        : yield* Effect.forEach(
            yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie),
            (file) => read("project", file),
          )
      const directories = (yield* ConfigPaths.directories(ctx.directory, ctx.worktree).pipe(Effect.orDie)).filter(
        (dir) => (dir.endsWith(".opencode") && !OperatorNamespaceScope.owns(dir)) || dir === Flag.OPENCODE_CONFIG_DIR,
      )
      // `~/.opencode` is part of the Global base; OPENCODE_CONFIG_DIR is the environment's.
      const kindOf = (dir: string) =>
        dir === Flag.OPENCODE_CONFIG_DIR
          ? ("env" as const)
          : OperatorNamespaceScope.isGlobalFolder(dir)
            ? ("global" as const)
            : ("directory" as const)
      const directory = yield* Effect.forEach(directories, (dir) =>
        Effect.forEach(["opencode.json", "opencode.jsonc"], (name) => read(kindOf(dir), path.join(dir, name))),
      )
      const env = Flag.OPENCODE_CONFIG_CONTENT
        ? [{ kind: "env" as const, path: "OPENCODE_CONFIG_CONTENT", text: Flag.OPENCODE_CONFIG_CONTENT }]
        : []
      return [...global.flat(), ...ns.flat(), ...custom, ...project.flat(), ...directory.flat(2), ...env]
    })
    const sources = (namespace?: string) => collect(namespace).pipe(Effect.provideService(FSUtil.Service, fs))

    const targets = Effect.fnUntraced(function* (list: ReadonlyArray<Source>, namespace?: string) {
      const root = projectRoot(yield* InstanceState.context)
      const global =
        ["opencode.jsonc", "opencode.json", "config.json"]
          .map((name) => path.join(Global.Path.config, name))
          .find((file) => list.some((source) => source.path === file)) ??
        path.join(Global.Path.config, "opencode.jsonc")
      const project =
        list.findLast(
          (source) => (source.kind === "project" || source.kind === "directory") && FSUtil.contains(root, source.path),
        )?.path ?? path.join(root, ".opencode", "opencode.jsonc")
      const own = yield* namespaceFile(namespace)
      return { global, project, ...(own.file ? { namespace: own.file } : {}) }
    })

    const layers = Effect.fn("OperatorConfig.layers")(function* (namespace?: string) {
      const list = yield* sources(namespace)
      const ctx = yield* InstanceState.context
      const own = yield* namespaceFile(namespace)
      return {
        sources: list,
        targets: yield* targets(list, namespace),
        folders: {
          global: scopeDirectory("global", ctx),
          project: scopeDirectory("project", ctx),
          ...(own.dir ? { namespace: own.dir } : {}),
        },
        namespace: own.id,
        origins: Object.fromEntries(
          list.flatMap((source) => {
            const value = parse(source.text) as unknown
            return isRecord(value)
              ? Object.keys(value)
                  .filter((key) => key !== "$schema")
                  .map((key) => [key, source.kind] as const)
              : []
          }),
        ),
      }
    })

    // The file a write at the scope goes to; the namespace scope needs a namespace with a folder.
    const target = Effect.fnUntraced(function* (scope: WriteScope, namespace?: string) {
      const file = (yield* targets(yield* sources(namespace), namespace))[scope]
      if (file) return file
      const id = yield* namespaceOf(namespace)
      return yield* new InvalidError({
        path: "",
        message: `The namespace ${id} has no folder; set one in Settings → Namespaces`,
      })
    })

    const save = Effect.fnUntraced(function* (file: string, before: string, after: string) {
      if (after === before) return { path: file, changed: false }
      yield* Effect.try({
        try: () =>
          ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(ConfigParse.jsonc(after, file), file).value, file),
        catch: (cause) => new InvalidError({ path: file, message: describe(cause) }),
      })
      yield* fs.writeWithDirs(file, after).pipe(Effect.orDie)
      return { path: file, changed: true }
    })

    const current = Effect.fnUntraced(function* (file: string) {
      return yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    })

    const update = Effect.fn("OperatorConfig.update")(function* (
      scope: WriteScope,
      patch: Record<string, unknown>,
      namespace?: string,
    ) {
      const file = yield* target(scope, namespace)
      const before = (yield* current(file)) ?? "{}"
      return yield* save(file, before, patchJsonc(before, patch))
    })

    const write = Effect.fn("OperatorConfig.write")(function* (scope: WriteScope, text: string, namespace?: string) {
      const file = yield* target(scope, namespace)
      return yield* save(file, (yield* current(file)) ?? "", text)
    })

    return Service.of({ layers, update, write, namespaceOf })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

// Where a project's own files live. Non-git projects report "/" as their worktree; their root is the
// directory itself.
export function projectRoot(ctx: { directory: string; worktree: string }) {
  return ctx.worktree === "/" ? ctx.directory : ctx.worktree
}

// The folder that holds config-like files (agents, identity layers) at a scope.
export function scopeDirectory(scope: "global" | "project", ctx: { directory: string; worktree: string }) {
  return scope === "global" ? Global.Path.config : path.join(projectRoot(ctx), ".opencode")
}

// The JSON schema of the config file, for building editors. Computed once on first use.
let schemaDocument: Record<string, unknown> | undefined
export function jsonSchema() {
  if (schemaDocument) return schemaDocument
  const document = Schema.toJsonSchemaDocument(ConfigV1.Info)
  // The root is a `$ref` to the Config definition; inline it so editors find `properties` at the top.
  const ref = typeof document.schema.$ref === "string" ? document.schema.$ref.replace("#/$defs/", "") : undefined
  const root = ref ? document.definitions[ref] : document.schema
  schemaDocument = { ...(isRecord(root) ? root : {}), $defs: document.definitions }
  return schemaDocument
}

// A patch value written as a whole, replacing the value there instead of being merged into it (so
// keys it leaves out go, and its keys keep its order): an agent's `permission`, whose order matters.
const WHOLE = Symbol.for("opencode.operator.config.whole")
export function whole(value: unknown): Record<string, unknown> {
  return { [WHOLE]: value }
}

// Applies a JSON merge patch to JSONC text, keeping comments and formatting. A `null` value
// removes the key, so a project setting can be reset to the inherited value.
function patchJsonc(input: string, patch: unknown, at: string[] = []): string {
  if (isRecord(patch) && WHOLE in patch)
    return applyEdits(
      input,
      modify(input, at, (patch as Record<symbol, unknown>)[WHOLE], {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  if (isRecord(patch))
    return Object.entries(patch).reduce((text, [key, value]) => patchJsonc(text, value, [...at, key]), input)
  return applyEdits(
    input,
    modify(input, at, patch === null ? undefined : patch, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  )
}

function describe(cause: unknown) {
  const data = isRecord(cause) && isRecord(cause.data) ? cause.data : undefined
  const issues = Array.isArray(data?.issues) ? data.issues.filter(isRecord) : []
  if (issues.length)
    return issues
      .map((issue) =>
        [Array.isArray(issue.path) ? issue.path.join(".") : "", String(issue.message)].filter(Boolean).join(": "),
      )
      .join("\n")
  if (typeof data?.message === "string") return data.message
  return cause instanceof Error ? cause.message : String(cause)
}
