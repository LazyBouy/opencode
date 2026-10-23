export * as OperatorMessagingSeams from "./seams"

import { tool, type Plugin } from "@opencode-ai/plugin"
import { Cause, Context, Effect, Exit, Fiber, Layer, type Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { OperatorAgentSessions } from "../agent-sessions"
import { OperatorPermissionEffective } from "../permission-effective"
import { OperatorProjectRecords } from "../project-records"
import { OperatorProjects } from "../projects"
import type { OperatorPing } from "./ping"
import { OperatorPingVerbs } from "./verbs"

// Every tie between messaging and OpenCode's sessions (SPEC-0023 §12, "Keeping the V2 port cheap"), in this one
// module, so moving to upstream's V2 replaces it and nothing else. The lanes, the message log, the queue's
// delivery, the inbox and its rules never import session code. Here they meet OpenCode:
//
//   finding a message's session        Session.get, the agent's main / active session   (V2: the session API)
//   whether a session is running       SessionStatus (in memory, never the database)     (V2: session.status)
//   delivering, and steering           SessionPrompt.prompt: a running session reads it  (V2: the per-session
//                                      at its next step                                    prompt queue, steer)
//   a turn's end                       GlobalBus session.idle / session.status idle       (V2: event.subscribe)
//   the project's agents               Agent.list                                         (V2: the agent API)
//   the `ping` tool                    the fork's built-in plugin's `tool` (plugins.ts),  (V2: a tool transform)
//                                      its permission asks (ctx.ask), its offer
//   waiting for a reply                the tool call awaits; ctx.abort ends it            (V2: the session API's wait)

/** Where a message goes: a session, in its project's folder. */
export type Destination = { id: string; directory: string }

export interface Interface {
  /**
   * The session a message for the agent goes to: the one it names, else the agent's active or main session. With
   * `make`, an agent without a main session gets one; without, none is a string saying so.
   */
  readonly destination: (
    input: { agent: string; target: "session" | "main" | "active"; sessionID?: string },
    make: boolean,
  ) => Effect.Effect<Destination | string>
  /** Whether the session is running a turn now. */
  readonly running: (destination: Destination) => Effect.Effect<boolean>
  /**
   * Gives the session the message: it starts the next turn, or a running session reads it at its next step. The
   * part carries `metadata` (the chat views' marker).
   */
  readonly prompt: (
    destination: Destination,
    agent: string,
    text: string,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<void, unknown>
  /** A session, by id: its folder, and the agent it runs as (a subagent's session has a parent). */
  readonly session: (id: string) => Effect.Effect<(Destination & { agent?: string; parentID?: string }) | undefined>
  /** The agent's default target for messages that name no session. */
  readonly defaultTarget: (agent: string) => Effect.Effect<"main" | "active", OperatorAgentSessions.NotFoundError>
  /** Calls `listener` with each session whose turn ended (it went idle), for as long as the scope lasts. */
  readonly onIdle: (listener: (sessionID: string) => void) => Effect.Effect<void, never, Scope.Scope>
  /** The agents of the project's config. */
  readonly agents: () => Effect.Effect<
    ReadonlyArray<{ name: string; description?: string; mode: "subagent" | "primary" | "all"; hidden?: boolean }>
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorMessagingSeams") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const prompts = yield* SessionPrompt.Service
    const agentSessions = yield* OperatorAgentSessions.Service
    const agentList = yield* Agent.Service

    const destination = Effect.fn("OperatorMessagingSeams.destination")(function* (
      input: { agent: string; target: "session" | "main" | "active"; sessionID?: string },
      make: boolean,
    ) {
      if (input.target === "session") {
        const found = yield* sessions
          .get(SessionID.make(input.sessionID ?? ""))
          .pipe(Effect.orElseSucceed(() => undefined))
        if (!found) return `No session ${input.sessionID}`
        return { id: found.id, directory: found.directory } satisfies Destination
      }
      const state = yield* agentSessions.state(input.agent).pipe(Effect.orElseSucceed(() => undefined))
      if (input.target === "active" && state?.active)
        return { id: state.active.id, directory: state.active.directory } satisfies Destination
      if (!make) {
        const main = state?.main
        return main
          ? ({ id: main.id, directory: main.directory } satisfies Destination)
          : `${input.agent} has no session yet`
      }
      return yield* agentSessions.ensureMain(input.agent).pipe(
        Effect.map(({ session }): Destination | string => ({ id: session.id, directory: session.directory })),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
    })

    const running = Effect.fn("OperatorMessagingSeams.running")(function* (target: Destination) {
      const current = yield* instances.provide({ directory: target.directory }, status.get(SessionID.make(target.id)))
      return current.type !== "idle"
    })

    const prompt = (target: Destination, agent: string, text: string, metadata?: Record<string, unknown>) =>
      instances
        .provide(
          { directory: target.directory },
          prompts.prompt({
            sessionID: SessionID.make(target.id),
            agent,
            parts: [{ type: "text", text, ...(metadata ? { metadata } : {}) }],
          }),
        )
        .pipe(Effect.asVoid)

    const session = Effect.fn("OperatorMessagingSeams.session")(function* (id: string) {
      const found = yield* sessions.get(SessionID.make(id)).pipe(Effect.orElseSucceed(() => undefined))
      return found
        ? {
            id: found.id,
            directory: found.directory,
            ...(found.agent ? { agent: found.agent } : {}),
            ...(found.parentID ? { parentID: found.parentID } : {}),
          }
        : undefined
    })

    const defaultTarget = (agent: string) => agentSessions.state(agent).pipe(Effect.map((state) => state.target))

    const onIdle = (listener: (sessionID: string) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onEvent = (event: GlobalEvent) => {
            const payload = event.payload as
              | { type?: string; properties?: { sessionID?: string; status?: { type?: string } } }
              | undefined
            const idle =
              payload?.type === "session.idle" ||
              (payload?.type === "session.status" && payload.properties?.status?.type === "idle")
            const id = payload?.properties?.sessionID
            if (idle && typeof id === "string") listener(id)
          }
          GlobalBus.on("event", onEvent)
          return onEvent
        }),
        (onEvent) => Effect.sync(() => GlobalBus.off("event", onEvent)),
      ).pipe(Effect.asVoid)

    const agents = () =>
      agentList.list().pipe(
        Effect.map((all) =>
          all.map((agent) => ({
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
            mode: agent.mode,
            ...(agent.hidden ? { hidden: true } : {}),
          })),
        ),
        Effect.orElseSucceed(() => []),
      )

    // `ping` is offered (ADR-0005: opt-in) where some level has a `ping` line that isn't a deny; every namespace but
    // OpenCode's gets them by default (defaults.ts). Which verbs can be used is the lines' to say (ping.ts).
    const offered: OperatorPermissionEffective.Offer = (input) =>
      Effect.succeed(input.lines.some((line) => line.permission === "ping" && line.action !== "deny") ? ["ping"] : [])
    yield* Effect.acquireRelease(
      Effect.sync(() => OperatorPermissionEffective.offers.add(offered)),
      () => Effect.sync(() => OperatorPermissionEffective.offers.delete(offered)),
    )

    return Service.of({ destination, running, prompt, session, defaultTarget, onIdle, agents })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    InstanceStore.node,
    Session.node,
    SessionStatus.node,
    SessionPrompt.node,
    OperatorAgentSessions.node,
    Agent.node,
  ],
})

// The `ping` tool (SPEC-0023 §7), one of the fork's built-in plugins (operator/plugins.ts loads this one). The
// running servers' ping service (ping.ts) answers its calls, the newest (a test process builds several in turn).
type Serve = (call: OperatorPing.Call) => Effect.Effect<OperatorPing.Result, unknown>
const serving: Serve[] = []
/** The ping service answers the tool's calls while the scope lasts. */
export const servePing = (serve: Serve) =>
  Effect.acquireRelease(
    Effect.sync(() => serving.push(serve)),
    () =>
      Effect.sync(() => {
        const at = serving.lastIndexOf(serve)
        if (at >= 0) serving.splice(at, 1)
      }),
  ).pipe(Effect.asVoid)

const pingTool = (description: string, limits: typeof OperatorPing.LIMITS) => {
  const target = tool.schema.object({
    type: tool.schema.enum(["agent", "session", "group"]),
    id: tool.schema.string().describe("The agent's name, the session's id or the group's name"),
  })
  const match = tool.schema
    .object({
      fromProject: tool.schema
        .union([tool.schema.literal("this"), tool.schema.array(tool.schema.string())])
        .optional()
        .describe('"this", or projects\' ids; left out: any'),
      fromAgent: tool.schema.array(tool.schema.string()).optional(),
      recipient: tool.schema
        .object({
          type: tool.schema.enum(["agent", "group", "session", "none", "any"]),
          id: tool.schema.string().optional(),
        })
        .optional()
        .describe("The recipient it asks for (none: it names none; any: it names one)"),
      priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("At least this"),
      type: tool.schema.enum(["text", "file-location"]).optional(),
      contains: tool.schema.string().optional(),
      pattern: tool.schema.string().optional().describe("A regular expression the text matches"),
      correlationPrefix: tool.schema.string().optional(),
      reply: tool.schema.boolean().optional().describe("A reply to a message this project's agents sent"),
    })
    .describe("Every part given must hold")
  const action = tool.schema.object({
    kind: tool.schema.enum(["as-addressed", "forward", "manager", "dead-letter", "drop", "broadcast", "to-sender"]),
    to: tool.schema.array(target).optional().describe("forward: where to"),
    steer: tool.schema.boolean().optional(),
    priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Raise it to at least this"),
  })
  return tool({
    description,
    args: {
      verb: tool.schema
        .enum(["discover", "send", ...OperatorPingVerbs.MANAGER])
        .describe("discover: who you may message; send: a message; forward, drop, rule: the project's manager only"),
      target: tool.schema
        .object({
          type: tool.schema.enum(["agent", "session", "group", "project_inbox"]),
          id: tool.schema
            .string()
            .optional()
            .describe("The agent's name, the session's id or the group's name; blank: every agent, or every group"),
          session: tool.schema
            .string()
            .optional()
            .describe("With type agent: one of its sessions (default: its main or active session)"),
        })
        .optional()
        .describe("Who it's for (send; a reply's goes to the sender)"),
      message: tool.schema
        .object({
          type: tool.schema
            .enum(["text", "file-location"])
            .optional()
            .describe(
              "text (default), or file-location: body is a path, which the recipient reads if its permissions allow",
            ),
          body: tool.schema.string(),
        })
        .optional()
        .describe("The message (send)"),
      priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Default: normal"),
      steer: tool.schema
        .boolean()
        .optional()
        .describe("Read during a running turn, at its next step. Default: false (read when its turn ends)"),
      correlationID: tool.schema
        .string()
        .optional()
        .describe("Shared by a message and its replies; made up when left out"),
      replyTo: tool.schema.string().optional().describe("The id of the message this answers"),
      wait: tool.schema.boolean().optional().describe("Wait for the reply (same correlation id)"),
      timeout: tool.schema
        .number()
        .optional()
        .describe(`With wait: seconds (default: the server's, 120 unless changed; at most ${limits.waitMax})`),
      messageID: tool.schema.string().optional().describe("forward, drop: the Project inbox message"),
      to: tool.schema.array(target).optional().describe("forward: agents, sessions or groups of this project"),
      reason: tool.schema.string().optional().describe("drop: why (logged)"),
      rule: tool.schema
        .object({
          op: tool.schema.enum(["list", "add", "change", "on", "off", "remove"]),
          id: tool.schema.string().optional().describe("The rule (change, on, off, remove; add: optional)"),
          name: tool.schema.string().optional(),
          position: tool.schema.number().optional().describe("add: where in the list, 0 first (default: last)"),
          match,
          action,
        })
        .partial({ match: true, action: true })
        .optional()
        .describe("rule: the Project inbox's rules, in order; the first that matches a message decides"),
    },
    async execute(args, ctx) {
      // The request's project instance, taken before anything is awaited.
      const fiber = Fiber.getCurrent()
      const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
      const serve = serving.at(-1)
      if (!serve || !instance) throw new Error("Messaging is not available in this session")
      const exit = await Effect.runPromiseExit(
        serve({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          args,
          ask: (input) => ctx.ask({ permission: "ping", ...input }),
          abort: ctx.abort,
          progress: (title, card) => ctx.metadata({ title, metadata: { ping: card } }),
        }).pipe(Effect.provideService(InstanceRef, instance)),
      )
      // A rejected ask reaches the session loop as it is.
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      return { title: exit.value.title, output: exit.value.output, metadata: { ping: exit.value.card } }
    },
  })
}

// The manager's verbs and their fields are sent only to the project's manager (§8.3); anyone else's request gets
// the tool without them. The call refuses them anyway.
const MANAGER_FIELDS = ["messageID", "to", "reason", "rule"]
function withoutManagerVerbs(schema: unknown) {
  if (!schema || typeof schema !== "object") return schema
  const copy = structuredClone(schema) as {
    properties?: Record<string, { enum?: string[] } | undefined>
    required?: string[]
  }
  const verb = copy.properties?.verb
  if (verb?.enum) verb.enum = verb.enum.filter((name) => !OperatorPingVerbs.MANAGER.includes(name as never))
  for (const field of MANAGER_FIELDS) delete copy.properties?.[field]
  if (copy.required) copy.required = copy.required.filter((field) => !MANAGER_FIELDS.includes(field))
  return copy
}
const isManager = async (instance: { directory: string; worktree: string }, agent: string) =>
  (await OperatorProjectRecords.get(await OperatorProjects.keyOf(instance))).manager === agent

/** The fork's built-in plugin for messaging: the `ping` tool. */
export const plugin: Plugin = async () => {
  const { OperatorPing: Ping } = await import("./ping")
  return {
    tool: { ping: pingTool(Ping.DESCRIPTION, Ping.LIMITS) },
    "tool.definition": async (hook, output) => {
      if (hook.toolID !== "ping" || !hook.agent) return
      // The request's project instance, taken before anything is awaited.
      const fiber = Fiber.getCurrent()
      const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
      if (instance && (await isManager(instance, hook.agent).catch(() => false))) return
      const sent = output as { jsonSchema?: unknown }
      sent.jsonSchema = withoutManagerVerbs(sent.jsonSchema)
    },
  }
}
