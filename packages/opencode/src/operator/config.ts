export * as OperatorConfig from "./config"

import path from "path"
import { applyEdits, modify } from "jsonc-parser"
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

export const Scope = Schema.Literals(["global", "project"]).annotate({ identifier: "OperatorConfigScope" })
export type Scope = typeof Scope.Type

export const Source = Schema.Struct({
  kind: Schema.Literals(["global", "custom", "project", "directory", "env"]),
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
  }).annotate({ description: "The file a write at each scope goes to. It is created if missing." }),
}).annotate({ identifier: "OperatorConfigLayers" })
export type Layers = typeof Layers.Type

export const UpdateResult = Schema.Struct({
  path: Schema.String,
  changed: Schema.Boolean,
}).annotate({ identifier: "OperatorConfigUpdateResult" })

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorConfigInvalid", {
  path: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly layers: () => Effect.Effect<Layers>
  readonly update: (
    scope: Scope,
    patch: Record<string, unknown>,
  ) => Effect.Effect<typeof UpdateResult.Type, InvalidError>
  /** Replaces the scope's config file with `text` after validating it, for raw JSONC editing. */
  readonly write: (scope: Scope, text: string) => Effect.Effect<typeof UpdateResult.Type, InvalidError>
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

    // Mirrors the load order in Config.loadInstanceState so the last project source is the effective one.
    const sources = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const global = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
        read("global", path.join(Global.Path.config, name)),
      )
      const custom = Flag.OPENCODE_CONFIG ? yield* read("custom", Flag.OPENCODE_CONFIG) : []
      const project = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? []
        : yield* Effect.forEach(yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie), (file) =>
            read("project", file),
          )
      const directories = (yield* ConfigPaths.directories(ctx.directory, ctx.worktree).pipe(Effect.orDie)).filter(
        (dir) => dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR,
      )
      const directory = yield* Effect.forEach(directories, (dir) =>
        Effect.forEach(["opencode.json", "opencode.jsonc"], (name) => read("directory", path.join(dir, name))),
      )
      const env = Flag.OPENCODE_CONFIG_CONTENT
        ? [{ kind: "env" as const, path: "OPENCODE_CONFIG_CONTENT", text: Flag.OPENCODE_CONFIG_CONTENT }]
        : []
      return [...global.flat(), ...custom, ...project.flat(), ...directory.flat(2), ...env]
    }, Effect.provideService(FSUtil.Service, fs))

    const targets = Effect.fnUntraced(function* (list: ReadonlyArray<Source>) {
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
      return { global, project }
    })

    const layers = Effect.fn("OperatorConfig.layers")(function* () {
      const list = yield* sources()
      return { sources: list, targets: yield* targets(list) }
    })

    const save = Effect.fnUntraced(function* (file: string, before: string, after: string) {
      if (after === before) return { path: file, changed: false }
      yield* Effect.try({
        try: () => ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(ConfigParse.jsonc(after, file), file).value, file),
        catch: (cause) => new InvalidError({ path: file, message: describe(cause) }),
      })
      yield* fs.writeWithDirs(file, after).pipe(Effect.orDie)
      return { path: file, changed: true }
    })

    const current = Effect.fnUntraced(function* (file: string) {
      return yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    })

    const update = Effect.fn("OperatorConfig.update")(function* (scope: Scope, patch: Record<string, unknown>) {
      const file = (yield* targets(yield* sources()))[scope]
      const before = (yield* current(file)) ?? "{}"
      return yield* save(file, before, patchJsonc(before, patch))
    })

    const write = Effect.fn("OperatorConfig.write")(function* (scope: Scope, text: string) {
      const file = (yield* targets(yield* sources()))[scope]
      return yield* save(file, (yield* current(file)) ?? "", text)
    })

    return Service.of({ layers, update, write })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

// Where a project's own files live. Non-git projects report "/" as their worktree; their root is the
// directory itself.
export function projectRoot(ctx: { directory: string; worktree: string }) {
  return ctx.worktree === "/" ? ctx.directory : ctx.worktree
}

// The folder that holds config-like files (agents, identity layers) at a scope.
export function scopeDirectory(scope: Scope, ctx: { directory: string; worktree: string }) {
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

// Applies a JSON merge patch to JSONC text, keeping comments and formatting. A `null` value
// removes the key, so a project setting can be reset to the inherited value.
function patchJsonc(input: string, patch: unknown, at: string[] = []): string {
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
      .map((issue) => [Array.isArray(issue.path) ? issue.path.join(".") : "", String(issue.message)].filter(Boolean).join(": "))
      .join("\n")
  if (typeof data?.message === "string") return data.message
  return cause instanceof Error ? cause.message : String(cause)
}
