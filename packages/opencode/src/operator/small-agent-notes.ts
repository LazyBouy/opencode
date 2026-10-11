export * as OperatorSmallAgentNotes from "./small-agent-notes"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

// The variant cleared from an agent on the small model when the small model changed to one without it
// (small-agents.ts), for the agent page to say so, by project and agent. Kept in the server's data folder.

const warningsFile = () => path.join(Global.Path.data, "operator", "small-agent-variants.json")

export type Cleared = { variant: string; model: string; at: number }

async function readWarnings(): Promise<Record<string, Record<string, Cleared>>> {
  return ((await Bun.file(warningsFile())
    .json()
    .catch(() => undefined)) ?? {}) as Record<string, Record<string, Cleared>>
}

/** The variant cleared from a small agent when its model changed, if one was. */
export async function clearedVariant(project: string, agent: string) {
  return (await readWarnings())[project]?.[agent]
}

/** A project's notes, by agent. */
export async function forProject(project: string) {
  return (await readWarnings())[project] ?? {}
}

/** The note about a cleared variant goes once the agent's model or variant is chosen again. */
export async function forget(project: string, agent: string) {
  if ((await readWarnings())[project]?.[agent]) await record(project, agent, undefined)
}

export async function record(project: string, agent: string, cleared: Cleared | undefined) {
  const all = await readWarnings()
  const next = { ...all, [project]: { ...all[project] } }
  if (cleared) next[project]![agent] = cleared
  else delete next[project]![agent]
  await fs.mkdir(path.dirname(warningsFile()), { recursive: true })
  await fs.writeFile(warningsFile(), JSON.stringify(next, null, 2) + "\n")
}
