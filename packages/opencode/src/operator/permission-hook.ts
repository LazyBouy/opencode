export * as OperatorPermissionHook from "./permission-hook"

import { Effect } from "effect"

// Where upstream's permission code hands rules to the fork (the fork lines in permission/index.ts and
// session/prompt.ts): rules "Always allow" added to a session, a client's tool switches merged into a
// session's rules, the rules every ask also checks, last (permission-live.ts: one exact rule per
// input, as the fork's permission levels decide it), and the answer a permission.asked hook gives a request
// that would ask the user (hooks/seams.ts, SPEC-0022 §8.4). The fork's services register the handlers. Without a
// handler (or if it fails) nothing happens; the request goes on either way.

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

/** A request about to ask the user, as upstream's ask has it. */
export type Request = {
  id?: string
  sessionID: string
  permission: string
  patterns: ReadonlyArray<string>
  metadata: Record<string, unknown>
  always: ReadonlyArray<string>
  tool?: { messageID: string; callID: string }
}
/** Allowed once (the user isn't asked), or rejected with feedback for the model. */
export type Decision = { allow: true } | { reject: string }

export const handlers: {
  always?: (input: { sessionID: string; rules: ReadonlyArray<Rule> }) => Effect.Effect<void>
  switched?: (input: { sessionID: string; rules: ReadonlyArray<Rule> }) => Effect.Effect<void>
  rules?: (input: {
    sessionID: string
    permission: string
    patterns: ReadonlyArray<string>
    given: ReadonlyArray<Rule>
  }) => Effect.Effect<ReadonlyArray<Rule>>
  decide?: (request: Request) => Effect.Effect<Decision | undefined>
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

// The rules an ask checks after its own (`given`) and the session's approvals (none without a handler).
export const rules = (
  request: { sessionID: string; permission: string; patterns: ReadonlyArray<string> },
  given: ReadonlyArray<Rule>,
) =>
  Effect.suspend(
    () =>
      handlers.rules?.({
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        given,
      }) ?? Effect.succeed<ReadonlyArray<Rule>>([]),
  ).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<Rule>>([])))

// Before a request asks the user, after every level, lock and approval left it at "ask": a hook's answer, if one
// gives it (none without a handler, or if it fails: the user is asked).
export const decide = (request: Request) =>
  Effect.suspend(() => handlers.decide?.(request) ?? Effect.succeed<Decision | undefined>(undefined)).pipe(
    Effect.catchCause(() => Effect.succeed<Decision | undefined>(undefined)),
  )
