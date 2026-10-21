export * as OperatorHooks from "./hooks"

import path from "path"
import { parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgents } from "../agents"
import { OperatorConfig } from "../config"
import { OperatorFileCache } from "../file-cache"
import { OperatorLayout } from "../layout"
import { OperatorNamespaceScope } from "../namespace-scope"
import { OperatorProjectConfig } from "../project-config"
import { OperatorProjects } from "../projects"
import { OperatorHookEvents } from "./events"
import { OperatorHookProtocol } from "./protocol"
import { OperatorHookResolve } from "./resolve"
import { OperatorHookRunner } from "./runner"
import { OperatorHookRuns } from "./runs"
import { OperatorHookSettings } from "./settings"

// Hooks (SPEC-0022): which are in force for a project and agent (resolve.ts), running one (runner.ts,
// protocol.ts), the run log (runs.ts) and Settings → Hooks (settings.ts). Everything that ties hooks to
// OpenCode's sessions is in seams.ts (SPEC-0022 §12.4): nothing here imports session code.
//
// The resolved set is looked up on the hottest paths there are (every tool call and model call, ADR-0009):
// it's kept per project folder and agent with the stamps of every file it was read from (and of every place
// such a file could appear), and read again only when one of them changes. A writer changes a file, so a
// save applies at once; so does a hand edit. An event with no hook for it starts no process.

type Hook = OperatorHookResolve.Hook

export const HookView = Schema.Struct({
  name: Schema.String,
  event: Schema.String,
  command: Schema.String.annotate({ description: "The script's absolute path" }),
  script: Schema.String.annotate({ description: "As written in the config file" }),
  args: Schema.Array(Schema.String),
  match: Schema.Array(Schema.String),
  timeout: Schema.optional(Schema.Finite).annotate({ description: "Seconds; absent: the server's default" }),
  onFailure: Schema.Literals(["deny", "allow"]),
  locked: Schema.Boolean,
  enabled: Schema.Boolean,
  description: Schema.optional(Schema.String),
  level: Schema.Literals(OperatorHookResolve.LEVELS),
  file: Schema.String.annotate({ description: "The file that declares it" }),
  state: Schema.Literals(["on", "off", "disabled", "invalid"]).annotate({
    description: "on; off (turned off at a lower level); disabled (enabled: false); invalid (see problems)",
  }),
  offAt: Schema.optional(Schema.Literals(OperatorHookResolve.LEVELS)),
  replaces: Schema.optional(
    Schema.Struct({ level: Schema.Literals(OperatorHookResolve.LEVELS), file: Schema.String }),
  ).annotate({ description: "The inherited hook of the same name this one replaces" }),
  problems: Schema.Array(Schema.String).annotate({
    description: "What's wrong with the entry, or a lock it conflicts with",
  }),
}).annotate({ identifier: "OperatorHook" })

export const Effective = Schema.Struct({
  hooks: Schema.Array(HookView),
  paused: Schema.Boolean.annotate({ description: "Pause all hooks is on: nothing runs" }),
}).annotate({ identifier: "OperatorHooksEffective" })
export type Effective = typeof Effective.Type

export const Settings = Schema.Struct({
  timeout: Schema.Finite.annotate({ description: "Seconds a hook without its own may run (0.1 to 600)" }),
  paused: Schema.Boolean.annotate({ description: "Pause all hooks: nothing runs and nothing is recorded" }),
}).annotate({ identifier: "OperatorHookSettings" })

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorHookInvalid", {
  message: Schema.String,
}) {}

/** Where and for whom a hook runs. */
export type Target = {
  sessionID?: string
  /** The project's folder. */
  project?: string
  agent?: string
  tool?: string
  callID?: string
  cwd: string
  test?: boolean
}

export type Execution = {
  outcome: OperatorHookRuns.Outcome
  answer: OperatorHookProtocol.Answer
  /** Why a run failed, for "Hook <name> failed: <cause>". */
  cause?: string
  record: OperatorHookRuns.Run
}

export interface Interface {
  /** The hooks in force for this project (and agent), every one with its level and state. */
  readonly effective: (agent?: string) => Effect.Effect<Effective>
  /** The hooks that run for an event, in order (none while paused). */
  readonly forEvent: (input: {
    agent?: string
    event: OperatorHookEvents.Name
    subject?: string
  }) => Effect.Effect<ReadonlyArray<Hook>>
  readonly settings: () => Effect.Effect<typeof Settings.Type>
  readonly setSettings: (patch: Partial<typeof Settings.Type>) => Effect.Effect<typeof Settings.Type, InvalidError>
  /** Runs one hook on an event's input and records it; undefined while hooks are paused. */
  readonly execute: (
    hook: Hook,
    input: OperatorHookProtocol.Base & Record<string, unknown>,
    target: Target,
  ) => Effect.Effect<Execution | undefined>
  readonly runs: (filter: OperatorHookRuns.Filter) => Effect.Effect<{ runs: OperatorHookRuns.Run[]; total: number }>
  readonly run: (id: string) => Effect.Effect<OperatorHookRuns.Run | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorHooks") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

// A config file's own hooks and the inherited names it turns off.
function declared(text: string) {
  const value = parse(text) as unknown
  if (!isRecord(value)) return { hooks: {}, disabled: [] as string[] }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {}
  const off = isRecord(capabilities.disabled) ? capabilities.disabled.hooks : undefined
  return {
    hooks: isRecord(value.hooks) ? value.hooks : {},
    disabled: Array.isArray(off) ? off.filter((item): item is string => typeof item === "string") : [],
  }
}

// Only a namespace's locked hooks reach a project with a config of its own: the rest were copied into it.
const lockedOnly = (hooks: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(hooks).filter(([, value]) => isRecord(value) && value.locked === true))

// The folder relative scripts resolve against: a config file's own; for an agent's `.md` file, the config
// folder above `agents/` (where `hooks/` lives).
function baseOf(file: string) {
  const dir = path.dirname(file)
  return file.endsWith(".md") && ["agent", "agents", "mode", "modes"].includes(path.basename(dir))
    ? path.dirname(dir)
    : dir
}

const view = (hook: Hook): typeof HookView.Type => ({
  name: hook.name,
  event: hook.event,
  command: hook.command,
  script: hook.script,
  args: hook.args,
  match: hook.match,
  ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
  onFailure: hook.onFailure,
  locked: hook.locked,
  enabled: hook.enabled,
  ...(hook.description ? { description: hook.description } : {}),
  level: hook.level,
  file: hook.file,
  state: hook.state,
  ...(hook.offAt ? { offAt: hook.offAt } : {}),
  ...(hook.replaces ? { replaces: hook.replaces } : {}),
  problems: hook.problems,
})

/** What a run's result means for its event (§7.3, §8), and the record kept of it. */
export function outcomeOf(
  hook: Hook,
  result: OperatorHookRunner.Result,
): { outcome: OperatorHookRuns.Outcome; answer: OperatorHookProtocol.Answer; ignored: string[]; cause?: string } {
  const event = hook.event as OperatorHookEvents.Name
  if (result.stopped) return { outcome: "stopped by the server", answer: {}, ignored: [], cause: "the server stopped" }
  if (result.timedOut) {
    const seconds = Math.round((hook.timeout ?? 0) * 10) / 10
    return { outcome: "timed out", answer: {}, ignored: [], cause: `timed out after ${seconds || "its"} s` }
  }
  if (result.error) return { outcome: "failed", answer: {}, ignored: [], cause: result.error }
  if (result.exitCode !== 0)
    return {
      outcome: "failed",
      answer: {},
      ignored: [],
      cause: result.signal ? `it was killed (${result.signal})` : `it exited with ${result.exitCode}`,
    }
  const parsed = OperatorHookProtocol.parse(event, result.stdout)
  if (!parsed.ok) return { outcome: "failed", answer: {}, ignored: [], cause: parsed.error }
  const answer = parsed.answer
  const outcome: OperatorHookRuns.Outcome =
    answer.allow === false
      ? "denied"
      : answer.input !== undefined || answer.prompt !== undefined || answer.output !== undefined
        ? "changed"
        : answer.context !== undefined
          ? "context"
          : answer.allow === true
            ? "allowed"
            : answer.continue === false
              ? "denied"
              : parsed.ignored.length
                ? "ok, with ignored fields"
                : "ok"
  return { outcome, answer, ignored: parsed.ignored }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const operatorConfig = yield* OperatorConfig.Service
    const config = yield* Config.Service
    const agents = yield* OperatorAgents.Service
    // A new server starts hooks again (a test's earlier server may have stopped them).
    OperatorHookRunner.resume()
    yield* Effect.addFinalizer(() => Effect.sync(() => OperatorHookRunner.stopAll()))

    const cache = new Map<string, { files: string[]; stamps: string[]; hooks: Hook[] }>()

    // Every level's declarations, and every file they come from or could come from.
    const read = Effect.fnUntraced(function* (agent?: string) {
      const ctx = yield* InstanceState.context
      const layers = yield* operatorConfig.layers()
      const namespace = layers.namespace
      const layout = yield* Effect.promise(() => OperatorLayout.snapshot())
      const isGlobal = OperatorLayout.isGlobal(namespace, layout)
      const inherit =
        isGlobal || (yield* Effect.promise(() => OperatorNamespaceScope.namespaceLayer(namespace))).inherit
      const sources: OperatorHookResolve.Source[] = []
      const add = (
        level: OperatorHookResolve.Level,
        file: string,
        text: string,
        options: { base?: string; only?: (hooks: Record<string, unknown>) => Record<string, unknown> } = {},
      ) => {
        const found = declared(text)
        sources.push({
          level,
          file,
          base: options.base ?? baseOf(file),
          hooks: options.only ? options.only(found.hooks) : found.hooks,
          disabled: found.disabled,
        })
      }
      for (const source of layers.sources) {
        if (source.kind === "global") {
          if (inherit) add("global", source.path, source.text)
          continue
        }
        if (source.kind === "namespace") {
          // A project with a config of its own gets only its namespace's model keys merged; its locked hooks
          // still run from the namespace's file (below).
          if (!source.only) add(isGlobal ? "global" : "namespace", source.path, source.text)
          continue
        }
        // OPENCODE_CONFIG_CONTENT has no file: its relative scripts resolve against the working folder.
        add(
          "project",
          source.path,
          source.text,
          source.variable === "OPENCODE_CONFIG_CONTENT" ? { base: ctx.directory } : {},
        )
      }
      const extra: string[] = []
      if (layers.project === "own" && !isGlobal) {
        const own = yield* Effect.promise(() => OperatorProjectConfig.namespaceConfig(namespace))
        extra.push(own.file)
        if (own.text !== undefined) add("namespace", own.file, own.text, { only: lockedOnly })
      }
      if (agent) {
        const entry = ((yield* config.get()).agent ?? {})[agent] as Record<string, unknown> | undefined
        const file = yield* agents.fileOf(agent).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (file) extra.push(file)
        if (entry)
          sources.push({
            level: "agent",
            file: file ?? `agent ${agent}`,
            base: file ? baseOf(file) : ctx.directory,
            hooks: isRecord(entry.hooks) ? entry.hooks : {},
            disabled: Array.isArray(entry.hooksDisabled)
              ? entry.hooksDisabled.filter((item): item is string => typeof item === "string")
              : [],
          })
      }
      // Where a config file could appear and be read: as permission-live.ts lists them.
      const walk: string[] = []
      for (let dir = path.resolve(ctx.directory); ; dir = path.dirname(dir)) {
        walk.push(dir)
        if (dir === ctx.worktree || dir === path.dirname(dir)) break
      }
      const configFile = (dir: string) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]
      const files = [
        ...layers.sources.filter((source) => !source.variable).map((source) => source.path),
        layers.targets.global,
        layers.targets.project,
        ...(layers.targets.namespace ? [layers.targets.namespace] : []),
        ...configFile(Global.Path.config),
        ...configFile(path.join(Global.Path.home, ".opencode")),
        ...walk.flatMap((dir) => [...configFile(dir), ...configFile(path.join(dir, ".opencode"))]),
        ...extra,
        ...(yield* Effect.promise(() => OperatorLayout.watched())),
        path.join(Global.Path.config, "namespaces", "projects.json"),
      ].filter((file, index, list) => list.indexOf(file) === index)
      return { hooks: OperatorHookResolve.resolve(sources), files }
    })

    const resolved = Effect.fnUntraced(function* (agent?: string) {
      const ctx = yield* InstanceState.context
      const key = `${ctx.directory}\u0000${agent ?? ""}`
      const kept = cache.get(key)
      if (kept) {
        const now = yield* Effect.promise(() => OperatorFileCache.stamps(kept.files))
        if (now.every((stamp, index) => stamp === kept.stamps[index])) return kept.hooks
      }
      const found = yield* read(agent)
      const stamps = yield* Effect.promise(() => OperatorFileCache.stamps(found.files))
      if (cache.size > 500) cache.clear()
      cache.set(key, { files: found.files, stamps, hooks: found.hooks })
      return found.hooks
    })

    const effective = Effect.fn("OperatorHooks.effective")(function* (agent?: string) {
      const settings = yield* Effect.promise(() => OperatorHookSettings.read())
      return { hooks: (yield* resolved(agent)).map(view), paused: settings.paused }
    })

    const forEvent = Effect.fn("OperatorHooks.forEvent")(function* (input: {
      agent?: string
      event: OperatorHookEvents.Name
      subject?: string
    }) {
      if ((yield* Effect.promise(() => OperatorHookSettings.read())).paused) return []
      return OperatorHookResolve.forEvent(yield* resolved(input.agent), input.event, input.subject)
    })

    const execute = Effect.fn("OperatorHooks.execute")(function* (
      hook: Hook,
      input: OperatorHookProtocol.Base & Record<string, unknown>,
      target: Target,
    ) {
      const settings = yield* Effect.promise(() => OperatorHookSettings.read())
      if (settings.paused) return undefined
      const timeout = hook.timeout ?? settings.timeout
      const project = target.project ?? (yield* Effect.promise(() => OperatorProjects.projectOf(target.cwd)))?.key
      const time = Date.now()
      const result = yield* Effect.promise(() =>
        OperatorHookRunner.run({
          command: hook.command,
          args: hook.args,
          cwd: target.cwd,
          env: {
            OPENCODE_HOOK_EVENT: hook.event,
            OPENCODE_HOOK_NAME: hook.name,
            ...(target.sessionID ? { OPENCODE_SESSION_ID: target.sessionID } : {}),
            OPENCODE_PROJECT_DIR: project ?? target.cwd,
          },
          stdin: JSON.stringify(input),
          timeoutMs: Math.round(timeout * 1000),
        }),
      )
      const read = outcomeOf({ ...hook, timeout }, result)
      const record: OperatorHookRuns.Run = {
        id: OperatorHookRuns.newId(target.test ? undefined : target.sessionID),
        time,
        event: hook.event,
        hook: hook.name,
        level: hook.level,
        file: hook.file,
        ...(target.sessionID ? { sessionID: target.sessionID } : {}),
        ...(project ? { project } : {}),
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.tool ? { tool: target.tool } : {}),
        ...(target.callID ? { callID: target.callID } : {}),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        outcome: read.outcome,
        ...(read.cause ? { reason: read.cause } : read.answer.reason ? { reason: read.answer.reason } : {}),
        ...(read.ignored.length ? { ignored: read.ignored } : {}),
        ...(read.answer.context !== undefined ? { context: read.answer.context } : {}),
        ...(result.stdout ? { stdout: result.stdout } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ...(target.test ? { test: true } : {}),
      }
      yield* Effect.promise(() => OperatorHookRuns.record(record))
      return {
        outcome: read.outcome,
        answer: read.answer,
        ...(read.cause ? { cause: read.cause } : {}),
        record: OperatorHookRuns.trimmed(record),
      }
    })

    const setSettings = Effect.fn("OperatorHooks.setSettings")(function* (patch: Partial<typeof Settings.Type>) {
      return yield* Effect.tryPromise({
        try: () => OperatorHookSettings.write(patch),
        catch: (error) => new InvalidError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    return Service.of({
      effective,
      forEvent,
      settings: () => Effect.promise(() => OperatorHookSettings.read()),
      setSettings,
      execute,
      runs: (filter) => Effect.promise(() => OperatorHookRuns.list(filter)),
      run: (id) => Effect.promise(() => OperatorHookRuns.get(id)),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorConfig.node, Config.node, OperatorAgents.node],
})
