export * as OperatorPermissionLevels from "./permission-levels"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgentPermissions } from "./agent-permissions"
import { OperatorConfig } from "./config"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorPermissionMarks } from "./permission-marks"
import { OperatorPermissionModel as Model } from "./permission-model"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorProjects } from "./projects"
import { OperatorReloadWhenIdle } from "./reload-when-idle"

// The Namespace and Project permission levels (tool_prompt_from_permission.md §3, §7): what each one
// inherits, its own lines (its config file's `permission`, so other OpenCode clients see them), the
// inherited lines it deletes and the lines it locks (permission-marks.ts). A save is checked against the
// locks above it, writes the file and the marks, and the projects reload when none of their sessions is
// running; the fork applies it at once (permission-live.ts reads the files and marks for every decision).

type Rule = PermissionV1.Rule

export const LevelName = Schema.Literals(["namespace", "project"]).annotate({
  identifier: "OperatorPermissionLevelName",
})
export type LevelName = typeof LevelName.Type

export const Blocked = Schema.Struct({
  kind: Schema.Literals(["line", "deleted"]),
  permission: Schema.String,
  pattern: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "OperatorPermissionBlocked" })

export const View = Schema.Struct({
  level: LevelName,
  namespace: Schema.String,
  project: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String).annotate({
    description: "The config file the level's lines are written in; absent for a namespace without a folder",
  }),
  rows: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "The lines in force at this level: inherited ones and the level's own, each with its level and lock",
  }),
  deleted: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "Inherited lines this level deletes, as they were",
  }),
  inherited: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "What the level inherits, before its own changes (broadest first)",
  }),
  own: Schema.Array(PermissionV1.Rule).annotate({ description: "The level's own lines, as written in its file" }),
  marks: OperatorPermissionMarks.Marks,
  canDeleteOpenCode: Schema.Boolean.annotate({
    description: "OpenCode's own lines can be deleted (not in the OpenCode namespace)",
  }),
  blocked: Schema.Array(Blocked).annotate({ description: "The level's lines or deletions a lock above sets aside" }),
  forms: Schema.Record(Schema.String, OperatorPermissionRules.PatternForm),
  known: Schema.Array(Schema.String).annotate({ description: "Permissions the editor suggests" }),
  reload: Schema.optional(Schema.Literals(["now", "when-idle"])),
}).annotate({ identifier: "OperatorPermissionLevelView" })
export type View = typeof View.Type

export const SaveInput = Schema.Struct({
  lines: Schema.Array(PermissionV1.Rule),
  deleted: Schema.Array(OperatorPermissionMarks.Key),
  locks: Schema.Array(OperatorPermissionMarks.Key),
}).annotate({ identifier: "OperatorPermissionLevelSave" })
export type SaveInput = typeof SaveInput.Type

export class LockedError extends Schema.TaggedErrorClass<LockedError>()("OperatorPermissionLevelLocked", {
  message: Schema.String,
}) {}
export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorPermissionLevelInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly view: (level: LevelName, namespace?: string) => Effect.Effect<View, InvalidError>
  readonly save: (
    level: LevelName,
    input: SaveInput,
    namespace?: string,
  ) => Effect.Effect<View, LockedError | InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionLevels") {}

const rowOf = (line: OperatorPermissionLive.Line, index: number): OperatorPermissionRules.Row => ({
  permission: line.permission,
  pattern: line.pattern,
  action: line.action,
  index: index + 1,
  part: line.part,
  from: line.from,
  level: OperatorPermissionLive.levelName(line.level),
  ...(line.lockedAt !== undefined ? { locked: OperatorPermissionLive.levelName(line.lockedAt) } : {}),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const live = yield* OperatorPermissionLive.Service
    const operatorConfig = yield* OperatorConfig.Service
    const agentPermissions = yield* OperatorAgentPermissions.Service
    const reloads = yield* OperatorReloadWhenIdle.Service

    const where = Effect.fnUntraced(function* (level: LevelName, namespace?: string) {
      const ctx = yield* InstanceState.context
      const id = level === "project" ? undefined : namespace
      const ns = yield* operatorConfig.namespaceOf(id)
      const project = level === "project" ? yield* Effect.promise(() => OperatorProjects.keyOf(ctx)) : undefined
      const layers = yield* operatorConfig.layers(id)
      const file = level === "project" ? layers.targets.project : layers.targets.namespace
      return { ns, project, file }
    })

    const marksOf = (level: LevelName, ns: string, project?: string) =>
      Effect.promise(() =>
        level === "project" && project
          ? OperatorPermissionMarks.projectMarks(project)
          : OperatorPermissionMarks.namespaceMarks(ns),
      )

    // The lines down to the level, with a draft of the level in place of what is saved.
    const build = Effect.fnUntraced(function* (
      level: LevelName,
      ns: string,
      draft?: { lines: ReadonlyArray<Rule>; marks: OperatorPermissionMarks.Marks },
    ) {
      return yield* live.lines({
        upTo: level,
        namespace: ns,
        ...(draft ? { draft: { level, ...draft } } : {}),
      })
    })

    const view = Effect.fn("OperatorPermissionLevels.view")(function* (level: LevelName, namespace?: string) {
      const { ns, project, file } = yield* where(level, namespace)
      const marks = yield* marksOf(level, ns, project)
      const built = yield* build(level, ns)
      // The level's own lines as written in its file.
      const own = file
        ? OperatorPermissionRules.writtenRules(
            (yield* operatorConfig.layers(level === "project" ? undefined : ns)).sources
              .filter((source) => source.path === file)
              .flatMap((source) => {
                const value = OperatorPermissionLive.parseConfig(source.text)
                return value ? [value.permission] : []
              })[0],
          )
        : []
      // What the level inherits: the lines down to the level above. The deleted ones, as they were.
      const above = yield* live.lines({ upTo: level === "project" ? "namespace" : "global", namespace: ns })
      const deleted = above.lines.filter((line) => marks.deleted.some((key) => Model.sameKey(key, line)))
      const editor = yield* agentPermissions.hints()
      return {
        level,
        namespace: ns,
        ...(project ? { project } : {}),
        ...(file ? { file } : {}),
        // Broadest first: each line after the lines it wins against (the effective order).
        rows: Model.order(built.lines).map(rowOf),
        deleted: deleted.map(rowOf),
        inherited: Model.order(above.lines).map(rowOf),
        own,
        marks,
        canDeleteOpenCode: ns !== "opencode",
        blocked: blockedAt(built.blocked, OperatorPermissionLive.LEVEL[level]),
        forms: editor.forms,
        known: editor.known,
      } satisfies View
    })

    const save = Effect.fn("OperatorPermissionLevels.save")(function* (
      level: LevelName,
      input: SaveInput,
      namespace?: string,
    ) {
      const { ns, project, file } = yield* where(level, namespace)
      if (!file)
        return yield* new InvalidError({
          message: `The namespace ${ns} has no folder; set one in Settings → Namespaces`,
        })
      const lines = input.lines.flatMap((rule) => {
        const permission = rule.permission.trim()
        return permission ? [{ permission, pattern: rule.pattern.trim() || "*", action: rule.action }] : []
      })
      const marks = { deleted: [...input.deleted], locks: [...input.locks] }
      // Refused: a line or deletion a lock above sets aside, a line inside a locked line above that
      // decides otherwise, and a deletion of OpenCode's own lines in the OpenCode namespace.
      const built = yield* build(level, ns, { lines, marks })
      const index = OperatorPermissionLive.LEVEL[level]
      const blocked = blockedAt(built.blocked, index)
      if (blocked.length) return yield* new LockedError({ message: blocked.map((item) => item.reason).join("\n") })
      const locked = built.lines.filter((line) => line.lockedAt !== undefined && line.lockedAt < index)
      for (const rule of lines) {
        const lock = locked.find(
          (line) =>
            line.action !== rule.action &&
            Model.contains(line.permission, rule.permission) &&
            Model.contains(line.pattern, rule.pattern),
        )
        if (lock)
          return yield* new LockedError({
            message: `${rule.permission} ${rule.pattern}: the ${OperatorPermissionLive.levelName(lock.lockedAt!)} locks ${lock.permission} ${lock.pattern} ${lock.action}, which covers it`,
          })
      }
      const written = yield* operatorConfig
        .update(
          level,
          { permission: lines.length ? OperatorConfig.whole(OperatorPermissionRules.toConfig(lines)) : null },
          level === "namespace" ? ns : undefined,
        )
        .pipe(Effect.mapError((error) => new InvalidError({ message: error.message })))
      yield* Effect.promise(() =>
        level === "project" && project
          ? OperatorPermissionMarks.writeProject(project, marks)
          : OperatorPermissionMarks.writeNamespace(ns, marks),
      )
      // OpenCode reads the file when the project reloads, when none of its sessions is running; the fork
      // applies it now.
      const directories =
        level === "namespace"
          ? OperatorNamespaceScope.instancesOf({ namespace: ns })
          : [(yield* InstanceState.context).directory]
      const reloaded = written.changed
        ? yield* Effect.forEach(directories, (directory) => reloads.want({ directory }))
        : []
      const reload = reloaded.includes("when-idle") ? ("when-idle" as const) : ("now" as const)
      return { ...(yield* view(level, namespace)), reload }
    })

    return Service.of({ view, save })
  }),
)

// The reasons for what a lock above (or OpenCode's protection) sets aside at a level.
function blockedAt(blocked: ReadonlyArray<Model.Blocked<OperatorPermissionLive.Meta>>, level: number) {
  return blocked
    .filter((item) => item.level === level)
    .map((item) => ({
      kind: item.kind,
      permission: item.key.permission,
      pattern: item.key.pattern,
      reason: item.lock
        ? `${item.key.permission} ${item.key.pattern}: locked by the ${OperatorPermissionLive.levelName(item.lock.lockedAt!)}`
        : `${item.key.permission} ${item.key.pattern}: OpenCode's own lines can't be deleted in the OpenCode namespace`,
    }))
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorPermissionLive.node, OperatorConfig.node, OperatorAgentPermissions.node, OperatorReloadWhenIdle.node],
})
