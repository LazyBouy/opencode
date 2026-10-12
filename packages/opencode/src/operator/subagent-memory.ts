export * as OperatorSubagentMemory from "./subagent-memory"

// A subagent's Flavor (agent_types_spec.md §3): Incognito (the default) reads namespace and project memory, has
// no agent memory and stores nothing; Retentive is like a usual agent. Stored as the fork agent key
// `subagentMemory`. A session runs incognito when it is a subagent's (it has a parent: `task` started it) and the
// agent isn't retentive; an agent chatted with directly (no parent) never is. Such a session gets the locked
// `memory` deny lines below (permission-live.ts), and its Agent memory layer resolves to nothing (memory-service).

export type Flavor = "incognito" | "retentive"

export const flavorOf = (agent: { subagentMemory?: unknown } | undefined): Flavor =>
  agent?.subagentMemory === "retentive" ? "retentive" : "incognito"

export const incognito = (
  session: { parentID?: string } | undefined,
  agent: { subagentMemory?: unknown } | undefined,
) => !!session?.parentID && flavorOf(agent) === "incognito"

/** The memory an incognito session may not touch: its own agent memory, and any write or forget. */
export const LINES = [
  { permission: "memory", pattern: "READ(agent/*)", action: "deny" },
  { permission: "memory", pattern: "WRITE(*)", action: "deny" },
  { permission: "memory", pattern: "FORGET(*)", action: "deny" },
] as const
