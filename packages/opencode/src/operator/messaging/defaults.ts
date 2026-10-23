export * as OperatorPingDefaults from "./defaults"

import { OperatorLayout } from "../layout"
import { OperatorMemoryDefaults } from "../memory-defaults"

// The `ping` permission's default lines (SPEC-0023 §7.3, §8.3, decision 9): namespace-level lines, written into
// each namespace's config where the user sees, changes and locks them; never into OpenCode's (`ping` is opt-in there,
// ADR-0005) or Global's (which the OpenCode namespace inherits). Run once for the namespaces there already are, and
// for each one created after. Lines the user already has are never changed.
//
// `SEND(*)` (the `*` target, every other project) is denied; as a pattern it matches every send, so it's written
// first: a more specific line wins over it (permission-model.ts), and so does a later one where only order decides.
// The own project's agents, groups and inbox are allowed, another project's inbox asks; the manager's verbs (§8.3).

export const NAMESPACE = {
  "SEND(*)": "deny",
  "DISCOVER(agent/*)": "allow",
  "DISCOVER(group/*)": "allow",
  "DISCOVER(inbox)": "allow",
  "DISCOVER(project/*)": "allow",
  "SEND(agent/*)": "allow",
  "SEND(group/*)": "allow",
  "SEND(inbox)": "allow",
  "SEND(project/*)": "ask",
  "FORWARD(*)": "allow",
  "DROP(*)": "allow",
  "RULE(*)": "ask",
} as const

/** A namespace's `ping` lines, in its folder's config. Not for OpenCode or Global. */
export async function forNamespace(id: string) {
  const layout = await OperatorLayout.snapshot()
  const place = OperatorLayout.placeOf(id, layout)
  if (!place || place.global || place.id === OperatorLayout.OPENCODE) return false
  return OperatorMemoryDefaults.addLines(
    await OperatorMemoryDefaults.existing(place.configDir, OperatorMemoryDefaults.CONFIGS),
    "ping",
    NAMESPACE,
  )
}

/**
 * Writes the lines once into every namespace there is (a flag in the namespaces' settings records it, so lines the
 * user deletes don't come back). Off in OpenCode's test runs unless OPENCODE_PING_DEFAULTS=on.
 */
export async function ensure(env: NodeJS.ProcessEnv = process.env) {
  const wanted = env.OPENCODE_PING_DEFAULTS ?? (env.OPENCODE_TEST_HOME ? "off" : "on")
  if (wanted !== "on") return false
  const settings = await OperatorLayout.readSettings()
  if (settings.pingDefaults) return false
  const layout = await OperatorLayout.snapshot()
  for (const place of layout.places) await forNamespace(place.id).catch(() => false)
  await OperatorLayout.writeSettings({ ...(await OperatorLayout.readSettings()), pingDefaults: true })
  return true
}
