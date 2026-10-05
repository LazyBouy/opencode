export * as OperatorGenerate from "./generate"

import { Context, Effect, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMEvent } from "@opencode-ai/llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { OperatorPromptText } from "./prompt-text"

// One model call made as one of the fork's helper agents (purpose-generator, dynamic-generator). They
// are not registered agents (that would put them in the config the server reports): like upstream's
// project-copy name call, the call carries the agent itself. The prompt plugin gives it the helper
// layer of the agent's helper profile, as for any helper agent. The small model of the default
// provider is used, else the default model.

export class GenerateError extends Schema.TaggedErrorClass<GenerateError>()("OperatorGenerateError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The helper agent's answer to `prompt`. Needs a project instance. */
  readonly text: (input: { agent: string; prompt: string; sessionID?: string }) => Effect.Effect<string, GenerateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorGenerate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service

    const run = Effect.fnUntraced(function* (input: { agent: string; prompt: string; sessionID?: string }) {
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
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
        )
      return result.trim()
    })
    const text = (input: { agent: string; prompt: string; sessionID?: string }) =>
      run(input).pipe(
        Effect.mapError(
          (cause) => new GenerateError({ message: cause instanceof Error ? cause.message : String(cause) }),
        ),
        Effect.withSpan("OperatorGenerate.text"),
      )

    return Service.of({ text })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [LLM.node, Provider.node, Agent.node] })
