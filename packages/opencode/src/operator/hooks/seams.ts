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
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { OperatorFileCache } from "../file-cache"
import { OperatorHelperAgents } from "../helper-agents"
import { OperatorProfileStore } from "../profile-store"
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
  }
}

// What a step's model call says about its session: the agent running it and the model. Tool calls come from
// the step's own model call, so its `chat.params` precedes them.
const turns = bounded<Turn>()
// Per tool call: when it started, and what its before-hooks changed and added (applied after it ran).
const started = bounded<number>()
const pending = bounded<Pick<Marks, "input" | "prompt"> & { context: NonNullable<Marks["context"]> }>()
// Calls a hook denied: their failure isn't a `tool.after`.
const denied = bounded<true>()
// Failed tool parts already seen (a part's updates repeat its state).
const failed = bounded<true>()

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

// The seams the plugin calls, set while the server runs (plugins can't reach Effect services).
let active:
  | {
      toolBefore: (instance: unknown, input: ToolInput, output: { args: unknown }) => Promise<string | undefined>
      toolAfter: (instance: unknown, input: ToolInput & { args: unknown }, output: unknown) => Promise<void>
    }
  | undefined

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
    if (!instance || !active) return
    const refused = await active.toolBefore(instance, input, output)
    if (refused !== undefined) throw new Error(refused)
  },
  "tool.execute.after": async (input, output) => {
    const instance = instanceNow()
    if (!instance || !active) return
    await active.toolAfter(instance, input, output)
  },
})

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
    const describe = Effect.fnUntraced(function* (event: OperatorHookEvents.Name, sessionID: string, turn: Turn) {
      const ctx = yield* InstanceState.context
      const info = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.option)
      const session = Option.getOrUndefined(info)
      const agent = turn.agent ?? session?.agent
      const place = yield* Effect.promise(() => placeOf(ctx.directory))
      const input: OperatorHooks.EventInput = {
        event,
        time: new Date().toISOString(),
        ...(session ? { session: { id: session.id, parentID: session.parentID ?? null, title: session.title } } : {}),
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
          by: changes.map(({ hook, level, file, run }) => ({ hook, level, file, run })),
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
          marks.output = { by: changes.map(({ hook, level, file, run }) => ({ hook, level, file, run })), original }
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

    const inInstance = <A>(instance: unknown, effect: Effect.Effect<A, unknown, any>) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(InstanceRef, instance as InstanceContext)) as Effect.Effect<
          A,
          unknown,
          never
        >,
      )
    const seams: NonNullable<typeof active> = {
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
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        active = seams
      }),
      () =>
        Effect.sync(() => {
          if (active === seams) active = undefined
        }),
    )

    // A recorded run is announced for the live views.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorHookRuns.announce.ran = (run) =>
          GlobalBus.emit("event", { payload: { type: OperatorHookRuns.RAN, properties: run } })
      }),
      () => Effect.sync(() => void delete OperatorHookRuns.announce.ran),
    )

    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: Record<string, unknown> } | undefined
      // A deleted session's runs go with it.
      if (payload?.type === "session.deleted") {
        const id = (payload.properties?.info as { id?: string } | undefined)?.id ?? payload.properties?.sessionID
        if (typeof id === "string" && id) {
          turns.delete(id)
          void OperatorHookRuns.removeSession(id)
        }
        return
      }
      if (payload?.type === "message.part.updated" && event.directory) {
        const part = payload.properties?.part as Parameters<typeof toolFailed>[0] & {
          type?: string
          state: { status?: string }
        }
        if (part?.type !== "tool" || part.state?.status !== "error" || failed.get(part.id)) return
        failed.set(part.id, true)
        void Effect.runPromise(
          instances
            .provide({ directory: event.directory }, toolFailed(part))
            .pipe(Effect.catchCause((cause) => Effect.logError("hooks: a failed tool", { cause }))),
        )
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
