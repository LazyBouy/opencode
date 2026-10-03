import { Config } from "@/config/config"
import type { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import type { OperatorConfig } from "@/operator/config"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { markInstanceForDisposal } from "@/server/routes/instance/httpapi/lifecycle"
import { Effect } from "effect"

// After a write at a scope, reload what reads it: every project for global config (it feeds all of
// them), or this project for project config. The project reloads after the response is sent.
export const reloadAfterWrite = Effect.fnUntraced(function* (
  scope: OperatorConfig.Scope,
  config: Config.Interface,
  bridge: EffectBridge.Shape,
) {
  if (scope === "global") {
    yield* config.invalidate()
    bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
    return
  }
  yield* markInstanceForDisposal(yield* InstanceState.context)
})
