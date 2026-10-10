export * as OperatorResolutions from "./resolutions"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import type { OperatorResolver } from "./resolver"

// Each session's resolved Dynamic layers (dynamic_layer_resolution_spec.md §5), kept with the session's
// operator data in `<data>/operator/resolutions/<session>.json`. A layer is resolved at the session's first
// call and again only when its signature changes (a source's text or stamp, a config value, a registry's
// list, the model, the agent, a live value); until then the stored text is reused byte for byte, so the
// prompt cache holds, and nothing slow (a helper writing a text) runs again. A deleted session's file goes.

export type Entry = {
  readonly signature: string
  readonly text: string
  readonly trace: OperatorResolver.Trace
  readonly at: number
}
type Stored = Record<string, Entry>

/** A short, stable fingerprint of what a layer's resolution depends on. */
export function signatureOf(value: unknown) {
  return Bun.hash(JSON.stringify(value)).toString(36)
}

export const folder = () => path.join(Global.Path.data, "operator", "resolutions")
const file = (sessionID: string) => path.join(folder(), `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)

// Kept in memory too; writes to one session's file happen one at a time.
const memory = new Map<string, Stored>()
const queues = new Map<string, Promise<unknown>>()
const queued = <T>(sessionID: string, work: () => Promise<T>) => {
  const next = (queues.get(sessionID) ?? Promise.resolve()).then(work, work)
  queues.set(
    sessionID,
    next.catch(() => undefined),
  )
  return next
}

async function load(sessionID: string): Promise<Stored> {
  const found = memory.get(sessionID)
  if (found) return found
  const stored = (await Bun.file(file(sessionID))
    .json()
    .catch(() => ({}))) as Stored
  if (memory.size > 500) memory.clear()
  memory.set(sessionID, stored)
  return stored
}

/** The session's stored resolution of a layer, if any. */
export async function get(sessionID: string, layer: string) {
  return (await load(sessionID))[layer]
}

/** Every layer the session has resolved, for its traces. */
export async function all(sessionID: string) {
  return { ...(await load(sessionID)) }
}

/**
 * The layer's text for the session: the stored one while `signature` is the same, else what `compute`
 * resolves (stored for the next call). Without a session, it is computed each time.
 */
export async function reuse(
  sessionID: string | undefined,
  layer: string,
  signature: string,
  compute: () => Promise<{ text: string; trace: OperatorResolver.Trace }>,
): Promise<Entry & { reused: boolean }> {
  if (!sessionID) return { ...(await compute()), signature, at: Date.now(), reused: false }
  const found = await get(sessionID, layer)
  if (found && found.signature === signature) return { ...found, reused: true }
  const entry: Entry = { ...(await compute()), signature, at: Date.now() }
  await queued(sessionID, async () => {
    const stored = { ...(await load(sessionID)), [layer]: entry }
    memory.set(sessionID, stored)
    await fs.mkdir(folder(), { recursive: true })
    await Bun.write(file(sessionID), JSON.stringify(stored))
  })
  return { ...entry, reused: false }
}

/** Forgets a session's resolutions (it was deleted). */
export function forget(sessionID: string) {
  memory.delete(sessionID)
  return queued(sessionID, () => fs.rm(file(sessionID), { force: true }))
}

export interface Interface {
  readonly forget: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorResolutions") {}

// A session deleted for good takes its resolutions with it.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: { sessionID?: string } } | undefined
      if (payload?.type !== "session.deleted" || !payload.properties?.sessionID) return
      void forget(payload.properties.sessionID).catch(() => undefined)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )
    return Service.of({ forget: (sessionID) => Effect.promise(() => forget(sessionID)).pipe(Effect.asVoid) })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
