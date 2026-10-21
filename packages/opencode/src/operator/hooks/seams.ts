export * as OperatorHookSeams from "./seams"

import path from "path"
import type { Plugin } from "@opencode-ai/plugin"
import { Context, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { NamedError } from "@opencode-ai/core/util/error"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { OperatorFileCache } from "../file-cache"
import { OperatorHelperAgents } from "../helper-agents"
import { OperatorProfileStore } from "../profile-store"
import { OperatorPermissionDecisions } from "../permission-decisions"
import { OperatorPermissionHook } from "../permission-hook"
import { OperatorProjects } from "../projects"
import type { OperatorHookEvents } from "./events"
import { OperatorHooks } from "./hooks"
import { OperatorHookProtocol } from "./protocol"
import { OperatorHookRuns } from "./runs"

// Every tie between hooks and OpenCode (SPEC-0022 §12.4), in this one module, so moving to upstream's V2
// replaces it and nothing else: the plugin hooks, the composition with the permission seam and the GlobalBus
// listeners. It turns each OpenCode event into §7.6's plain input object and applies the answer back; the
// rest of hooks (config, resolve, runner, protocol, run log, routes) never imports session code. The event
// names of §5 stay as they are; here they meet whatever OpenCode calls its points:
//
//   prompt.submitted               chat.message                            (V2: session hook `prompt`)
//   turn.before, step.before       experimental.chat.messages.transform    (V2: session hook `context`)
//   tool.*, subagent.*             tool.execute.before / after             (V2: tool execute.before / after)
//   permission.asked               OperatorPermissionHook                  (V2: permission `evaluate`)
//   compaction.before              experimental.session.compacting         (V2: session hook `compaction`)
//   compaction.after               experimental.compaction.autocontinue    (V2: none found)
//   watch events, failed tool.after, a deleted session's runs, announcing a run
//                                  GlobalBus                               (V2: `event.subscribe`)
//
// The plugin is one of the fork's built-in plugins (operator/plugins.ts), which run before the user's, so a
// hook sees what the model asked for before any user plugin changes it.

/** OpenCode's tool that starts a subagent: its calls are `subagent.*`, not `tool.*` (§5). */
const TASK = "task"
/** MCP's resource tools read their input before `tool.execute.before` runs, so a hook can't change it (§8.2). */
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
/** OpenCode's side calls, which share their session's id: they never run tools, and hooks don't fire there. */
const SIDE_AGENTS = new Set(["title", "summary", "compaction"])

/** What a tool part carries about the hooks that ran on its call (`metadata.hook`), for the session views. */
export type Marks = {
  input?: { by: OperatorHooks.By[]; original: unknown }
  prompt?: { by: OperatorHooks.By[]; original: unknown }
  output?: { by: OperatorHooks.By[]; original: unknown }
  /** A tool.after / subagent.after hook failed and fails closed: the model got its reason, not the output. */
  withheld?: OperatorHooks.By & { reason: string }
  context?: Array<OperatorHooks.By & { event: string; text: string }>
}

type Turn = { agent?: string; model?: { provider: string; id: string } }
// A session the store may no longer have (session.deleted): as its event describes it.
type Known = { id: string; parentID?: string; title?: string; agent?: string }
type Message = {
  info: Record<string, any> & { id: string; role: string; sessionID: string }
  parts: Array<Record<string, any>>
}
type ToolInput = { tool: string; sessionID: string; callID: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

// A small map that forgets its oldest entries.
function bounded<V>(limit = 2000) {
  const map = new Map<string, V>()
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: V) => {
      map.delete(key)
      map.set(key, value)
      if (map.size > limit) map.delete(map.keys().next().value!)
    },
    take: (key: string) => {
      const value = map.get(key)
      map.delete(key)
      return value
    },
    delete: (key: string) => map.delete(key),
    /** The newest entry that fits. */
    newest: (fits: (value: V) => boolean) => [...map.values()].findLast(fits),
  }
}

// What a step's model call says about its session: the agent running it and the model. Tool calls come from
// the step's own model call, so its `chat.params` precedes them.
const turns = bounded<Turn>()
// Per tool call: when it started, its tool, and what its before-hooks changed and added (applied after it ran).
const started = bounded<number>()
const toolNames = bounded<string>()
const pending = bounded<Pick<Marks, "input" | "prompt"> & { context: NonNullable<Marks["context"]> }>()
// Calls a hook denied: their failure isn't a `tool.after`.
const denied = bounded<true>()
// Parts already handled: failed tool calls and step finishes (a part's updates repeat its state).
const seen = bounded<true>()
// Per fiber: the slash command a prompt comes from (`command.execute.before` runs just before the prompt, in the same
// fiber), and compaction's own model call (`experimental.session.compacting` runs just before its transform).
const commands = new WeakMap<object, { command: string; arguments: string }>()
const compacting = new WeakSet<object>()
// Per session: the turn its model calls belong to (its last user message), the turn's number and the step reached.
const steps = bounded<{ user: string; turn: number; step: number }>(1000)

// Running calls of the tools that edit files (`file.edited` names only the file), and the sessions busy since they
// were last idle (a turn ends when a busy session goes idle; session.idle and session.status idle both come).
const EDIT_TOOLS = new Set(["write", "edit", "apply_patch"])
const editing = bounded<{ directory: string; sessionID: string; tool: string; callID: string }>(500)
const busy = bounded<true>(1000)
// The tools each step's response asked for, from its tool parts as they come (before its step-finish part).
const stepTools = bounded<Set<string>>(500)

/** The event `operator.hook.refused`: a hook refused a message, which wasn't saved; the composer gets it back. */
export const REFUSED = "operator.hook.refused"

// The project and namespace of a folder, for every event's input (§7.6); kept for two seconds.
type Place = Pick<OperatorHookProtocol.Base, "project" | "namespace">
const places = bounded<{ at: number; value: Promise<Place> }>(200)
function placeOf(directory: string) {
  const kept = places.get(directory)
  if (kept && Date.now() - kept.at < 2000) return kept.value
  const value = (async (): Promise<Place> => {
    const project = await OperatorProjects.projectOf(directory)
    if (!project) return {}
    const setting = (await OperatorProfileStore.readProjects())[project.key]
    const id = setting?.namespace ?? "opencode"
    const record = await OperatorFileCache.json(path.join(OperatorProfileStore.root(), id, "namespace.json"))
    return {
      project: { id: setting?.id ?? project.key, name: path.basename(project.key), folder: project.key },
      namespace: { id, name: isRecord(record) && typeof record.name === "string" ? record.name : id },
    }
  })().catch((): Place => ({}))
  places.set(directory, { at: Date.now(), value })
  return value
}

// A tool's result as the text the model gets: OpenCode's tools give `output`; MCP tools give `content`.
function textOf(output: Record<string, unknown>) {
  if (typeof output.output === "string") return output.output
  if (!Array.isArray(output.content)) return ""
  return output.content
    .filter((item): item is { type: "text"; text: string } => isRecord(item) && item.type === "text")
    .map((item) => item.text)
    .join("\n\n")
}
function setText(output: Record<string, unknown>, text: string) {
  if (typeof output.output === "string" || !Array.isArray(output.content)) {
    output.output = text
    return
  }
  output.content = [
    { type: "text", text },
    ...output.content.filter((item) => !(isRecord(item) && item.type === "text")),
  ]
}

// The model sees each context under a header naming its hook (§8.3), after the tool's result.
const withContexts = (text: string, contexts: NonNullable<Marks["context"]>) =>
  [text, ...contexts.map((item) => OperatorHookProtocol.contextBlock(item.hook, item.text))].join("\n\n")

const deniedText = (by: NonNullable<OperatorHooks.Chained["denied"]>) =>
  by.reason ? `Denied by hook ${by.hook}: ${by.reason}` : `Denied by hook ${by.hook}.`

// The seams the plugin calls, while a server runs (plugins can't reach Effect services).
type Seams = {
  toolBefore: (instance: unknown, input: ToolInput, output: { args: unknown }) => Promise<string | undefined>
  toolAfter: (instance: unknown, input: ToolInput & { args: unknown }, output: unknown) => Promise<void>
  prompt: (
    instance: unknown,
    input: PromptInput,
    output: { message: unknown; parts: unknown[] },
  ) => Promise<string | undefined>
  step: (instance: unknown, output: { messages: unknown[] }) => Promise<string | undefined>
  compacting: (instance: unknown, input: { sessionID: string }, output: { context: string[] }) => Promise<void>
  autocontinue: (
    instance: unknown,
    input: {
      sessionID: string
      agent: string
      model: { providerID: string; id: string }
      message: { id: string }
    },
    output: { enabled: boolean },
  ) => Promise<void>
}

// The servers running, newest last: only the newest acts (a test process builds several in turn, and an older one
// takes over again when a newer one stops).
const running: Array<{
  token: object
  seams: Seams
  decide: (request: OperatorPermissionHook.Request) => Effect.Effect<OperatorPermissionHook.Decision | undefined>
}> = []
const activeSeams = () => running.at(-1)?.seams

// permission.asked, composed with whatever else answers in that slot (§12.1: compose, never replace): hooks first.
let installed = false
function installDecide() {
  if (installed) return
  installed = true
  const previous = OperatorPermissionHook.handlers.decide
  OperatorPermissionHook.handlers.decide = (request) =>
    Effect.gen(function* () {
      const answer = yield* running.at(-1)?.decide(request) ?? Effect.succeed(undefined)
      return answer ?? (previous ? yield* previous(request) : undefined)
    })
}
const isCurrent = (token: object) => running.at(-1)?.token === token

type PromptInput = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  command?: { command: string; arguments: string }
}

// The request's project instance, from the fiber the plugin hook runs in (before anything is awaited).
function instanceNow() {
  const fiber = Fiber.getCurrent()
  return fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
}

/** The fork's built-in plugin for hooks (operator/plugins.ts lists it). */
export const plugin: Plugin = async () => ({
  "chat.params": async (input) => {
    if (SIDE_AGENTS.has(input.agent)) return
    turns.set(input.sessionID, { agent: input.agent, model: { provider: input.model.providerID, id: input.model.id } })
  },
  "tool.execute.before": async (input, output) => {
    const instance = instanceNow()
    started.set(input.callID, Date.now())
    toolNames.set(input.callID, input.tool)
    if (instance && EDIT_TOOLS.has(input.tool))
      editing.set(input.callID, {
        directory: (instance as { directory: string }).directory,
        sessionID: input.sessionID,
        tool: input.tool,
        callID: input.callID,
      })
    const active = activeSeams()
    if (!instance || !active) return
    const refused = await active.toolBefore(instance, input, output)
    if (refused !== undefined) throw new Error(refused)
  },
  "tool.execute.after": async (input, output) => {
    const instance = instanceNow()
    editing.delete(input.callID)
    const active = activeSeams()
    if (!instance || !active) return
    await active.toolAfter(instance, input, output)
  },
  "command.execute.before": async (input) => {
    const fiber = Fiber.getCurrent()
    if (fiber) commands.set(fiber, { command: input.command, arguments: input.arguments })
  },
  "chat.message": async (input, output) => {
    const fiber = Fiber.getCurrent()
    const command = fiber ? commands.get(fiber) : undefined
    if (fiber) commands.delete(fiber)
    const instance = instanceNow()
    const active = activeSeams()
    if (!instance || !active) return
    const refused = await active.prompt(
      instance,
      {
        sessionID: input.sessionID,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(command ? { command } : {}),
      },
      output,
    )
    if (refused !== undefined) throw new Error(refused)
  },
  "experimental.session.compacting": async (input, output) => {
    const fiber = Fiber.getCurrent()
    if (fiber) compacting.add(fiber)
    const instance = instanceNow()
    const active = activeSeams()
    if (!instance || !active) return
    await active.compacting(instance, input, output)
  },
  "experimental.compaction.autocontinue": async (input, output) => {
    const instance = instanceNow()
    const active = activeSeams()
    if (!instance || !active) return
    await active.autocontinue(
      instance,
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: { providerID: input.model.providerID, id: input.model.id },
        message: { id: input.message.id },
      },
      output,
    )
  },
  "experimental.chat.messages.transform": async (_input, output) => {
    const fiber = Fiber.getCurrent()
    // Compaction's own model call isn't a step: its hooks are compaction.*.
    if (fiber && compacting.has(fiber)) {
      compacting.delete(fiber)
      return
    }
    const instance = instanceNow()
    const active = activeSeams()
    if (!instance || !active) return
    const stopped = await active.step(instance, output)
    if (stopped !== undefined) throw new Error(stopped)
  },
})

// A message's own text: its text parts that aren't OpenCode's.
const messageText = (parts: ReadonlyArray<Record<string, any>>) =>
  parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => String(part.text))
    .join("\n")

// Compaction's automatic "continue" message isn't a turn of its own (§5).
const isContinue = (parts: ReadonlyArray<Record<string, any>>) =>
  parts.length > 0 && parts.some((part) => part.type === "text" && part.metadata?.compaction_continue === true)

// A rough size of what a request sends, for `step.before` (four characters a token).
const estimate = (messages: ReadonlyArray<Message>) =>
  Math.round(
    messages
      .flatMap((message) => message.parts)
      .reduce((sum, part) => {
        if (part.type === "text" || part.type === "reasoning") return sum + String(part.text ?? "").length
        if (part.type === "tool")
          return sum + JSON.stringify(part.state?.input ?? {}).length + String(part.state?.output ?? "").length
        return sum
      }, 0) / 4,
  )

const byOf = ({ hook, level, file, run }: OperatorHooks.By): OperatorHooks.By => ({ hook, level, file, run })

export class Service extends Context.Service<Service, {}>()("@opencode/OperatorHookSeams") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* OperatorHooks.Service
    const sessions = yield* Session.Service
    const registry = yield* ToolRegistry.Service
    const instances = yield* InstanceStore.Service

    // The session's agent and model: from its last model call, else from its last user message.
    const turnOf = Effect.fnUntraced(function* (sessionID: string) {
      const known = turns.get(sessionID)
      if (known) return known
      const found = yield* sessions
        .findMessage(SessionID.make(sessionID), (message) => message.info.role === "user")
        .pipe(Effect.orElseSucceed(() => Option.none()))
      if (Option.isNone(found) || found.value.info.role !== "user") return {}
      const info = found.value.info
      return { agent: info.agent, model: { provider: info.model.providerID, id: info.model.modelID } }
    })

    // What every event sends (§7.6), for a session of the current project.
    const describe = Effect.fnUntraced(function* (
      event: OperatorHookEvents.Name,
      sessionID: string,
      turn: Turn,
      known?: Known,
    ) {
      const ctx = yield* InstanceState.context
      const info = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.option)
      const session: Known | undefined = Option.getOrUndefined(info) ?? known
      const agent = turn.agent ?? session?.agent
      const place = yield* Effect.promise(() => placeOf(ctx.directory))
      const input: OperatorHooks.EventInput = {
        event,
        time: new Date().toISOString(),
        ...(session
          ? { session: { id: session.id, parentID: session.parentID ?? null, title: session.title ?? "" } }
          : {}),
        ...(agent
          ? {
              agent: {
                name: agent,
                type: OperatorHelperAgents.isHelper(agent) ? "helper" : session?.parentID ? "subagent" : "usual",
              },
            }
          : {}),
        ...place,
        cwd: ctx.directory,
        ...(turn.model ? { model: turn.model } : {}),
      }
      const target: OperatorHooks.Target = {
        sessionID,
        ...(place.project ? { project: place.project.folder } : {}),
        ...(agent ? { agent } : {}),
        cwd: ctx.directory,
      }
      return { input, target }
    })

    // A changed tool input must fit the tool's own schema (§8.2). MCP tools check their input themselves.
    const checkInput = (tool: string) => (field: OperatorHooks.Change, value: unknown) =>
      Effect.gen(function* () {
        if (field !== "input") return undefined
        const def = (yield* registry.all()).find((item) => item.id === tool)
        if (!def) return undefined
        const exit = yield* Schema.decodeUnknownEffect(def.parameters)(value).pipe(Effect.exit)
        return Exit.isFailure(exit) ? `its input doesn't fit the ${tool} tool's schema` : undefined
      }).pipe(Effect.orElseSucceed(() => undefined))

    // `@agent` in a message runs the task tool outside a model call, with its part's id as the call's: a
    // deny ends that part as an error, as the model's own calls end.
    const failSubtask = Effect.fnUntraced(function* (sessionID: string, partID: string, error: string) {
      const found = yield* sessions
        .findMessage(SessionID.make(sessionID), (message) => message.parts.some((part) => part.id === partID))
        .pipe(Effect.orElseSucceed(() => Option.none()))
      if (Option.isNone(found)) return
      const part = found.value.parts.find((item) => item.id === partID)
      if (part?.type !== "tool" || part.state.status !== "running") return
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "error",
          input: part.state.input,
          error,
          metadata: part.state.metadata,
          time: { start: part.state.time.start, end: Date.now() },
        },
      })
    })

    const toolBefore = Effect.fnUntraced(function* (input: ToolInput, output: { args: unknown }) {
      const task = input.tool === TASK
      const event = task ? "subagent.before" : "tool.before"
      const args = isRecord(output.args) ? output.args : {}
      const turn = yield* turnOf(input.sessionID)
      const found = yield* hooks.forEvent({
        ...(turn.agent ? { agent: turn.agent } : {}),
        event,
        subject: task ? String(args.subagent_type ?? "") : input.tool,
      })
      if (!found.length) return undefined
      const base = yield* describe(event, input.sessionID, turn)
      const result = yield* hooks.chain(
        found,
        {
          ...base.input,
          ...(task
            ? { callID: input.callID, subagent: args.subagent_type, prompt: args.prompt, description: args.description }
            : // A copy: the original is kept, and the call's own input is changed in place below.
              { tool: input.tool, callID: input.callID, input: structuredClone(args) }),
        },
        { ...base.target, tool: input.tool, callID: input.callID },
        task ? {} : MCP_RESOURCE_TOOLS.has(input.tool) ? { unusable: ["input"] } : { check: checkInput(input.tool) },
      )
      if (result.denied) {
        const text = deniedText(result.denied)
        denied.set(input.callID, true)
        if (task && input.callID.startsWith("prt")) yield* failSubtask(input.sessionID, input.callID, text)
        return text
      }
      const marks: NonNullable<ReturnType<typeof pending.get>> = { context: [] }
      for (const field of ["input", "prompt"] as const) {
        const changes = result.changes.filter((item) => item.field === field)
        if (!changes.length) continue
        marks[field] = {
          by: changes.map(byOf),
          original: changes[0]!.before,
        }
      }
      // The tool runs with the new input: the same object OpenCode passes on, changed in place.
      if (marks.input && isRecord(result.input.input) && isRecord(output.args)) {
        for (const key of Object.keys(output.args)) delete output.args[key]
        Object.assign(output.args, structuredClone(result.input.input))
      }
      if (marks.prompt && isRecord(output.args)) output.args.prompt = result.input.prompt
      marks.context = result.contexts.map((item) => ({ ...item, event }))
      if (marks.input || marks.prompt || marks.context.length) pending.set(input.callID, marks)
      return undefined
    })

    const toolAfter = Effect.fnUntraced(function* (input: ToolInput & { args: unknown }, output: unknown) {
      const start = started.take(input.callID)
      const before = pending.take(input.callID)
      // A failed `@agent` subtask has no result: its part's failure is a watch event (below).
      if (!isRecord(output)) return
      const task = input.tool === TASK
      const event = task ? "subagent.after" : "tool.after"
      const args = isRecord(input.args) ? input.args : {}
      const turn = yield* turnOf(input.sessionID)
      const found = yield* hooks.forEvent({
        ...(turn.agent ? { agent: turn.agent } : {}),
        event,
        subject: task ? String(args.subagent_type ?? "") : input.tool,
      })
      const marks: Marks = { ...before, context: [...(before?.context ?? [])] }
      const original = textOf(output)
      let text = original
      if (found.length) {
        const base = yield* describe(event, input.sessionID, turn)
        const metadata = isRecord(output.metadata) ? output.metadata : {}
        const result = yield* hooks.chain(
          found,
          {
            ...base.input,
            ...(task
              ? {
                  callID: input.callID,
                  subagent: args.subagent_type,
                  ...(typeof metadata.sessionId === "string" ? { childSessionID: metadata.sessionId } : {}),
                  output: text,
                }
              : {
                  tool: input.tool,
                  callID: input.callID,
                  input: args,
                  output: text,
                  ...(typeof output.title === "string" ? { title: output.title } : {}),
                  ...(start ? { durationMs: Date.now() - start } : {}),
                }),
          },
          { ...base.target, tool: input.tool, callID: input.callID },
        )
        const changes = result.changes.filter((item) => item.field === "output")
        if (changes.length) {
          marks.output = { by: changes.map(byOf), original }
          text = String(result.input.output)
        }
        marks.context!.push(...result.contexts.map((item) => ({ ...item, event })))
        // A failed after-hook that fails closed keeps the output from the model (§7.3).
        if (result.denied) {
          const { hook, level, file, run } = result.denied
          const reason = result.denied.reason ?? `Hook ${hook} failed`
          marks.withheld = { hook, level, file, run, reason }
          marks.output ??= { by: [{ hook, level, file, run }], original }
          text = `Output withheld: ${reason}`
          marks.context = []
        }
      }
      if (!marks.input && !marks.prompt && !marks.output && !marks.withheld && !marks.context?.length) return
      if (!marks.context?.length) delete marks.context
      setText(output, marks.context ? withContexts(text, marks.context) : text)
      output.metadata = { ...(isRecord(output.metadata) ? output.metadata : {}), hook: marks }
    })

    // A tool that failed: `tool.after` (or `subagent.after`) as a watch event; nothing can change it (§12.3, 3).
    const toolFailed = Effect.fnUntraced(function* (part: {
      id: string
      sessionID: string
      callID: string
      tool: string
      state: {
        input?: unknown
        error?: string
        metadata?: Record<string, unknown>
        time?: { start?: number; end?: number }
      }
    }) {
      started.delete(part.callID)
      started.delete(part.id)
      pending.delete(part.callID)
      pending.delete(part.id)
      if (denied.take(part.callID) || denied.take(part.id)) return
      const task = part.tool === TASK
      const event = task ? "subagent.after" : "tool.after"
      const args = isRecord(part.state.input) ? part.state.input : {}
      const turn = yield* turnOf(part.sessionID)
      const found = yield* hooks.forEvent({
        ...(turn.agent ? { agent: turn.agent } : {}),
        event,
        subject: task ? String(args.subagent_type ?? "") : part.tool,
      })
      if (!found.length) return
      const base = yield* describe(event, part.sessionID, turn)
      const time = part.state.time
      hooks.watch(
        found,
        {
          ...base.input,
          ...(task
            ? {
                callID: part.callID,
                subagent: args.subagent_type,
                ...(typeof part.state.metadata?.sessionId === "string"
                  ? { childSessionID: part.state.metadata.sessionId }
                  : {}),
                error: part.state.error ?? "",
              }
            : {
                tool: part.tool,
                callID: part.callID,
                input: args,
                error: part.state.error ?? "",
                ...(time?.start && time.end ? { durationMs: time.end - time.start } : {}),
              }),
        },
        { ...base.target, tool: part.tool, callID: part.callID },
      )
    })

    // A context a hook added to a message, as a part of it (OpenCode's own text, marked as the hook's).
    const contextPart = (
      sessionID: string,
      messageID: string,
      item: OperatorHooks.Chained["contexts"][number],
      event: OperatorHookEvents.Name,
    ) => ({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "text" as const,
      synthetic: true,
      text: OperatorHookProtocol.contextBlock(item.hook, item.text),
      metadata: { hook: { context: [{ ...byOf(item), event, text: item.text }] } satisfies Marks },
    })

    // prompt.submitted, before the message is saved: a deny refuses it, a change replaces its text (attachments
    // stay), a context is added to it.
    const prompt = Effect.fnUntraced(function* (input: PromptInput, output: { message: unknown; parts: unknown[] }) {
      const message = output.message as Record<string, any> & { id: string }
      const parts = output.parts as Array<Record<string, any>>
      const agent = input.agent ?? (typeof message.agent === "string" ? message.agent : undefined)
      const found = yield* hooks.forEvent({ ...(agent ? { agent } : {}), event: "prompt.submitted" })
      if (!found.length) return undefined
      const model = input.model ?? message.model
      const base = yield* describe("prompt.submitted", input.sessionID, {
        ...(agent ? { agent } : {}),
        ...(model ? { model: { provider: model.providerID, id: model.modelID } } : {}),
      })
      const text = messageText(parts)
      const result = yield* hooks.chain(
        found,
        {
          ...base.input,
          prompt: text,
          files: parts
            .filter((part) => part.type === "file")
            .map((part) => String(part.filename ?? path.basename(String(part.url ?? "")))),
          ...(input.command ? { command: { name: input.command.command, arguments: input.command.arguments } } : {}),
        },
        base.target,
      )
      if (result.denied) {
        const reason = result.denied.reason
        const refused = reason
          ? `Refused by hook ${result.denied.hook}: ${reason}`
          : `Refused by hook ${result.denied.hook}.`
        // The message isn't saved: the app puts its text back in the composer.
        GlobalBus.emit("event", {
          directory: base.input.cwd,
          payload: {
            type: REFUSED,
            properties: {
              sessionID: input.sessionID,
              messageID: message.id,
              hook: result.denied.hook,
              ...(reason ? { reason } : {}),
              run: result.denied.run,
              message: refused,
              text,
            },
          },
        })
        return refused
      }
      const changes = result.changes.filter((item) => item.field === "prompt")
      if (changes.length) {
        const at = Math.max(
          0,
          parts.findIndex((part) => part.type === "text" && !part.synthetic && !part.ignored),
        )
        const kept = parts.filter((part) => !(part.type === "text" && !part.synthetic && !part.ignored))
        kept.splice(Math.min(at, kept.length), 0, {
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: input.sessionID,
          type: "text",
          text: String(result.input.prompt),
          metadata: { hook: { prompt: { by: changes.map(byOf), original: text } } satisfies Marks },
        })
        parts.splice(0, parts.length, ...kept)
      }
      for (const item of result.contexts) parts.push(contextPart(input.sessionID, message.id, item, "prompt.submitted"))
      return undefined
    })

    // The turn's number in the session: its user messages, compaction's own left out.
    const turnNumber = Effect.fnUntraced(function* (sessionID: string, userID: string) {
      const all = yield* sessions
        .messages({ sessionID: SessionID.make(sessionID) })
        .pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))
      let count = 0
      for (const message of all) {
        if (message.info.role !== "user") continue
        const own = !isContinue(message.parts) && !message.parts.some((part) => part.type === "compaction")
        if (own) count++
        if (message.info.id === userID) break
      }
      return Math.max(1, count)
    })

    // The step's assistant message (created before its request is prepared).
    const stepMessage = Effect.fnUntraced(function* (sessionID: string, userID: string) {
      const found = yield* sessions
        .findMessage(
          SessionID.make(sessionID),
          (message) =>
            message.info.role === "assistant" && message.info.parentID === userID && !message.info.time.completed,
        )
        .pipe(Effect.orElseSucceed(() => Option.none()))
      return Option.isSome(found) && found.value.info.role === "assistant" ? found.value.info : undefined
    })

    // A deny before a model call ends the turn as an error whose message is the hook's reason (the clean stop of
    // §12.3, item 1, needs an upstream edit): its step's message ends with it, as a failed request's does.
    const stop = Effect.fnUntraced(function* (
      sessionID: string,
      userID: string,
      denied: NonNullable<OperatorHooks.Chained["denied"]>,
    ) {
      const text = denied.reason
        ? `Stopped by hook ${denied.hook}: ${denied.reason}`
        : `Stopped by hook ${denied.hook}.`
      const info = yield* stepMessage(sessionID, userID)
      if (info)
        yield* sessions.updateMessage({
          ...info,
          error: new NamedError.Unknown({ message: text }).toObject() as SessionV1.Assistant["error"],
          time: { ...info.time, completed: Date.now() },
        })
      return text
    })

    // turn.before and step.before, as a request is prepared (the messages it sends, before they're converted).
    const step = Effect.fnUntraced(function* (output: { messages: unknown[] }) {
      const messages = output.messages as Message[]
      const index = messages.findLastIndex((message) => message.info.role === "user")
      const last = messages[index]
      if (!last) return undefined
      const sessionID = last.info.sessionID
      const known = steps.get(sessionID)
      const first = known?.user !== last.info.id
      const now = { user: last.info.id, turn: first ? 0 : known!.turn, step: first ? 1 : known!.step + 1 }
      steps.set(sessionID, now)
      const agent = typeof last.info.agent === "string" ? last.info.agent : undefined
      const turnHooks =
        first && !isContinue(last.parts)
          ? yield* hooks.forEvent({ ...(agent ? { agent } : {}), event: "turn.before" })
          : []
      const stepHooks = yield* hooks.forEvent({ ...(agent ? { agent } : {}), event: "step.before" })
      if (!turnHooks.length && !stepHooks.length) return undefined
      if (!now.turn) now.turn = yield* turnNumber(sessionID, last.info.id)
      const model = last.info.model as { providerID: string; modelID: string } | undefined
      const turn: Turn = {
        ...(agent ? { agent } : {}),
        ...(model ? { model: { provider: model.providerID, id: model.modelID } } : {}),
      }
      if (turnHooks.length) {
        const base = yield* describe("turn.before", sessionID, turn)
        const result = yield* hooks.chain(
          turnHooks,
          { ...base.input, turn: now.turn, prompt: messageText(last.parts) },
          base.target,
        )
        if (result.denied) return yield* stop(sessionID, last.info.id, result.denied)
        // Saved with the user message, so every later request has it too.
        for (const item of result.contexts) {
          const part = contextPart(sessionID, last.info.id, item, "turn.before")
          yield* sessions.updatePart(part as unknown as SessionV1.TextPart)
          last.parts.push(part)
        }
      }
      if (stepHooks.length) {
        const base = yield* describe("step.before", sessionID, turn)
        const assistant = yield* stepMessage(sessionID, last.info.id)
        const result = yield* hooks.chain(
          stepHooks,
          {
            ...base.input,
            turn: now.turn,
            step: now.step,
            messages: messages.length,
            tokensEstimate: estimate(messages),
          },
          { ...base.target, ...(assistant ? { messageID: assistant.id } : {}) },
        )
        if (result.denied) return yield* stop(sessionID, last.info.id, result.denied)
        // At the end of this one request, never saved, so the next request doesn't repeat it; the run log keeps it,
        // with its step's message.
        if (result.contexts.length) {
          if (index === messages.length - 1)
            last.parts.push(...result.contexts.map((item) => contextPart(sessionID, last.info.id, item, "step.before")))
          else {
            const id = MessageID.ascending()
            messages.push({
              info: { ...last.info, id },
              parts: result.contexts.map((item) => contextPart(sessionID, id, item, "step.before")),
            })
          }
        }
      }
      return undefined
    })

    // compaction.before: what a hook adds goes to what the compaction is given (no deny in v1, §12.3 item 2).
    const compactionBefore = Effect.fnUntraced(function* (input: { sessionID: string }, output: { context: string[] }) {
      const turn = yield* turnOf(input.sessionID)
      const found = yield* hooks.forEvent({ ...(turn.agent ? { agent: turn.agent } : {}), event: "compaction.before" })
      if (!found.length) return
      const sessionID = SessionID.make(input.sessionID)
      // The request: the newest user message with a compaction part (automatic: the context overflowed).
      const request = yield* sessions
        .findMessage(
          sessionID,
          (message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
        )
        .pipe(Effect.orElseSucceed(() => Option.none()))
      const part = Option.isSome(request) ? request.value.parts.find((item) => item.type === "compaction") : undefined
      const finished = yield* sessions
        .findMessage(
          sessionID,
          (message) => message.info.role === "assistant" && !!message.info.time.completed && !message.info.summary,
        )
        .pipe(Effect.orElseSucceed(() => Option.none()))
      const tokens =
        Option.isSome(finished) && finished.value.info.role === "assistant"
          ? (finished.value.info.tokens.total ??
            finished.value.info.tokens.input +
              finished.value.info.tokens.output +
              finished.value.info.tokens.cache.read)
          : undefined
      const base = yield* describe("compaction.before", input.sessionID, turn)
      const result = yield* hooks.chain(
        found,
        {
          ...base.input,
          reason: part?.type === "compaction" && part.auto ? "overflow" : "requested",
          ...(tokens !== undefined ? { tokens } : {}),
        },
        { ...base.target, ...(Option.isSome(request) ? { messageID: request.value.info.id } : {}) },
      )
      for (const item of result.contexts) output.context.push(OperatorHookProtocol.contextBlock(item.hook, item.text))
    })

    // compaction.after: `continue: false` (or a failed run that fails closed) means no automatic "continue" turn.
    const compactionAfter = Effect.fnUntraced(function* (
      input: { sessionID: string; agent: string; model: { providerID: string; id: string }; message: { id: string } },
      output: { enabled: boolean },
    ) {
      const found = yield* hooks.forEvent({ agent: input.agent, event: "compaction.after" })
      if (!found.length) return
      const base = yield* describe("compaction.after", input.sessionID, {
        agent: input.agent,
        model: { provider: input.model.providerID, id: input.model.id },
      })
      const result = yield* hooks.chain(
        found,
        { ...base.input, autoContinue: output.enabled },
        { ...base.target, messageID: input.message.id },
      )
      if (result.noContinue || result.denied) output.enabled = false
    })

    // A watch event of a session: its hooks queue and run alongside (§7.5).
    const watchSession = Effect.fnUntraced(function* (
      event: OperatorHookEvents.Name,
      sessionID: string,
      fields: Record<string, unknown>,
      extra: Partial<OperatorHooks.Target> & { known?: Known; subject?: string } = {},
    ) {
      const { known, subject, ...target } = extra
      const turn = yield* turnOf(sessionID)
      const agent = turn.agent ?? known?.agent
      const found = yield* hooks.forEvent({
        ...(agent ? { agent } : {}),
        event,
        ...(subject !== undefined ? { subject } : {}),
      })
      if (!found.length) return
      const base = yield* describe(event, sessionID, { ...turn, ...(agent ? { agent } : {}) }, known)
      hooks.watch(found, { ...base.input, ...fields }, { ...base.target, ...target })
    })

    // The turn's number, filled in the first time an event needs it.
    const turnOfSteps = Effect.fnUntraced(function* (sessionID: string) {
      const known = steps.get(sessionID)
      if (!known) return { turn: yield* turnNumber(sessionID, ""), step: 0, user: undefined }
      if (!known.turn) known.turn = yield* turnNumber(sessionID, known.user)
      return known
    })

    // step.after: a model response finished (its step-finish part). `at` is the turn and step when it finished
    // (the next step may have started by now).
    const stepAfter = Effect.fnUntraced(function* (
      part: {
        sessionID: string
        messageID: string
        reason?: string
        cost?: number
        tokens?: { input?: number; output?: number; cache?: { read?: number } }
      },
      at: { turn: number; step: number; user?: string } | undefined,
      tools: ReadonlyArray<string>,
    ) {
      const turn = yield* turnOf(part.sessionID)
      if (!(yield* hooks.forEvent({ ...(turn.agent ? { agent: turn.agent } : {}), event: "step.after" })).length) return
      const known = at?.turn ? at : { ...(yield* turnOfSteps(part.sessionID)), ...(at ? { step: at.step } : {}) }
      yield* watchSession(
        "step.after",
        part.sessionID,
        {
          turn: known.turn,
          step: known.step,
          finish: part.reason ?? "",
          usage: {
            input: part.tokens?.input ?? 0,
            output: part.tokens?.output ?? 0,
            cached: part.tokens?.cache?.read ?? 0,
          },
          cost: part.cost ?? 0,
          tools: [...tools],
        },
        { messageID: part.messageID },
      )
    })

    // turn.after: the session went idle after a turn.
    const turnAfter = Effect.fnUntraced(function* (sessionID: string) {
      const turn = yield* turnOf(sessionID)
      if (!(yield* hooks.forEvent({ ...(turn.agent ? { agent: turn.agent } : {}), event: "turn.after" })).length) return
      const known = yield* turnOfSteps(sessionID)
      const recent = (yield* sessions
        .messages({ sessionID: SessionID.make(sessionID), limit: 200 })
        .pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))).toSorted((a, b) =>
        a.info.id.localeCompare(b.info.id),
      )
      const user =
        known.user ?? recent.findLast((item) => item.info.role === "user" && !isContinue(item.parts))?.info.id
      const answers = recent.flatMap((item) =>
        item.info.role === "assistant" && item.info.parentID === user && !item.info.summary ? [item.info] : [],
      )
      const last = answers.at(-1)
      const finish = !last
        ? "none"
        : last.error
          ? last.error.name === "MessageAbortedError"
            ? "aborted"
            : "error"
          : (last.finish ?? "stop")
      yield* watchSession("turn.after", sessionID, {
        turn: known.turn,
        steps: answers.length,
        finish,
        usage: {
          input: answers.reduce((sum, item) => sum + item.tokens.input, 0),
          output: answers.reduce((sum, item) => sum + item.tokens.output, 0),
          cached: answers.reduce((sum, item) => sum + item.tokens.cache.read, 0),
        },
        cost: answers.reduce((sum, item) => sum + item.cost, 0),
      })
    })

    // file.edited names only the file: its call is the running edit of the same folder, the newest.
    const fileEdited = Effect.fnUntraced(function* (directory: string, file: string) {
      const call = editing.newest((item) => item.directory === directory)
      if (!call) return
      yield* watchSession(
        "file.edited",
        call.sessionID,
        { file, tool: call.tool, callID: call.callID },
        { tool: call.tool, callID: call.callID },
      )
    })

    // permission.asked: a request that would ask the user (every level, lock and approval left it there). A deny
    // rejects it with the reason for the model, an allow lets it through once; a failed run, or no answer, leaves
    // it to the user (§7.3, §8.4). Either answer is a decision record, as the user's would be.
    const permissionAsked = Effect.fnUntraced(function* (request: OperatorPermissionHook.Request) {
      const turn = yield* turnOf(request.sessionID)
      const found = yield* hooks.forEvent({
        ...(turn.agent ? { agent: turn.agent } : {}),
        event: "permission.asked",
        subject: request.permission,
      })
      if (!found.length) return undefined
      const base = yield* describe("permission.asked", request.sessionID, turn)
      const callID = request.tool?.callID
      const tool = callID ? toolNames.get(callID) : undefined
      const result = yield* hooks.chain(
        found,
        {
          ...base.input,
          permission: request.permission,
          patterns: [...request.patterns],
          ...(tool ? { tool } : {}),
          ...(callID ? { callID } : {}),
          metadata: request.metadata,
        },
        { ...base.target, ...(tool ? { tool } : {}), ...(callID ? { callID } : {}) },
      )
      if (result.denied?.failed) return undefined
      const by = result.denied ?? result.allowed
      if (!by) return undefined
      const settings = (yield* Effect.promise(() => OperatorProfileStore.readProjects()))[base.target.project ?? ""]
      const reason = result.denied ? deniedText(result.denied) : undefined
      yield* Effect.promise(() =>
        OperatorPermissionDecisions.recordHook({
          request,
          ...(base.input.session ? { sessionTitle: base.input.session.title } : {}),
          ...(turn.agent ? { agent: turn.agent } : {}),
          directory: base.input.cwd,
          ...(base.target.project
            ? { project: base.target.project, namespace: settings?.namespace ?? "opencode" }
            : {}),
          hook: by.hook,
          decision: result.denied ? "deny" : "allow",
          ...(reason ? { note: reason } : {}),
        }),
      )
      return reason ? { reject: reason } : { allow: true as const }
    })

    const inInstance = <A>(instance: unknown, effect: Effect.Effect<A, unknown, any>) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(InstanceRef, instance as InstanceContext)) as Effect.Effect<
          A,
          unknown,
          never
        >,
      )
    const token = {}
    const seams: Seams = {
      toolBefore: (instance, input, output) =>
        inInstance(
          instance,
          toolBefore(input, output).pipe(
            Effect.catchCause((cause) => Effect.logError("hooks: tool.before", { cause }).pipe(Effect.as(undefined))),
          ),
        ),
      toolAfter: (instance, input, output) =>
        inInstance(
          instance,
          toolAfter(input, output).pipe(Effect.catchCause((cause) => Effect.logError("hooks: tool.after", { cause }))),
        ),
      prompt: (instance, input, output) =>
        inInstance(
          instance,
          prompt(input, output).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("hooks: prompt.submitted", { cause }).pipe(Effect.as(undefined)),
            ),
          ),
        ),
      compacting: (instance, input, output) =>
        inInstance(
          instance,
          compactionBefore(input, output).pipe(
            Effect.catchCause((cause) => Effect.logError("hooks: compaction.before", { cause })),
          ),
        ),
      autocontinue: (instance, input, output) =>
        inInstance(
          instance,
          compactionAfter(input, output).pipe(
            Effect.catchCause((cause) => Effect.logError("hooks: compaction.after", { cause })),
          ),
        ),
      step: (instance, output) =>
        inInstance(
          instance,
          step(output).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("hooks: turn.before / step.before", { cause }).pipe(Effect.as(undefined)),
            ),
          ),
        ),
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        installDecide()
        running.push({
          token,
          seams,
          decide: (request) =>
            permissionAsked(request).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("hooks: permission.asked", { cause }).pipe(Effect.as(undefined)),
              ),
            ),
        })
        // A recorded run is announced for the live views.
        OperatorHookRuns.announce.ran = (run) =>
          GlobalBus.emit("event", { payload: { type: OperatorHookRuns.RAN, properties: run } })
      }),
      () =>
        Effect.sync(() => {
          const at = running.findIndex((item) => item.token === token)
          if (at >= 0) running.splice(at, 1)
          if (!running.length) delete OperatorHookRuns.announce.ran
        }),
    )

    // The watch events, from the bus, in the project the event came from.
    const inProject = (directory: string, label: string, effect: Effect.Effect<void, unknown, any>) =>
      void Effect.runPromise(
        instances
          .provide({ directory }, effect as Effect.Effect<void>)
          .pipe(Effect.catchCause((cause) => Effect.logError(`hooks: ${label}`, { cause }))),
      )
    const onEvent = (event: GlobalEvent) => {
      if (!isCurrent(token)) return
      const payload = event.payload as { type?: string; properties?: Record<string, any> } | undefined
      const properties = payload?.properties ?? {}
      const directory = event.directory
      switch (payload?.type) {
        case "session.created": {
          const info = properties.info as Known | undefined
          if (directory && info?.id)
            inProject(directory, "session.created", watchSession("session.created", info.id, {}))
          return
        }
        case "session.deleted": {
          // A deleted session's runs go with it; its own hooks' runs go to the deleted sessions' log.
          const info = properties.info as Known | undefined
          const id = info?.id ?? properties.sessionID
          if (typeof id !== "string" || !id) return
          void OperatorHookRuns.removeSession(id)
          if (directory)
            inProject(
              directory,
              "session.deleted",
              watchSession(
                "session.deleted",
                id,
                {},
                { log: OperatorHookRuns.DELETED, ...(info ? { known: info } : {}) },
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    turns.delete(id)
                    steps.delete(id)
                  }),
                ),
              ),
            )
          return
        }
        case "session.error": {
          const id = properties.sessionID
          const error = properties.error as { name?: string; data?: { message?: string } } | undefined
          if (directory && typeof id === "string")
            inProject(
              directory,
              "session.error",
              watchSession("session.error", id, {
                error: { name: error?.name ?? "Error", message: error?.data?.message ?? "" },
              }),
            )
          return
        }
        case "session.idle":
        case "session.status": {
          const id = properties.sessionID
          if (typeof id !== "string") return
          if (payload.type === "session.status" && properties.status?.type !== "idle") {
            busy.set(id, true)
            return
          }
          if (directory && busy.take(id)) inProject(directory, "turn.after", turnAfter(id))
          return
        }
        case "file.edited": {
          if (directory && typeof properties.file === "string")
            inProject(directory, "file.edited", fileEdited(directory, properties.file))
          return
        }
        case "message.part.updated": {
          if (!directory) return
          const part = properties.part as Parameters<typeof toolFailed>[0] & {
            type?: string
            messageID: string
            state: { status?: string }
          }
          if (part?.type === "step-finish") {
            if (seen.get(part.id)) return
            seen.set(part.id, true)
            const at = steps.get((part as { sessionID: string }).sessionID)
            const tools = stepTools.take(part.messageID) ?? new Set<string>()
            inProject(
              directory,
              "step.after",
              stepAfter(part as unknown as Parameters<typeof stepAfter>[0], at ? { ...at } : undefined, [...tools]),
            )
            return
          }
          if (part?.type === "tool") {
            const tools = stepTools.get(part.messageID) ?? new Set<string>()
            tools.add(part.tool)
            stepTools.set(part.messageID, tools)
          }
          if (part?.type !== "tool" || part.state?.status !== "error" || seen.get(part.id)) return
          seen.set(part.id, true)
          editing.delete(part.callID)
          inProject(directory, "a failed tool", toolFailed(part))
          return
        }
      }
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )
    return Service.of({})
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorHooks.node, Session.node, ToolRegistry.node, InstanceStore.node],
})
