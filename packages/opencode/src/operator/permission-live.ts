export * as OperatorPermissionLive from "./permission-live"

import { Config } from "@/config/config"
import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgents } from "./agents"
import { OperatorConfig } from "./config"
import { OperatorFileCache } from "./file-cache"
import { OperatorLayout } from "./layout"
import { OperatorNamespaceScope } from "./namespace-scope"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorPermissionHook } from "./permission-hook"
import { OperatorPermissionMarks } from "./permission-marks"
import { OperatorProjectConfig } from "./project-config"
import { OperatorPermissionModel as Model } from "./permission-model"
import { OperatorPermissionRules } from "./permission-rules"
import { OperatorSubagentMemory } from "./subagent-memory"
import { OperatorProjects } from "./projects"

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
  /** The agent; without one, OpenCode's defaults stand for the OpenCode level (the namespace and project views). */
  agent?: string
  /** The namespace level of this namespace instead of the project's (the namespace view). */
  namespace?: string
  /** Only the levels down to this one. */
  upTo?: OperatorPermissionRules.Level
  /** A namespace's or project's unsaved lines and marks, in place of what is saved. */
  draft?: {
    level: "namespace" | "project"
    lines: ReadonlyArray<Rule>
    marks: OperatorPermissionMarks.Marks
  }
  /** The session whose rules and parent apply. */
  session?: Session.Info
  /** The session that started this agent's session, without one (Runs as Subagent, started from it). */
  parentID?: string
  /** In place of the session's rules (a draft, or the rules `task` gives a subagent); labelled or not. */
  sessionLines?: ReadonlyArray<Rule & Partial<Meta>>
  /** A draft of the agent's own rules, in place of its saved ones. */
  agentRules?: ReadonlyArray<Rule>
  /** In place of the inherited lines the session deletes (a draft). */
  sessionDeleted?: ReadonlyArray<Model.Key>
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

// What an agent locks (fixes_spec §4.2) and deletes, registered by the locks service: its lock keys, the
// inherited lines it deletes, and its parent session's agent's locked rules when it inherits them.
export const locks: {
  of?: (input: { directory: string; agent: string; parentID?: string }) => Effect.Effect<{
    keys: ReadonlyArray<Model.Key>
    deleted: ReadonlyArray<Model.Key>
    inherited: ReadonlyArray<Rule>
    /** The files they are read from. */
    files?: ReadonlyArray<string>
  }>
} = {}

// The inherited lines a session deletes, registered by the session permissions service.
export const sessionMarks: { deleted?: (sessionID: string) => Promise<ReadonlyArray<Model.Key>> } = {}

// A config file's text, parsed (JSONC).
export function parseConfig(text: string) {
  const value = parse(text) as Record<string, unknown> | undefined
  return value && typeof value === "object" ? value : undefined
}

const keyOf = (directory: string, agent: string) => `${directory}\u0000${agent}`
const same = (a: Rule, b: Rule | undefined) =>
  !!b && a.permission === b.permission && a.pattern === b.pattern && a.action === b.action
const startsWith = (list: ReadonlyArray<Rule>, prefix: ReadonlyArray<Rule>) =>
  prefix.length <= list.length && prefix.every((rule, index) => same(rule, list[index]))
const plain = ({ permission, pattern, action }: Rule): Rule => ({ permission, pattern, action })

// A config file's lines: its legacy `tools` switches (edit, write and patch are `edit`), then its
// `permission`, which wins for the same permission and pattern (as config.ts merges them).
function configLines(path: string, text: string): Array<Rule & Meta> {
  const value = parseConfig(text)
  if (!value) return []
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
    const config = yield* Config.Service
    const operatorAgents = yield* OperatorAgents.Service
    const written = new Map<string, ReadonlyArray<Rule>>()

    // What changes the kept levels besides files (below): an instance's reload, rules just written.
    const onChange: Array<(directory?: string) => void> = []

    // A project that reloads has read what was written; every project, after a global reload.
    const onEvent = (event: GlobalEvent) => {
      const type = (event.payload as { type?: string } | undefined)?.type
      if (type === "global.disposed") {
        written.clear()
        for (const change of onChange) change()
        return
      }
      if (type !== "server.instance.disposed" || !event.directory) return
      for (const key of written.keys()) if (key.startsWith(`${event.directory}\u0000`)) written.delete(key)
      for (const change of onChange) change(event.directory)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    // The config levels, from the files as they are now (a draft in place of its level's file), and the
    // namespace's and project's marks.
    const configLevels = Effect.fnUntraced(function* (namespace?: string, draft?: LinesInput["draft"]) {
      const ctx = yield* InstanceState.context
      const ns = yield* operatorConfig.namespaceOf(namespace)
      const inherit = (yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(ns))).inherit
      // Global's lines and marks are the Global level (for every namespace that inherits it); for Global
      // itself (or "Global · OpenCode") they are its own level, and it has no namespace level.
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const isGlobal = OperatorLayout.isGlobal(ns, layout)
      const layers = yield* operatorConfig.layers(namespace)
      const target = draft ? layers.targets[draft.level] : undefined
      const of = (kinds: ReadonlyArray<string>) =>
        layers.sources
          .filter((source) => kinds.includes(source.kind) && source.path !== target)
          .flatMap((source) => configLines(source.path, source.text))
      const drafted = (level: "namespace" | "project") =>
        draft?.level === level && target
          ? draft.lines.map((rule) => ({
              ...plain(rule),
              part: "config" as const,
              from: { kind: "config-permission" as const, path: target },
            }))
          : []
      const env = Flag.OPENCODE_PERMISSION
        ? configLines("OPENCODE_PERMISSION", JSON.stringify({ permission: safeJson(Flag.OPENCODE_PERMISSION) }))
        : []
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      // Every file these levels come from, and every place a config file could appear and be read: the
      // walk from the folder up to its worktree (or the root, outside git), as upstream's loader walks.
      const walk: string[] = []
      for (let dir = path.resolve(ctx.directory); ; dir = path.dirname(dir)) {
        walk.push(dir)
        if (dir === ctx.worktree || dir === path.dirname(dir)) break
      }
      const configFile = (dir: string) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]
      const files = [
        ...layers.sources.filter((source) => source.path !== "OPENCODE_CONFIG_CONTENT").map((source) => source.path),
        path.join(Global.Path.config, "config.json"),
        ...configFile(Global.Path.config),
        ...configFile(path.join(Global.Path.home, ".opencode")),
        ...(layers.targets.namespace ? configFile(path.dirname(layers.targets.namespace)) : []),
        ...(Flag.OPENCODE_CONFIG ? [Flag.OPENCODE_CONFIG] : []),
        ...(Flag.OPENCODE_CONFIG_DIR ? configFile(Flag.OPENCODE_CONFIG_DIR) : []),
        ...walk.flatMap((dir) => [...configFile(dir), ...configFile(path.join(dir, ".opencode"))]),
        ...(yield* Effect.promise(() => OperatorLayout.watched())),
        path.join(Global.Path.config, "namespaces", "projects.json"),
        OperatorPermissionMarks.namespaceFile(ns),
        OperatorPermissionMarks.namespaceFile(OperatorLayout.globalId(layout)),
        OperatorPermissionMarks.projectFile(),
      ]
      const namespaceMarks = isGlobal
        ? OperatorPermissionMarks.EMPTY
        : draft?.level === "namespace"
          ? draft.marks
          : yield* Effect.promise(() => OperatorPermissionMarks.namespaceMarks(ns))
      // A project with its own config has a copy of its namespace's lines (and deletions) but the locked
      // ones: those keep applying from the namespace's file (global_and_opencode_namespaces_spec.md §7).
      const copied = !namespace && !isGlobal && layers.project === "own"
      const namespaceLines = copied
        ? yield* Effect.promise(async () => {
            const source = await OperatorProjectConfig.namespaceConfig(ns)
            return source.text === undefined
              ? []
              : configLines(source.file, source.text).filter((line) =>
                  namespaceMarks.locks.some(
                    (key) => key.permission === line.permission && key.pattern === line.pattern,
                  ),
                )
          })
        : [...of(["namespace"]), ...drafted("namespace")]
      return {
        namespace: ns,
        files,
        protectBuiltins: OperatorLayout.builtinsProtected(ns, layout),
        lines: {
          global: inherit || isGlobal ? [...of(["global"]), ...(isGlobal ? drafted("namespace") : [])] : [],
          namespace: isGlobal ? [] : namespaceLines,
          project: [...of(["project", "directory", "env"]), ...drafted("project"), ...env],
        },
        marks: {
          global:
            isGlobal && draft?.level === "namespace"
              ? draft.marks
              : inherit || isGlobal
                ? yield* Effect.promise(() => OperatorPermissionMarks.namespaceMarks(OperatorLayout.globalId(layout)))
                : OperatorPermissionMarks.EMPTY,
          namespace: copied ? { deleted: [], locks: namespaceMarks.locks } : namespaceMarks,
          project:
            draft?.level === "project"
              ? draft.marks
              : yield* Effect.promise(() => OperatorPermissionMarks.projectMarks(project)),
        },
      }
    })

    // Levels 0-4 (OpenCode, Global, Namespace, Project, Agent): the same for every session of an agent in a
    // folder, so built once and kept (the effective set is needed for every ask and every model request).
    const baseLevels = Effect.fnUntraced(function* (input: LinesInput, directory: string) {
      // The agent's list as OpenCode loaded it, in parts (with a draft of its own rules, as saving it would
      // write them). Without an agent, OpenCode's defaults (the agent new sessions start with gives them).
      const agent = input.agent ?? (yield* agents.defaultAgent())
      const labelled = yield* rules.agent(agent, input.agentRules)
      const part = (name: OperatorPermissionRules.Part) =>
        labelled.rows
          .filter((row) => row.part === name && (input.agent || row.from.kind !== "opencode-agent"))
          .map(({ permission, pattern, action, part, from }) => ({ permission, pattern, action, part, from }))
      const pending = input.agentRules ? undefined : written.get(keyOf(directory, agent))
      const own: Array<Rule & Meta> = pending
        ? pending.map((rule) => ({ ...plain(rule), part: "agent", from: { kind: "agent-written" } }))
        : part("agent")
      const config = yield* configLevels(input.namespace, input.draft)
      const parentID = input.session?.parentID ?? input.parentID
      const locked =
        locks.of && input.agent
          ? yield* locks.of({ directory, agent: input.agent, ...(parentID ? { parentID } : {}) })
          : { keys: [], deleted: [], inherited: [], files: [] }
      const inherited = locked.inherited.map((rule) => ({
        ...plain(rule),
        part: "agent" as const,
        from: { kind: "lock" as const },
      }))
      const file = yield* operatorAgents.fileOf(agent)
      const levels: Model.Level<Meta>[] = [
        { lines: [...part("opencode"), ...part("truncation")] },
        { lines: config.lines.global, ...config.marks.global },
        { lines: config.lines.namespace, ...config.marks.namespace },
        { lines: config.lines.project, ...config.marks.project },
        { lines: [...inherited, ...own], deleted: locked.deleted, locks: [...inherited, ...locked.keys] },
      ]
      return {
        levels,
        protectBuiltins: config.protectBuiltins,
        files: [...config.files, ...(locked.files ?? []), ...(file ? [file] : [])],
        // A parent's locks come from its session and its agent's lines: not kept.
        keep: !locked.inherited.length,
      }
    })

    // The kept base levels, by folder, agent and namespace view. One is used while every file it came from
    // has the same stamp (OperatorFileCache: a change anywhere, a hand edit included, shows on the next
    // ask) and its folder's generation is the same: the generation changes when the instance reloads (the
    // agents and config OpenCode loaded) and when an agent's rules are written. Drafts are never kept.
    type Base = {
      levels: Model.Level<Meta>[]
      protectBuiltins: boolean
      files: ReadonlyArray<string>
      keep: boolean
    }
    const bases = new Map<string, { base: Base; stamps: ReadonlyArray<string>; generation: string }>()
    const generations = new Map<string, number>()
    let generationAll = 0
    const generationOf = (directory: string) => `${generationAll}:${generations.get(directory) ?? 0}`
    const changed = (directory?: string) => {
      if (directory === undefined) generationAll++
      else generations.set(directory, (generations.get(directory) ?? 0) + 1)
    }
    onChange.push(changed)

    const kept = Effect.fnUntraced(function* (input: LinesInput, directory: string) {
      if (input.draft || input.agentRules) return yield* baseLevels(input, directory)
      const parentID = input.session?.parentID ?? input.parentID ?? ""
      const key = [
        directory,
        input.agent ?? "",
        input.agent ? "agent" : "defaults",
        input.namespace ?? "",
        parentID,
      ].join("\u0000")
      const generation = generationOf(directory)
      const found = bases.get(key)
      if (found && found.generation === generation) {
        const now = yield* Effect.promise(() => OperatorFileCache.stamps(found.base.files))
        if (now.every((stamp, index) => stamp === found.stamps[index])) return found.base
      }
      const base = yield* baseLevels(input, directory)
      // Stamped after the build: a file changed meanwhile shows as changed on the next ask.
      const stamps = yield* Effect.promise(() => OperatorFileCache.stamps(base.files))
      if (base.keep && generationOf(directory) === generation) {
        if (bases.size >= 500) bases.clear()
        bases.set(key, { base, stamps, generation })
      }
      return base
    })

    const lines = Effect.fn("OperatorPermissionLive.lines")(function* (input: LinesInput) {
      const ctx = yield* InstanceState.context
      const directory = input.session?.directory ?? ctx.directory
      const base = yield* kept(input, directory)
      const sessionDeleted =
        input.sessionDeleted ??
        (input.session && sessionMarks.deleted
          ? yield* Effect.promise(() => sessionMarks.deleted!(input.session!.id)).pipe(Effect.orElseSucceed(() => []))
          : [])
      const session: Array<Rule & Meta> =
        input.permission === "doom_loop"
          ? []
          : (input.sessionLines ?? input.session?.permission ?? []).map((rule: Rule & Partial<Meta>) => ({
              ...plain(rule),
              part: rule.part ?? "session",
              from: rule.from ?? { kind: "session-opencode" },
            }))
      // An incognito subagent's session (subagent-memory.ts): its memory lines, locked from OpenCode's level so
      // that no line below lifts them, not even a narrower allow of the agent's (a lock binds only the levels
      // below it). They stay the session's lines (part and origin).
      const incognito =
        input.permission !== "doom_loop" &&
        OperatorSubagentMemory.incognito(input.session, (yield* config.get()).agent?.[input.agent ?? ""])
      const locked: Array<Rule & Meta> = incognito
        ? OperatorSubagentMemory.LINES.map((rule) => ({
            ...rule,
            part: "session" as const,
            from: { kind: "session-incognito" as const },
          }))
        : []
      const [top, ...below] = base.levels
      const levels: Model.Level<Meta>[] = [
        locked.length
          ? { ...top!, lines: [...top!.lines, ...locked], locks: [...(top!.locks ?? []), ...locked] }
          : top!,
        ...below,
        { lines: session, deleted: sessionDeleted },
      ]
      const upTo = input.upTo ? LEVEL[input.upTo] : levels.length - 1
      // OpenCode's own lines can't be deleted in the OpenCode namespace.
      return Model.build<Meta>(levels.slice(0, upTo + 1), {
        keep: (line) => base.protectBuiltins && line.level === LEVEL.opencode,
      })
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
      // The fork's opt-in tools this agent is offered here (memory-service.ts).
      const hook = OperatorPermissionEffective.handlers.offered
      const offered = hook
        ? yield* hook({
            ...(input.sessionID ? { sessionID: input.sessionID } : {}),
            agent: input.agent,
            lines: built.lines,
          }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
        : []
      return { lines: built.lines, rules: Model.compile(built.lines), ...(offered.length ? { offered } : {}) }
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
      written: (input) =>
        Effect.sync(() => {
          written.set(keyOf(input.directory, input.agent), [...input.rules])
          for (const change of onChange) change(input.directory)
        }),
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
  deps: [Session.node, Agent.node, OperatorPermissionRules.node, OperatorConfig.node, OperatorAgents.node, Config.node],
})
