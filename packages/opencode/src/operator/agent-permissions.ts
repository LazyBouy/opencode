export * as OperatorAgentPermissions from "./agent-permissions"

import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgents } from "./agents"
import { OperatorProjectConfig } from "./project-config"
import { OperatorConfig } from "./config"
import { OperatorLayout } from "./layout"
import { OperatorPermissionLive } from "./permission-live"
import { OperatorPermissionModel } from "./permission-model"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorTools } from "./tools"

// An agent's permissions for the permission editor: the full list with where each rule comes from,
// which rules are the agent's own (the only ones its editors change), the agent's own rules as
// written, the pattern each permission is asked with (for the editor's hints), and the file a save
// writes at each scope. Saving writes only the agent's own rules, in order, to its agent file or its
// `agent.<name>` config entry; config `permission` applies to every agent and is changed on the Config
// page.

export const Target = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "config"]).annotate({
    description: "file: the agent's own file (at every scope); config: `agent.<name>.permission` in this file",
  }),
  tracked: Schema.Boolean.annotate({ description: "The file is tracked by the project's git repository" }),
}).annotate({ identifier: "OperatorAgentPermissionTarget" })

export const Info = Schema.Struct({
  agent: Schema.String,
  rows: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "The agent's full list, in evaluation order, each rule with where it comes from",
  }),
  own: Schema.Struct({ start: Schema.Finite, end: Schema.Finite }).annotate({
    description: "The agent's own rules: rows[start] up to (not including) rows[end]",
  }),
  written: Schema.Array(PermissionV1.Rule).annotate({
    description: "The agent's own rules as written (patterns as in the file, `~` not expanded)",
  }),
  forms: Schema.Record(Schema.String, OperatorPermissionRules.PatternForm).annotate({
    description: "The pattern each permission is asked with, for the editor's hints",
  }),
  known: Schema.Array(Schema.String).annotate({ description: "Permissions and tools to pick from" }),
  targets: Schema.Struct({ project: Target, global: Target }),
  alsoIn: Schema.Array(Schema.String).annotate({
    description: "Config files that set this agent's `permission` (merged with what a save writes)",
  }),
  inherited: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "What the agent inherits (OpenCode, global, namespace, project), broadest first",
  }),
  levelRows: Schema.Array(OperatorPermissionRules.Row).annotate({
    description: "The lines in force for the agent, broadest first, each with its level and lock",
  }),
  canDeleteOpenCode: Schema.Boolean.annotate({
    description: "OpenCode's own lines can be deleted (not in the OpenCode namespace)",
  }),
}).annotate({ identifier: "OperatorAgentPermissions" })
export type Info = typeof Info.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorAgentPermissionsNotFound", {
  message: Schema.String,
}) {}
export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorAgentPermissionsInvalid", {
  message: Schema.String,
}) {}

type Rule = PermissionV1.Rule

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info, NotFoundError>
  /**
   * Writes the agent's own rules. Refuses a permission + pattern pair written twice, and a rule a lock
   * above the agent (the namespace's, the project's) covers. Order doesn't change what the rules decide
   * (permission-model.ts); `confirmOrder` is accepted and ignored.
   */
  readonly save: (input: {
    agent: string
    scope: OperatorConfig.Scope
    rules: ReadonlyArray<Rule>
    confirmOrder?: boolean
  }) => Effect.Effect<{ path: string }, NotFoundError | InvalidError | OperatorProjectConfig.CopyNeededError>
  /** The editor's hints without an agent: the pattern each permission is asked with, and the permissions to suggest. */
  readonly hints: () => Effect.Effect<{ forms: Record<string, OperatorPermissionRules.PatternForm>; known: string[] }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorAgentPermissions") {}

// Permissions every agent can have rules for, besides its tools.
const STANDARD = ["*", "external_directory", "doom_loop", "question", "plan_enter", "plan_exit"]

// Whether git tracks the file (a project file that is part of the repository).
async function tracked(file: string, cwd: string) {
  const child = Bun.spawn(["git", "ls-files", "--error-unmatch", file], { cwd, stdout: "ignore", stderr: "ignore" })
  return (await child.exited.catch(() => 1)) === 0
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const rules = yield* OperatorPermissionRules.Service
    const agents = yield* OperatorAgents.Service
    const operatorConfig = yield* OperatorConfig.Service
    const tools = yield* OperatorTools.Service
    const config = yield* Config.Service
    const live = yield* OperatorPermissionLive.Service

    const get = Effect.fn("OperatorAgentPermissions.get")(function* (name: string) {
      const agent = (yield* agents.list()).find((item) => item.name === name)
      if (!agent) return yield* new NotFoundError({ message: `No agent named "${name}"` })
      const labelled = yield* rules.agent(name)
      const cfg = yield* config.get()
      const entry = cfg.agent?.[name] as { permission?: unknown } | undefined
      const layers = yield* operatorConfig.layers()
      const ctx = yield* InstanceState.context
      const root = OperatorConfig.projectRoot(ctx)
      const file = agent.source.kind === "file" ? agent.source.path : undefined
      const target = (scope: OperatorConfig.Scope) =>
        Effect.promise(async () => {
          const path = file ?? layers.targets[scope]
          return { path, kind: file ? ("file" as const) : ("config" as const), tracked: await tracked(path, root) }
        })
      const listed = yield* tools.list()
      const forms = {
        ...OperatorPermissionRules.FORMS,
        ...Object.fromEntries(listed.filter((tool) => tool.origin === "mcp").map((tool) => [tool.id, "any" as const])),
      }
      const known = [
        ...new Set([
          ...STANDARD,
          ...listed.map((tool) => OperatorPermissionRules.permissionOf(tool.id)),
          ...labelled.rows.map((row) => row.permission),
        ]),
      ].sort((a, b) => a.localeCompare(b))
      const alsoIn = layers.sources.flatMap((source) => {
        const value = parse(source.text) as { agent?: Record<string, { permission?: unknown } | undefined> } | undefined
        return value?.agent?.[name]?.permission !== undefined ? [source.path] : []
      })
      const rowsOf = (lines: ReadonlyArray<OperatorPermissionLive.Line>) =>
        OperatorPermissionModel.order(lines).map((line, index) => ({
          permission: line.permission,
          pattern: line.pattern,
          action: line.action,
          index: index + 1,
          part: line.part,
          from: line.from,
          level: OperatorPermissionLive.levelName(line.level),
          ...(line.lockedAt !== undefined ? { locked: OperatorPermissionLive.levelName(line.lockedAt) } : {}),
        }))
      const inherited = yield* live.lines({ agent: name, upTo: "project" })
      const inForce = yield* live.lines({ agent: name, upTo: "agent" })
      return {
        agent: name,
        inherited: rowsOf(inherited.lines),
        levelRows: rowsOf(inForce.lines),
        canDeleteOpenCode: !OperatorLayout.builtinsProtected(
          yield* operatorConfig.namespaceOf(),
          yield* Effect.promise(() => OperatorLayout.snapshot()),
        ),
        rows: labelled.rows,
        own: labelled.own,
        written: OperatorPermissionRules.writtenRules(entry?.permission),
        forms,
        known,
        targets: { project: yield* target("project"), global: yield* target("global") },
        alsoIn,
      }
    })

    const save = Effect.fn("OperatorAgentPermissions.save")(function* (input: {
      agent: string
      scope: OperatorConfig.Scope
      rules: ReadonlyArray<Rule>
      confirmOrder?: boolean
    }) {
      const check = OperatorPermissionRules.orderCheck(input.rules)
      const at = (index: number) => {
        const rule = input.rules[index]!
        return `#${index + 1} ${rule.permission} ${rule.pattern}`
      }
      if (check.duplicates.length)
        return yield* new InvalidError({
          message: check.duplicates
            .map(
              (item) =>
                `${at(item.earlier)} and ${at(item.later)} have the same permission and pattern: the later one replaces the earlier one. Remove the earlier one.`,
            )
            .join("\n"),
        })
      // A rule a lock above the agent covers, with another action, is refused.
      const built = yield* live.lines({ agent: input.agent, agentRules: input.rules })
      const blocked = built.blocked.find((item) => item.level === OperatorPermissionLive.LEVEL.agent)
      if (blocked)
        return yield* new InvalidError({
          message: blocked.lock
            ? `${blocked.key.permission} ${blocked.key.pattern} is locked by the ${OperatorPermissionLive.levelName(blocked.lock.lockedAt!)}: the agent may not change it.`
            : `${blocked.key.permission} ${blocked.key.pattern}: OpenCode's own lines can't be deleted in the OpenCode namespace.`,
        })
      const above = built.lines.filter(
        (line) => line.lockedAt !== undefined && line.lockedAt < OperatorPermissionLive.LEVEL.agent,
      )
      for (const rule of input.rules) {
        const lock = above.find(
          (line) =>
            line.action !== rule.action &&
            OperatorPermissionModel.contains(line.permission, rule.permission) &&
            OperatorPermissionModel.contains(line.pattern, rule.pattern),
        )
        if (lock)
          return yield* new InvalidError({
            message: `${rule.permission} ${rule.pattern}: the ${OperatorPermissionLive.levelName(lock.lockedAt!)} locks ${lock.permission} ${lock.pattern} ${lock.action}, which covers it.`,
          })
      }
      const patch: typeof OperatorAgents.Patch.Type = input.rules.length
        ? { permission: OperatorPermissionRules.toConfig(input.rules) as typeof OperatorAgents.Patch.Type.permission }
        : { reset: ["permission"] }
      return yield* agents.update(input.scope, input.agent, patch).pipe(
        Effect.map((path) => ({ path })),
        Effect.catchTags({
          OperatorAgentNotFound: (error) => new NotFoundError({ message: error.message }),
          OperatorAgentInvalid: (error) => new InvalidError({ message: error.message }),
          OperatorConfigInvalid: (error) => new InvalidError({ message: `${error.path}: ${error.message}` }),
        }),
      )
    })

    const hints = Effect.fn("OperatorAgentPermissions.hints")(function* () {
      const listed = yield* tools.list()
      return {
        forms: {
          ...OperatorPermissionRules.FORMS,
          ...Object.fromEntries(
            listed.filter((tool) => tool.origin === "mcp").map((tool) => [tool.id, "any" as const]),
          ),
        } as Record<string, OperatorPermissionRules.PatternForm>,
        known: [...new Set([...STANDARD, ...listed.map((tool) => OperatorPermissionRules.permissionOf(tool.id))])].sort(
          (a, b) => a.localeCompare(b),
        ),
      }
    })

    return Service.of({ get, save, hints })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    OperatorPermissionRules.node,
    OperatorAgents.node,
    OperatorConfig.node,
    OperatorTools.node,
    Config.node,
    OperatorPermissionLive.node,
  ],
})
