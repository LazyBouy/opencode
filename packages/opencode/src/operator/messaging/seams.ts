export * as OperatorMessagingSeams from "./seams"

import { Context, Effect, Layer, type Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { OperatorAgentSessions } from "../agent-sessions"

// Every tie between messaging and OpenCode's sessions (SPEC-0023 §12, "Keeping the V2 port cheap"), in this one
// module, so moving to upstream's V2 replaces it and nothing else. The lanes, the message log, the queue's
// delivery, the inbox and its rules never import session code. Here they meet OpenCode:
//
//   finding a message's session        Session.get, the agent's main / active session   (V2: the session API)
//   whether a session is running       SessionStatus (in memory, never the database)     (V2: session.status)
//   delivering, and steering           SessionPrompt.prompt: a running session reads it  (V2: the per-session
//                                      at its next step                                    prompt queue, steer)
//   a turn's end                       GlobalBus session.idle / session.status idle       (V2: event.subscribe)

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
  /** Gives the session the message: it starts the next turn, or a running session reads it at its next step. */
  readonly prompt: (destination: Destination, agent: string, text: string) => Effect.Effect<void, unknown>
  /** A session of this project, by id: its folder. */
  readonly session: (id: string) => Effect.Effect<Destination | undefined>
  /** The agent's default target for messages that name no session. */
  readonly defaultTarget: (agent: string) => Effect.Effect<"main" | "active", OperatorAgentSessions.NotFoundError>
  /** Calls `listener` with each session whose turn ended (it went idle), for as long as the scope lasts. */
  readonly onIdle: (listener: (sessionID: string) => void) => Effect.Effect<void, never, Scope.Scope>
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

    const prompt = (target: Destination, agent: string, text: string) =>
      instances
        .provide(
          { directory: target.directory },
          prompts.prompt({ sessionID: SessionID.make(target.id), agent, parts: [{ type: "text", text }] }),
        )
        .pipe(Effect.asVoid)

    const session = Effect.fn("OperatorMessagingSeams.session")(function* (id: string) {
      const found = yield* sessions.get(SessionID.make(id)).pipe(Effect.orElseSucceed(() => undefined))
      return found ? ({ id: found.id, directory: found.directory } satisfies Destination) : undefined
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

    return Service.of({ destination, running, prompt, session, defaultTarget, onIdle })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [InstanceStore.node, Session.node, SessionStatus.node, SessionPrompt.node, OperatorAgentSessions.node],
})
