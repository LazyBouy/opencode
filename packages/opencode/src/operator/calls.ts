export * as OperatorCalls from "./calls"

import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorCallStore } from "./call-store"
import { OperatorProjects } from "./projects"
import { OperatorProviderTap } from "./provider-tap"
import { OperatorRegistry } from "./registry"

// Recorded model calls (provider-tap.ts, call-store.ts): registers each call the prompt plugin sees in
// `chat.headers`, linking it to its session, agent and the step's assistant message, and deletes a
// session's calls when the session is deleted for good.

// OpenCode's own side calls, by agent.
const SIDE = new Set(["title", "compaction", "summary"])

export interface Interface {
  /** Registers a call about to be sent; its id, or nothing when it is not recorded. */
  readonly begin: (input: {
    sessionID: string
    agent: string
    providerID: string
    modelID: string
    userMessageID?: string
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorCalls") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    // The last call of each assistant message: a later one for the same message is a retry.
    const lastCall = new Map<string, string>()

    const begin = Effect.fn("OperatorCalls.begin")(function* (input: {
      sessionID: string
      agent: string
      providerID: string
      modelID: string
      userMessageID?: string
    }) {
      const cfg = yield* config.get()
      const record = cfg.operatorRecordCalls !== false
      OperatorProviderTap.settings.unlinked = record
      const session = yield* sessions.get(SessionID.make(input.sessionID)).pipe(Effect.option)
      // Not recorded: recording is off, or a helper call with no real session.
      if (!record || Option.isNone(session))
        return OperatorProviderTap.register({ sessionID: input.sessionID, kind: "other", skip: true })
      const ctx = yield* InstanceState.context
      const projectKey = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const kind: OperatorCallStore.Kind = SIDE.has(input.agent)
        ? (input.agent as OperatorCallStore.Kind)
        : input.userMessageID
          ? "agent"
          : "other"
      // The step's assistant message exists when the request is prepared: the newest one of this agent,
      // not completed yet (answering the user message, for an agent step).
      const found =
        kind === "agent" || kind === "compaction"
          ? yield* sessions
              .findMessage(
                SessionID.make(input.sessionID),
                (message) =>
                  message.info.role === "assistant" &&
                  !message.info.time.completed &&
                  message.info.agent === input.agent &&
                  (kind === "compaction" || message.info.parentID === input.userMessageID),
              )
              .pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none()
      const assistantMessageID = Option.isSome(found) ? found.value.info.id : undefined
      const retryOf = assistantMessageID ? lastCall.get(assistantMessageID) : undefined
      const callID = OperatorProviderTap.register({
        sessionID: input.sessionID,
        kind,
        agent: input.agent,
        projectKey,
        directory: ctx.directory,
        ...(input.userMessageID ? { userMessageID: input.userMessageID } : {}),
        ...(assistantMessageID ? { assistantMessageID } : {}),
        ...(retryOf ? { retryOf } : {}),
        model: `${input.providerID}/${input.modelID}`,
        providerID: input.providerID,
      })
      if (assistantMessageID) lastCall.set(assistantMessageID, callID)
      return callID
    })

    const register: NonNullable<typeof OperatorRegistry.calls.begin> = (input) =>
      Effect.runPromise(
        begin(input).pipe(
          Effect.provideService(InstanceRef, input.instance as InstanceContext),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      )
    OperatorRegistry.calls.begin = register
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (OperatorRegistry.calls.begin === register) OperatorRegistry.calls.begin = undefined
      }),
    )

    // A session deleted for good takes its recorded calls with it.
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: { sessionID?: string } } | undefined
      if (payload?.type !== "session.deleted" || !payload.properties?.sessionID) return
      void OperatorCallStore.remove(payload.properties.sessionID).catch(() => undefined)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    return Service.of({ begin })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, Config.node] })
