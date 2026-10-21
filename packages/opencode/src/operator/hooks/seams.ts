export * as OperatorHookSeams from "./seams"

import { Effect, Layer, Context } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { OperatorHooks } from "./hooks"
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

export class Service extends Context.Service<Service, {}>()("@opencode/OperatorHookSeams") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* OperatorHooks.Service
    // A recorded run is announced for the live views.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorHookRuns.announce.ran = (run) =>
          GlobalBus.emit("event", { payload: { type: OperatorHookRuns.RAN, properties: run } })
      }),
      () => Effect.sync(() => void delete OperatorHookRuns.announce.ran),
    )
    // A deleted session's runs go with it.
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: Record<string, unknown> } | undefined
      if (payload?.type !== "session.deleted") return
      const id = (payload.properties?.info as { id?: string } | undefined)?.id ?? payload.properties?.sessionID
      if (typeof id === "string" && id) void OperatorHookRuns.removeSession(id)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )
    return Service.of({})
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [OperatorHooks.node] })
