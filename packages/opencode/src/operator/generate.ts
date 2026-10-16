export * as OperatorGenerate from "./generate"

import { Context, Effect, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMEvent } from "@opencode-ai/llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { OperatorPromptText } from "./prompt-text"
import { OperatorRegistry } from "./registry"

// One model call made as one of the fork's helper agents (purpose-generator, dynamic-generator). They
// are not registered agents (that would put them in the config the server reports): like upstream's
// project-copy name call, the call carries the agent itself. The prompt plugin gives it the helper
// layer of the agent's helper profile, as for any helper agent. The small model of the default
// provider is used, else the default model.

export class GenerateError extends Schema.TaggedErrorClass<GenerateError>()("OperatorGenerateError", {
  message: Schema.String,
}) {}

// For Observability's helper runs: what the call is for (a Dynamic layer's text, a project purpose, ...) and the
// session that started it, when that isn't the call's own session.
export type Input = { agent: string; prompt: string; sessionID?: string; purpose?: string; startedFrom?: string }

export interface Interface {
  /** The helper agent's answer to `prompt`. Needs a project instance. */
  readonly text: (input: Input) => Effect.Effect<string, GenerateError>
  /** The same call, with what it cost (a helper's run without actions: helper-runs.ts). */
  readonly call: (
    input: Input,
  ) => Effect.Effect<{ text: string; cost: number; tokens: { input: number; output: number } }, GenerateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorGenerate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service

    const run = Effect.fnUntraced(function* (input: Input, used: { model?: string; provider?: string }) {
      // An agent of that name in the config (with its own model, say) is used; else the helper itself.
      const agent: Agent.Info = (yield* agents.get(input.agent)) ?? {
        name: input.agent,
        mode: "primary",
        permission: [],
        options: {},
        native: true,
        prompt: OperatorPromptText.BUILTINS.find((item) => item.id === `helper.${input.agent}`)?.text ?? "",
      }
      const fallback = yield* provider.defaultModel()
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : ((yield* provider.getSmallModel(fallback.providerID)) ??
          (yield* provider.getModel(fallback.providerID, fallback.modelID)))
      used.model = model.id
      used.provider = model.providerID
      const sessionID = input.sessionID ? SessionID.make(input.sessionID) : SessionID.descending()
      const result = yield* llm
        .stream({
          agent,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: input.prompt }],
        })
        .pipe(
          Stream.runFold(
            () => ({ text: "", cost: 0, tokens: { input: 0, output: 0 } }),
            (total, event) => {
              if (LLMEvent.is.textDelta(event)) return { ...total, text: total.text + event.text }
              if (!LLMEvent.is.stepFinish(event) || !event.usage) return total
              const usage = Session.getUsage({ model, usage: event.usage, metadata: event.providerMetadata })
              return {
                ...total,
                cost: total.cost + usage.cost,
                tokens: {
                  input: total.tokens.input + usage.tokens.input,
                  output: total.tokens.output + usage.tokens.output,
                },
              }
            },
          ),
        )
      return { ...result, text: result.text.trim() }
    })
    // Every run is a helper run for Observability (observability_spec.md §5.2): helper calls have no session of
    // their own to be recorded in, so the run reports its totals.
    const report = (run: Record<string, unknown>) =>
      Effect.sync(() => {
        try {
          OperatorRegistry.telemetry.helper?.(run)
        } catch {
          // never reaches the run
        }
      })
    const call = (input: Input) =>
      Effect.suspend(() => {
        const startedAt = Date.now()
        const used: { model?: string; provider?: string } = {}
        const base = {
          id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          helper: input.agent,
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...((input.sessionID ?? input.startedFrom) ? { sessionID: input.sessionID ?? input.startedFrom } : {}),
          startedAt,
        }
        return run(input, used).pipe(
          Effect.mapError(
            (cause) => new GenerateError({ message: cause instanceof Error ? cause.message : String(cause) }),
          ),
          Effect.tap((result) =>
            report({ ...base, ...used, endedAt: Date.now(), ok: true, tokens: result.tokens, cost: result.cost }),
          ),
          Effect.tapError((error) =>
            report({ ...base, ...used, endedAt: Date.now(), ok: false, error: error.message }),
          ),
          Effect.withSpan("OperatorGenerate.call"),
        )
      })
    const text = (input: Input) => call(input).pipe(Effect.map((result) => result.text))

    return Service.of({ text, call })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [LLM.node, Provider.node, Agent.node] })
