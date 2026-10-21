export * as OperatorHookResolve from "./resolve"

import os from "os"
import path from "path"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { OperatorHookEvents } from "./events"

// Which hooks are in force for a project and agent (SPEC-0022 §6.3), from each level's declarations:
//
//   Global     the global config files' `hooks`, if the namespace inherits Global's capabilities
//   Namespace  the namespace folder's config file (for a project with a config of its own, only its locked
//              hooks: the unlocked ones were copied into the project's file)
//   Project    the project's config files
//   Agent      the agent's own `hooks`
//
// Every level's hooks run for an event, the highest level first and, within a level, in the order written.
// A lower level replaces a hook by declaring the same name, and turns an inherited one off with
// `capabilities.disabled.hooks` (an agent with `hooksDisabled`), unless the hook is locked: then the locked
// one keeps running and the conflict is reported. An entry that isn't valid is kept with its problems and
// never runs; it never stops the rest from loading.

export const LEVELS = ["global", "namespace", "project", "agent"] as const
export type Level = (typeof LEVELS)[number]

export type Source = {
  level: Level
  /** The file the entries are written in (an agent's file or config entry). */
  file: string
  /** The folder a relative `command` resolves against. */
  base: string
  hooks: Record<string, unknown>
  /** Inherited names this source turns off. */
  disabled: ReadonlyArray<string>
}

export type State = "on" | "off" | "disabled" | "invalid"

export type Hook = {
  name: string
  event: string
  /** The script's absolute path. */
  command: string
  /** As written. */
  script: string
  args: string[]
  match: string[]
  /** Seconds; absent: the server's default. */
  timeout?: number
  onFailure: "deny" | "allow"
  locked: boolean
  enabled: boolean
  description?: string
  level: Level
  file: string
  state: State
  /** off: the level that turned it off. */
  offAt?: Level
  /** The inherited hook this one replaces. */
  replaces?: { level: Level; file: string }
  problems: string[]
}

const MIN_TIMEOUT = 0.1
const MAX_TIMEOUT = 600

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** A script path as the runner starts it: `~` and relative paths made absolute. */
export function commandPath(command: string, base: string) {
  if (command === "~" || command.startsWith("~/")) return path.join(os.homedir(), command.slice(1))
  return path.isAbsolute(command) ? command : path.resolve(base, command)
}

/** One entry as written, checked (§6.1): what's wrong with it is listed, never thrown. */
export function entry(name: string, raw: unknown, source: Source): Hook {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const problems: string[] = []
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) problems.push("not an object")
  const event = typeof value.event === "string" ? value.event : ""
  if (!event) problems.push("no event")
  else if (!OperatorHookEvents.isName(event)) problems.push(`unknown event ${event}`)
  const script = typeof value.command === "string" ? value.command.trim() : ""
  if (!script) problems.push("no command")
  const match = strings(value.match)
  if (match.length && OperatorHookEvents.isName(event) && !OperatorHookEvents.of(event).subject)
    problems.push(`match doesn't apply to ${event}`)
  const timeout = typeof value.timeout === "number" ? value.timeout : undefined
  if (timeout !== undefined && !(timeout >= MIN_TIMEOUT && timeout <= MAX_TIMEOUT))
    problems.push(`timeout must be ${MIN_TIMEOUT} to ${MAX_TIMEOUT} seconds`)
  const onFailure = value.onFailure === undefined ? "deny" : value.onFailure
  if (onFailure !== "deny" && onFailure !== "allow") problems.push("onFailure must be deny or allow")
  const enabled = value.enabled !== false
  return {
    name,
    event,
    command: script ? commandPath(script, source.base) : "",
    script,
    args: strings(value.args),
    match,
    ...(timeout !== undefined && !problems.some((item) => item.startsWith("timeout")) ? { timeout } : {}),
    onFailure: onFailure === "allow" ? "allow" : "deny",
    locked: value.locked === true,
    enabled,
    ...(typeof value.description === "string" && value.description ? { description: value.description } : {}),
    level: source.level,
    file: source.file,
    state: problems.length ? "invalid" : enabled ? "on" : "disabled",
    problems,
  }
}

/** The hooks in force, in run order (levels highest first, then as written). */
export function resolve(sources: ReadonlyArray<Source>): Hook[] {
  const ordered = [...sources].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  const hooks: Hook[] = []
  const index = (name: string) => hooks.findIndex((hook) => hook.name === name)
  for (const source of ordered) {
    const level = LEVELS.indexOf(source.level)
    // Turning off what a higher level declared.
    for (const name of source.disabled) {
      const at = index(name)
      const found = at >= 0 ? hooks[at] : undefined
      if (!found || LEVELS.indexOf(found.level) >= level) continue
      if (found.locked) {
        found.problems.push(`locked at ${found.level}: ${source.level} can't turn it off (${source.file})`)
        continue
      }
      if (found.state === "on" || found.state === "disabled") {
        found.state = "off"
        found.offAt = source.level
      }
    }
    for (const [name, raw] of Object.entries(source.hooks)) {
      const next = entry(name, raw, source)
      const at = index(name)
      const found = at >= 0 ? hooks[at] : undefined
      if (!found) {
        hooks.push(next)
        continue
      }
      // The same level, a later file: the later one stands, in place.
      if (found.level === source.level) {
        hooks[at] = next
        continue
      }
      if (found.locked) {
        found.problems.push(`locked at ${found.level}: ${source.level} can't replace it (${source.file})`)
        continue
      }
      hooks.splice(at, 1)
      hooks.push({ ...next, replaces: { level: found.level, file: found.file } })
    }
  }
  return hooks
}

/** Whether a hook runs for this subject (a tool, permission or agent name); `*` matches anything. */
export function matches(hook: Pick<Hook, "match">, subject: string | undefined) {
  if (!hook.match.length) return true
  if (subject === undefined) return false
  return hook.match.some((pattern) => Wildcard.match(subject, pattern))
}

/** The hooks that run for one event and subject, in order. */
export function forEvent(hooks: ReadonlyArray<Hook>, event: OperatorHookEvents.Name, subject?: string) {
  return hooks.filter((hook) => hook.state === "on" && hook.event === event && matches(hook, subject))
}
