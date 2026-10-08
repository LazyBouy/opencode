export * as OperatorPermissionLive from "./permission-live"

import { parse } from "jsonc-parser"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { OperatorConfig } from "./config"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorPermissionHook } from "./permission-hook"
import { OperatorPermissionModel as Model } from "./permission-model"
import { OperatorPermissionRules } from "./permission-rules"

// A session's permission lines in levels, and the decisions they make (permission-model.ts says how):
//
//   OpenCode   its defaults and the built-in agent's rules, as loaded, and the truncation folder allow
//   Global     the global config files' `permission` (and legacy `tools`), if the namespace inherits it
//   Namespace  the namespace folder's config file
//   Project    the project's config files (and OPENCODE_PERMISSION)
//   Agent      the agent's own rules: as just written (Allow for agent, the Permissions editor) until the
//              project reloads, else as loaded; its locks, and its parent session's agent's locked rules
//              when it inherits them
//   Session    the session's own rules as they are now (Allow for session, "Always"), except for
//              doom_loop, which OpenCode asks with the agent's rules only
//
// Config files are read as they are now, so a saved line applies at once. Every ask is decided here: the
// permission hook (the fork line in permission/index.ts) returns one exact rule per input, checked last.
// The tool list, the subagent list, the skills list and the MCP instructions use the same lines
// (permission-effective.ts).

type Rule = PermissionV1.Rule
export type Meta = { part: OperatorPermissionRules.Part; from: OperatorPermissionRules.Origin }
export type Line = Model.Line<Meta>
export const LEVEL = Object.fromEntries(OperatorPermissionRules.LEVELS.map((name, index) => [name, index])) as Record<
  OperatorPermissionRules.Level,
  number
>
export const levelName = (level: number) => OperatorPermissionRules.LEVELS[level] ?? "session"

export type LinesInput = {
  agent: string
  /** The session whose rules and parent apply. */
  session?: Session.Info
  /** The session that started this agent's session, without one (Runs as Subagent, started from it). */
  parentID?: string
  /** In place of the session's rules (a draft, or the rules `task` gives a subagent); labelled or not. */
  sessionLines?: ReadonlyArray<Rule & Partial<Meta>>
  /** A draft of the agent's own rules, in place of its saved ones. */
  agentRules?: ReadonlyArray<Rule>
  /** The permission asked for: doom_loop leaves the session's rules out. */
  permission?: string
}

export interface Interface {
  /** An agent's own rules as just written to its file or config entry, applied at once. */
  readonly written: (input: { directory: string; agent: string; rules: ReadonlyArray<Rule> }) => Effect.Effect<void>
  /** An agent's own rules written since its project loaded, not read by OpenCode yet. */
  readonly pending: (directory: string, agent: string) => ReadonlyArray<Rule>
  /** The lines in force, level by level, with where each comes from. */
  readonly lines: (input: LinesInput) => Effect.Effect<{ lines: Line[]; blocked: Model.Blocked<Meta>[] }>
  /** How an ask of this session is decided, and the lock that binds it, if one does. */
  readonly decide: (sessionID: string, permission: string, input: string) => Effect.Effect<Model.Decision<Meta>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionLive") {}

// What an agent locks (fixes_spec §4.2), registered by the locks service: its lock keys, and its parent
// session's agent's locked rules when it inherits them.
export const locks: {
  of?: (input: {
    directory: string
    agent: string
    parentID?: string
  }) => Effect.Effect<{ keys: ReadonlyArray<Model.Key>; inherited: ReadonlyArray<Rule> }>
} = {}

const keyOf = (directory: string, agent: string) => `${directory}\u0000${agent}`
const same = (a: Rule, b: Rule | undefined) =>
  !!b && a.permission === b.permission && a.pattern === b.pattern && a.action === b.action
const startsWith = (list: ReadonlyArray<Rule>, prefix: ReadonlyArray<Rule>) =>
  prefix.length <= list.length && prefix.every((rule, index) => same(rule, list[index]))
const plain = ({ permission, pattern, action }: Rule): Rule => ({ permission, pattern, action })

// A config file's lines: its legacy `tools` switches (edit, write and patch are `edit`), then its
// `permission`, which wins for the same permission and pattern (as config.ts merges them).
function configLines(path: string, text: string): Array<Rule & Meta> {
  const value = parse(text) as Record<string, unknown> | undefined
  if (!value || typeof value !== "object") return []
  const tools = value.tools && typeof value.tools === "object" ? (value.tools as Record<string, unknown>) : {}
  const switched = Object.entries(tools).flatMap(([tool, enabled]) =>
    typeof enabled === "boolean"
      ? [
          {
            permission: tool === "write" || tool === "patch" ? "edit" : tool,
            pattern: "*",
            action: enabled ? ("allow" as const) : ("deny" as const),
            part: "config" as const,
            from: { kind: "config-tools" as const, path },
          },
        ]
      : [],
  )
  const written = OperatorPermissionRules.writtenRules(value.permission).map((rule) => ({
    ...rule,
    pattern: OperatorPermissionRules.expand(rule.pattern),
    part: "config" as const,
    from: { kind: "config-permission" as const, path },
  }))
  return [...switched, ...written]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const rules = yield* OperatorPermissionRules.Service
    const operatorConfig = yield* OperatorConfig.Service
    const written = new Map<string, ReadonlyArray<Rule>>()

    // A project that reloads has read what was written; every project, after a global reload.
    const onEvent = (event: GlobalEvent) => {
      const type = (event.payload as { type?: string } | undefined)?.type
      if (type === "global.disposed") return written.clear()
      if (type !== "server.instance.disposed" || !event.directory) return
      for (const key of written.keys()) if (key.startsWith(`${event.directory}\u0000`)) written.delete(key)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    // The config levels, from the files as they are now.
    const configLevels = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const inherit = yield* OperatorNamespaceScope.inheritsGlobal(ctx.directory, ctx.worktree)
      const { sources } = yield* operatorConfig.layers()
      const of = (kinds: ReadonlyArray<string>) =>
        sources
          .filter((source) => kinds.includes(source.kind))
          .flatMap((source) => configLines(source.path, source.text))
      const env = Flag.OPENCODE_PERMISSION
        ? configLines("OPENCODE_PERMISSION", JSON.stringify({ permission: safeJson(Flag.OPENCODE_PERMISSION) }))
        : []
      return {
        global: inherit ? of(["global"]) : [],
        namespace: of(["namespace"]),
        project: [...of(["custom", "project", "directory", "env"]), ...env],
      }
    })

    const lines = Effect.fn("OperatorPermissionLive.lines")(function* (input: LinesInput) {
      const ctx = yield* InstanceState.context
      const directory = input.session?.directory ?? ctx.directory
      // The agent's list as OpenCode loaded it, in parts (with a draft of its own rules, as saving it would
      // write them).
      const labelled = yield* rules.agent(input.agent, input.agentRules)
      const part = (name: OperatorPermissionRules.Part) =>
        labelled.rows
          .filter((row) => row.part === name)
          .map(({ permission, pattern, action, part, from }) => ({ permission, pattern, action, part, from }))
      const pending = input.agentRules ? undefined : written.get(keyOf(directory, input.agent))
      const own: Array<Rule & Meta> = pending
        ? pending.map((rule) => ({ ...plain(rule), part: "agent", from: { kind: "agent-written" } }))
        : part("agent")
      const config = yield* configLevels()
      const locked = locks.of
        ? yield* locks.of({
            directory,
            agent: input.agent,
            ...((input.session?.parentID ?? input.parentID)
              ? { parentID: input.session?.parentID ?? input.parentID! }
              : {}),
          })
        : { keys: [], inherited: [] }
      const inherited = locked.inherited.map((rule) => ({
        ...plain(rule),
        part: "agent" as const,
        from: { kind: "lock" as const },
      }))
      const session: Array<Rule & Meta> =
        input.permission === "doom_loop"
          ? []
          : (input.sessionLines ?? input.session?.permission ?? []).map((rule: Rule & Partial<Meta>) => ({
              ...plain(rule),
              part: rule.part ?? "session",
              from: rule.from ?? { kind: "session-opencode" },
            }))
      return Model.build<Meta>([
        { lines: [...part("opencode"), ...part("truncation")] },
        { lines: config.global },
        { lines: config.namespace },
        { lines: config.project },
        { lines: [...inherited, ...own], locks: [...inherited, ...locked.keys] },
        { lines: session },
      ])
    })

    const sessionLines = Effect.fnUntraced(function* (sessionID: string, permission?: string) {
      const info = yield* sessions.get(SessionID.make(sessionID))
      // A session started without an agent has the agent new sessions start with.
      const agent = info.agent ?? (yield* agents.defaultAgent())
      return { info, agent, built: yield* lines({ agent, session: info, ...(permission ? { permission } : {}) }) }
    })

    // What an ask checks last. When it was given the agent's rules (a tool's ask, doom_loop), one exact
    // rule per input, as the lines decide it. An ask that passes its own narrower list (the workflow tool
    // approval: none, so it always asks; /merge: only the deny rules) keeps it, and only the agent's
    // rules saved since, the session's rules and the locked lines follow it, so they still apply.
    const hookRules = Effect.fn("OperatorPermissionLive.hookRules")(function* (input: {
      sessionID: string
      permission: string
      patterns: ReadonlyArray<string>
      given: ReadonlyArray<Rule>
    }) {
      const { info, agent, built } = yield* sessionLines(input.sessionID, input.permission)
      const loaded = (yield* agents.get(agent).pipe(Effect.orElseSucceed(() => undefined)))?.permission ?? []
      if (startsWith(input.given, loaded)) return Model.exact(built.lines, input.permission, input.patterns)
      return [
        ...(written.get(keyOf(info.directory, agent)) ?? []),
        ...(input.permission === "doom_loop" ? [] : (info.permission ?? [])),
        ...built.lines.filter((line) => line.lockedAt !== undefined).map(plain),
      ]
    })

    // R for a list upstream builds (permission-effective.ts): the lines, and one ordered list of them.
    const effective = Effect.fn("OperatorPermissionLive.effective")(function* (
      input: Parameters<NonNullable<typeof OperatorPermissionEffective.handlers.effective>>[0],
    ) {
      const info = input.sessionID ? yield* sessions.get(SessionID.make(input.sessionID)) : undefined
      const built = yield* lines({
        agent: input.agent,
        ...(info ? { session: info } : {}),
        ...(!info && input.session ? { sessionLines: input.session } : {}),
        ...(input.draft?.agentRules ? { agentRules: input.draft.agentRules } : {}),
        ...(input.draft?.sessionRules ? { sessionLines: input.draft.sessionRules } : {}),
        ...(input.permission ? { permission: input.permission } : {}),
      })
      return { lines: built.lines, rules: Model.compile(built.lines) }
    })

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorPermissionHook.handlers.rules = (input) => hookRules(input).pipe(Effect.orElseSucceed(() => []))
        OperatorPermissionEffective.handlers.effective = (input) => effective(input).pipe(Effect.orDie)
      }),
      () =>
        Effect.sync(() => {
          OperatorPermissionHook.handlers.rules = undefined
          OperatorPermissionEffective.handlers.effective = undefined
        }),
    )

    return Service.of({
      written: (input) => Effect.sync(() => written.set(keyOf(input.directory, input.agent), [...input.rules])),
      pending: (directory, agent) => written.get(keyOf(directory, agent)) ?? [],
      lines,
      decide: (sessionID, permission, input) =>
        sessionLines(sessionID, permission).pipe(
          Effect.map(({ built }) => Model.decide(built.lines, permission, input)),
          Effect.catchCause(() => Effect.succeed<Model.Decision<Meta>>({ action: "ask" })),
        ),
    })
  }),
)

function safeJson(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, OperatorPermissionRules.node, OperatorConfig.node],
})
