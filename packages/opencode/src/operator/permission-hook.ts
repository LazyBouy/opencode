export * as OperatorPermissionHook from "./permission-hook"

import { Effect } from "effect"

// Where upstream's permission code hands rules to the fork (the two fork lines in permission/index.ts
// and session/prompt.ts): rules "Always allow" added to a session, and a client's tool switches merged
// into a session's rules. The fork's session permissions service registers the handlers: it saves Always
// allow rules with the session and records where each rule came from. Without a handler (or if it fails)
// nothing happens; the request goes on either way.

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

export const handlers: {
  always?: (input: { sessionID: string; rules: ReadonlyArray<Rule> }) => Effect.Effect<void>
  switched?: (input: { sessionID: string; rules: ReadonlyArray<Rule> }) => Effect.Effect<void>
} = {}

// The list an "Always" approval is kept in: the session's own (upstream kept one list for every session
// of the project). A session's list starts again when its rules are replaced in the fork's editor, so
// an approval removed there stops applying at once.
const generations = new Map<string, number>()
export const key = (sessionID: string) => `${sessionID}#${generations.get(sessionID) ?? 0}`
export function reset(sessionID: string) {
  generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1)
}

// "Always" was answered: the request's always patterns, allowed for that session.
export const always = (sessionID: string, rules: ReadonlyArray<Rule>) =>
  Effect.suspend(() => handlers.always?.({ sessionID, rules }) ?? Effect.void).pipe(
    Effect.catchCause(() => Effect.void),
  )

// A message's tool switches, merged into the session's rules.
export const switched = (sessionID: string, rules: ReadonlyArray<Rule>) =>
  Effect.suspend(() => handlers.switched?.({ sessionID, rules }) ?? Effect.void).pipe(
    Effect.catchCause(() => Effect.void),
  )
