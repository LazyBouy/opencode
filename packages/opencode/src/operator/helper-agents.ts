export * as OperatorHelperAgents from "./helper-agents"

import fs from "fs"
import { OperatorHelperFiles } from "./helper-files"

// The agent a helper runs as (agent_types_spec.md §4.7): `helper:<namespace>:<name>`. OpenCode's Agent.get asks
// for it through OperatorRegistry.helpers.agent (one fork line in agent/agent.ts), so a helper never joins
// OpenCode's agent list, `GET /config` or any agent list. A run registers its agent here (helper-runs.ts); a name
// asked for later (a run's session opened after a restart) gets a plain one from the helper's file. The run
// sessions and what each may do are kept here for the permission hook (permission-live.ts), and each helper's
// profile for the prompt plugin. Kept free of service imports.

export const PREFIX = "helper:"

export const agentName = (namespace: string, name: string) => `${PREFIX}${namespace}:${name}`

export const isHelper = (agent: string | undefined) => !!agent?.startsWith(PREFIX)

export function parse(agent: string | undefined): { namespace: string; name: string } | undefined {
  if (!agent || !isHelper(agent)) return undefined
  const rest = agent.slice(PREFIX.length)
  const at = rest.indexOf(":")
  if (at <= 0 || at === rest.length - 1) return undefined
  return { namespace: rest.slice(0, at), name: rest.slice(at + 1) }
}

// The helper's file, read at once (Agent.get and the plugin's lookups are synchronous).
function stored(agent: string): OperatorHelperFiles.Stored | undefined {
  const found = parse(agent)
  if (!found) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(OperatorHelperFiles.file(found.namespace, found.name), "utf8"))
    return value && typeof value === "object" ? (value as OperatorHelperFiles.Stored) : undefined
  } catch {
    return undefined
  }
}

const registered = new Map<string, { info: Record<string, unknown>; profile: string }>()

/** A run's agent: its prompt, model, steps and permissions (an Agent.Info). */
export function register(agent: string, entry: { info: Record<string, unknown>; profile: string }) {
  registered.set(agent, entry)
}

/** The agent OpenCode's Agent.get gets for a helper's name. */
export function agent(name: string): unknown {
  const found = registered.get(name)
  if (found) return found.info
  const file = stored(name)
  if (!file) return undefined
  return {
    name,
    ...(file.description ? { description: file.description } : {}),
    mode: "subagent",
    hidden: true,
    native: false,
    permission: [],
    options: {},
    steps: file.steps,
  }
}

/** The helper profile a helper's agent uses (its text), for the prompt plugin. */
export function profileOf(agent: string | undefined): string | undefined {
  if (!agent || !isHelper(agent)) return undefined
  return registered.get(agent)?.profile ?? stored(agent)?.profile
}

const runs = new Map<string, { agent: string; actions: ReadonlyArray<string> }>()

/** A run's session: what it may do (its declared actions; everything else is denied). */
export function startRun(sessionID: string, entry: { agent: string; actions: ReadonlyArray<string> }) {
  runs.set(sessionID, entry)
}

export function endRun(sessionID: string) {
  runs.delete(sessionID)
}

/**
 * A helper run's declared actions, by its session (or, for a run's session after a restart, its agent's file);
 * undefined for any other session.
 */
export function runOf(sessionID: string | undefined, agent: string | undefined): ReadonlyArray<string> | undefined {
  const found = sessionID ? runs.get(sessionID) : undefined
  if (found) return found.actions
  if (!isHelper(agent)) return undefined
  return stored(agent!)?.actions ?? []
}
